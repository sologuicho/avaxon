// ── Cliente de Meta Marketing API + adaptador simulado ──────────────────────
// Documentación consultada (ver docs/promociones-meta.md §2): versión vigente
// confirmada el 2026-11-04, Marketing API v26.0 (publicada 29 jul 2026; v25.0
// también sigue activa hasta feb 2027) -- por eso la versión SIEMPRE se lee
// de META_MARKETING_API_VERSION, nunca hardcodeada aquí ni en otro archivo.
// Para "promocionar" un post ya publicado se usa object_story_id (Facebook,
// formato "<page_id>_<post_id>") o source_instagram_media_id (Instagram) en
// el creative -- NO se reconstruye el contenido.
//
// Cambio de v26.0 que SÍ afecta este código: para ad sets con categoría
// especial de Vivienda/Empleo/Crédito ("HEC-F") que no usan targeting amplio
// ("broad"), Meta exige mandar targeting_automation.advantage_audience (0/1)
// explícito en POST /{ad-account-id}/adsets o responde
// ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG. Como este proyecto
// permite segmentar por geo/género/idioma (no solo "broad") incluso para esas
// categorías -- ver validateSpecialAdCategory en social-ads-create/logic.ts,
// que solo bloquea edad<18 e intereses -- buildTargetingSpec manda ese campo
// en 0 (sin expansión automática) siempre que haya una categoría restringida,
// para no depender de cómo Meta defina "broad" internamente.
//
// META_ADS_MODE=mock activa el adaptador simulado: mismas formas de
// respuesta que la API real, ids/números deterministas (hash del input), sin
// red. Se usa porque no hay una cuenta publicitaria de pruebas de Meta
// disponible en este entorno -- ver docs/promociones-meta.md §7-8 para lo
// que queda pendiente de probar contra la API real.

export function getApiVersion(): string {
  return Deno.env.get('META_MARKETING_API_VERSION') || 'v26.0'
}

export type AdsMode = 'mock' | 'live'

// META_ADS_MODE es obligatoria: "mock" o "live", sin valor por defecto. Si
// falta o tiene otro valor, se corta aquí -- antes de tocar red, antes de
// cualquier rama mock -- para que nunca quede ambiguo en qué modo se está
// corriendo (ver instrucción de seguridad: nunca tokens/cuentas reales sin
// que alguien haya puesto "live" a propósito).
export function getAdsMode(): AdsMode {
  const raw = (Deno.env.get('META_ADS_MODE') ?? '').trim().toLowerCase()
  if (raw === 'mock' || raw === 'live') return raw
  throw new MetaAdsError(
    `META_ADS_MODE debe ser "mock" o "live" (valor actual: ${raw ? JSON.stringify(raw) : 'sin definir'}). No se realizó ninguna llamada a Meta.`,
  )
}

export function isMockMode(): boolean {
  return getAdsMode() === 'mock'
}

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${getApiVersion()}/${path}`
}

export class MetaAdsError extends Error {
  code?: string | number
  subcode?: string | number
  constructor(message: string, code?: string | number, subcode?: string | number) {
    super(message)
    this.code = code
    this.subcode = subcode
  }
}

// Traduce el error crudo de Meta (siempre {error:{message,code,error_subcode,...}})
// a un mensaje claro para el usuario final -- nunca se le muestra el JSON crudo.
export function translateMetaError(raw: any): string {
  const err = raw?.error ?? raw
  const code = err?.code
  const msg = err?.error_user_msg || err?.message || 'Error desconocido de Meta'
  if (code === 190) return 'La conexión con Meta expiró o fue revocada. Vuelve a conectar tu cuenta.'
  if (code === 17 || code === 613 || code === 80004) return 'Se alcanzó el límite de solicitudes de Meta. Intenta de nuevo en unos minutos.'
  if (code === 100 && /special_ad_categories|special ad/i.test(msg)) return 'Esta publicación requiere declarar una categoría especial de anuncios (empleo, vivienda, crédito o política) antes de promocionarse.'
  if (code === 2641) return 'La ubicación elegida no está disponible para anuncios en este momento.'
  return `Meta rechazó la operación: ${msg}`
}

// ── Mock helpers (deterministas: mismo input -> mismo output) ──────────────
async function mockHash(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function mockId(prefix: string, seed: string): Promise<string> {
  return `mock_${prefix}_${await mockHash(seed)}`
}

// ── Targeting spec ───────────────────────────────────────────────────────
export interface GeoLocationPick { key: string; name: string; type: 'country' | 'region' | 'city' | 'zip' }

export interface AudienceSpec {
  geo?: {
    type: 'radius' | 'locations'
    lat?: number; lng?: number; radius_km?: number
    locations?: GeoLocationPick[]
    country?: string
  }
  age_min?: number
  age_max?: number
  genders?: ('all' | 'male' | 'female')[]
  locales?: string[]
  interests?: { id: string; name: string }[]
}

const HEC_F_CATEGORIES = ['EMPLOYMENT', 'HOUSING', 'CREDIT']

// Agrupa los resultados ya resueltos de la Targeting Search (key real de
// Meta, no el nombre tecleado) en la forma que espera geo_locations --
// countries va como lista de códigos, el resto como [{key}]. Sin esto, un
// `type` desconocido se trata como ciudad (el caso más común).
function buildGeoLocationsFromPicks(picks: GeoLocationPick[]): Record<string, unknown> {
  const out: Record<string, { key: string }[]> = {}
  for (const p of picks) {
    const bucket = p.type === 'country' ? 'countries' : p.type === 'region' ? 'regions' : p.type === 'zip' ? 'zips' : 'cities'
    out[bucket] = out[bucket] || []
    out[bucket].push({ key: p.key })
  }
  if (out.countries) (out as any).countries = out.countries.map((c) => c.key)
  return out
}

export function buildTargetingSpec(
  audienceMode: 'auto' | 'custom',
  spec: AudienceSpec,
  placements: 'auto' | 'facebook_page' | 'instagram_business',
  country = 'MX',
  specialAdCategories: string[] = [],
) {
  // "Automático" = sin segmentación manual más allá de país + edad adulta
  // amplia -- Meta optimiza solo. Se avisa en el wizard que Meta puede
  // tratar parte de la segmentación personalizada como sugerencia, no como
  // filtro absoluto.
  const base: Record<string, unknown> = {
    geo_locations: audienceMode === 'custom' && spec.geo
      ? (spec.geo.type === 'radius' && spec.geo.lat != null && spec.geo.lng != null
          ? { custom_locations: [{ latitude: spec.geo.lat, longitude: spec.geo.lng, radius: spec.geo.radius_km ?? 16, distance_unit: 'kilometer' }] }
          : spec.geo.type === 'locations' && spec.geo.locations?.length
            ? buildGeoLocationsFromPicks(spec.geo.locations)
            : { countries: [spec.geo.country ?? country] })
      : { countries: [country] },
    age_min: audienceMode === 'custom' ? (spec.age_min ?? 18) : 18,
    age_max: audienceMode === 'custom' ? (spec.age_max ?? 65) : 65,
  }
  if (audienceMode === 'custom') {
    if (spec.genders && spec.genders.length && !spec.genders.includes('all')) {
      base.genders = spec.genders.map(g => (g === 'male' ? 1 : 2))
    }
    if (spec.locales?.length) base.locales = spec.locales
    if (spec.interests?.length) base.flexible_spec = [{ interests: spec.interests.map(i => ({ id: i.id, name: i.name })) }]
  }
  if (placements !== 'auto') {
    base.publisher_platforms = [placements === 'facebook_page' ? 'facebook' : 'instagram']
  }
  // Requisito de Marketing API v26.0 para ad sets de Vivienda/Empleo/Crédito
  // (ver comentario de cabecera) -- sin expansión automática de audiencia.
  if (specialAdCategories.some(c => HEC_F_CATEGORIES.includes(c))) {
    base.targeting_automation = { advantage_audience: 0 }
  }
  return base
}

// Referencia al post YA publicado -- nunca se reconstruye contenido nuevo.
export function buildCreativeRef(platform: 'facebook_page' | 'instagram_business', externalPostId: string, facebookPageId?: string | null) {
  if (platform === 'facebook_page') {
    // external_post_id ya viene como "pageid_postid" (ver socialPublish.ts:79) -- se usa tal cual.
    return { object_story_id: externalPostId }
  }
  // Instagram: external_post_id es el id de media tal cual (socialPublish.ts:166).
  return { source_instagram_media_id: externalPostId, page_id: facebookPageId ?? undefined }
}

export const OBJECTIVE_TO_META: Record<string, string> = {
  engagement: 'OUTCOME_ENGAGEMENT',
  whatsapp:   'OUTCOME_ENGAGEMENT', // Click-to-WhatsApp -- requiere Page con WhatsApp vinculado en Business Manager (prerrequisito manual, ver docs §8)
  traffic:    'OUTCOME_TRAFFIC',
  awareness:  'OUTCOME_AWARENESS',
}

// Suposición documentada, a confirmar con una cuenta real antes de producción
// (ver docs/promociones-meta.md §8) -- Meta permite varias combinaciones
// válidas por objetivo; estas son las más comunes/simples por objetivo.
export const OPTIMIZATION_GOAL_FOR: Record<string, string> = {
  engagement: 'POST_ENGAGEMENT',
  whatsapp:   'CONVERSATIONS',
  traffic:    'LINK_CLICKS',
  awareness:  'REACH',
}

export const BILLING_EVENT_FOR: Record<string, string> = {
  engagement: 'IMPRESSIONS',
  whatsapp:   'IMPRESSIONS',
  traffic:    'IMPRESSIONS',
  awareness:  'IMPRESSIONS',
}

// Piso de presupuesto diario configurable -- los mínimos reales de Meta
// varían por moneda/objetivo y cambian con el tiempo; este valor es un
// candado de seguridad propio, no una copia del mínimo real de Meta (que
// debe confirmarse contra la cuenta/documentación vigente antes de producción).
export function minDailyBudget(currency: string): number {
  const floor = Number(Deno.env.get('META_ADS_MIN_DAILY_BUDGET_MXN') ?? '50')
  if (currency === 'MXN') return floor
  // Sin tabla de conversión propia -- mismo piso numérico como salvaguarda
  // conservadora para otras monedas hasta tener datos reales de esa cuenta.
  return floor
}

export interface AdsCredentials {
  adAccountId: string // "act_<id>"
  accessToken: string
}

// Gancho de prueba SOLO para modo mock: deja simular un rechazo real de Meta
// en el paso de creative (después de que campaña+adset ya se crearon), para
// poder probar de verdad el rollback/limpieza en un E2E -- sin esto, el modo
// mock nunca falla y "rechazo de Meta"/"falla parcial" no se podían ejercitar
// con código real, solo leer el código y confiar en que funciona. Se activa
// únicamente si el object_story_id/source_instagram_media_id (que viene de
// social_post_targets.external_post_id, dato de prueba, nunca de producción)
// contiene este substring exacto -- no tiene ningún efecto en modo live.
const MOCK_FAIL_MARKER = '__E2E_MOCK_META_REJECT__'

function mockShouldSimulateRejection(creativeRef: Record<string, unknown>): boolean {
  return isMockMode() && JSON.stringify(creativeRef).includes(MOCK_FAIL_MARKER)
}

// ── Campañas / conjuntos / creatives / anuncios ─────────────────────────────

export async function createCampaign(
  creds: AdsCredentials,
  input: { name: string; objective: string; specialAdCategories: string[]; status?: 'PAUSED' | 'ACTIVE' },
): Promise<{ id: string }> {
  if (isMockMode()) return { id: await mockId('campaign', creds.adAccountId + input.name + Date.now()) }
  const res = await fetch(graphUrl(`${creds.adAccountId}/campaigns`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      objective: OBJECTIVE_TO_META[input.objective] ?? input.objective,
      special_ad_categories: input.specialAdCategories.length ? input.specialAdCategories : [],
      status: input.status ?? 'PAUSED',
      // El presupuesto siempre vive en el ad set (daily_budget/lifetime_budget
      // en createAdSet), nunca en la campaña -- sin esto Meta rechaza la
      // creación con "Debes indicar True o False en el campo
      // is_adset_budget_sharing_enabled si no estás usando el presupuesto de
      // la campaña" (encontrado en staging, 2026-11-10).
      is_adset_budget_sharing_enabled: false,
      access_token: creds.accessToken,
    }),
  })
  const data = await res.json()
  if (!res.ok || !data.id) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
  return { id: data.id }
}

export async function createAdSet(
  creds: AdsCredentials,
  input: {
    name: string; campaignId: string; objective: string
    budgetMode: 'daily' | 'lifetime'; budgetAmountCents: number
    targeting: Record<string, unknown>
    startTime: string; endTime?: string | null
    status?: 'PAUSED' | 'ACTIVE'
  },
): Promise<{ id: string }> {
  if (isMockMode()) return { id: await mockId('adset', input.campaignId + input.name) }
  const body: Record<string, unknown> = {
    name: input.name,
    campaign_id: input.campaignId,
    optimization_goal: OPTIMIZATION_GOAL_FOR[input.objective] ?? 'IMPRESSIONS',
    billing_event: BILLING_EVENT_FOR[input.objective] ?? 'IMPRESSIONS',
    targeting: input.targeting,
    start_time: input.startTime,
    status: input.status ?? 'PAUSED',
    access_token: creds.accessToken,
  }
  if (input.budgetMode === 'daily') body.daily_budget = input.budgetAmountCents
  else body.lifetime_budget = input.budgetAmountCents
  if (input.endTime) body.end_time = input.endTime
  const res = await fetch(graphUrl(`${creds.adAccountId}/adsets`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok || !data.id) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
  return { id: data.id }
}

export async function createAdCreative(
  creds: AdsCredentials,
  input: { name: string; creativeRef: Record<string, unknown> },
): Promise<{ id: string }> {
  if (isMockMode()) {
    if (mockShouldSimulateRejection(input.creativeRef)) {
      throw new MetaAdsError(translateMetaError({ error: { code: 100, message: 'Simulado para prueba E2E: Meta rechazó este creative' } }), 100)
    }
    return { id: await mockId('creative', JSON.stringify(input.creativeRef)) }
  }
  const res = await fetch(graphUrl(`${creds.adAccountId}/adcreatives`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name, ...input.creativeRef, access_token: creds.accessToken }),
  })
  const data = await res.json()
  if (!res.ok || !data.id) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
  return { id: data.id }
}

export async function createAd(
  creds: AdsCredentials,
  input: { name: string; adsetId: string; creativeId: string; status?: 'PAUSED' | 'ACTIVE' },
): Promise<{ id: string }> {
  if (isMockMode()) return { id: await mockId('ad', input.adsetId + input.creativeId) }
  const res = await fetch(graphUrl(`${creds.adAccountId}/ads`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      adset_id: input.adsetId,
      creative: { creative_id: input.creativeId },
      status: input.status ?? 'PAUSED',
      access_token: creds.accessToken,
    }),
  })
  const data = await res.json()
  if (!res.ok || !data.id) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
  return { id: data.id }
}

export async function updateNodeStatus(creds: AdsCredentials, nodeId: string, status: 'PAUSED' | 'ACTIVE'): Promise<void> {
  if (isMockMode()) return
  const res = await fetch(graphUrl(nodeId), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, access_token: creds.accessToken }),
  })
  const data = await res.json()
  if (!res.ok) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
}

export async function updateAdSetBudgetOrEnd(
  creds: AdsCredentials, adsetId: string,
  fields: { daily_budget?: number; lifetime_budget?: number; end_time?: string },
): Promise<void> {
  if (isMockMode()) return
  const res = await fetch(graphUrl(adsetId), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...fields, access_token: creds.accessToken }),
  })
  const data = await res.json()
  if (!res.ok) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
}

// Limpieza al fallar un paso -- borra lo ya creado en ese intento, en orden
// inverso, mejor esfuerzo (no re-lanza si un delete falla, solo loguea).
// Nunca re-lanza (es limpieza de mejor esfuerzo durante un rollback), pero
// SÍ debe notar cuando el borrado de verdad falló -- antes solo atrapaba
// excepciones de red; una respuesta de error de Meta (res.ok=false, ej.
// permiso insuficiente o nodo ya borrado por otra causa) se trataba como
// éxito silencioso, dejando el nodo huérfano en Meta sin ningún rastro en
// los logs (encontrado revisando un reporte de campaña huérfana, 2026-11-10
// -- en ese caso específico no hubo huérfano porque createCampaign nunca
// llegó a crear el objeto, pero este bug sí podía producir uno en otro
// escenario de fallo).
export async function deleteNode(creds: AdsCredentials, nodeId: string): Promise<void> {
  if (isMockMode()) return
  try {
    const res = await fetch(graphUrl(nodeId), {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: creds.accessToken }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      console.error(`metaAds.deleteNode: Meta rechazó el borrado de ${nodeId} durante limpieza (posible huérfano):`, JSON.stringify(data))
    }
  } catch (e) {
    console.error(`metaAds.deleteNode: no se pudo borrar ${nodeId} durante limpieza (posible huérfano):`, e)
  }
}

export async function getDeliveryEstimate(
  creds: AdsCredentials,
  input: { optimizationGoal: string; targeting: Record<string, unknown> },
): Promise<{ lower: number; upper: number; ready: boolean }> {
  if (isMockMode()) {
    // Estimado pseudo-determinista a partir del input, para que el wizard
    // tenga un rango que reacciona a cambios de público/radio sin depender
    // de la API real.
    const seed = await mockHash(JSON.stringify(input.targeting) + input.optimizationGoal)
    const n = parseInt(seed.slice(0, 6), 16)
    const base = 5000 + (n % 150000)
    return { lower: Math.round(base * 0.8), upper: Math.round(base * 1.25), ready: true }
  }
  const qs = new URLSearchParams({
    optimization_goal: input.optimizationGoal,
    targeting_spec: JSON.stringify(input.targeting),
    access_token: creds.accessToken,
  })
  const res = await fetch(graphUrl(`${creds.adAccountId}/delivery_estimate?${qs}`))
  const data = await res.json()
  if (!res.ok) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
  const node = data?.data?.[0]
  if (!node) return { lower: 0, upper: 0, ready: false }
  return { lower: node.estimate_mau_lower_bound ?? 0, upper: node.estimate_mau_upper_bound ?? 0, ready: !!node.estimate_ready }
}

export interface InsightsResult {
  spend: number; reach: number; impressions: number; clicks: number; cpc: number; ctr: number; messages: number
}

export async function getInsights(creds: AdsCredentials, adId: string): Promise<InsightsResult> {
  if (isMockMode()) {
    const seed = await mockHash(adId + new Date().toISOString().slice(0, 10))
    const n = parseInt(seed.slice(0, 6), 16)
    const impressions = 500 + (n % 20000)
    const clicks = Math.max(1, Math.round(impressions * (0.01 + (n % 50) / 1000)))
    const spend = Math.round((impressions / 1000) * (20 + (n % 30))) / 1 // ~$20-50 MXN CPM
    return {
      spend, reach: Math.round(impressions * 0.7), impressions, clicks,
      cpc: clicks ? Math.round((spend / clicks) * 100) / 100 : 0,
      ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0,
      messages: Math.round(clicks * 0.15),
    }
  }
  const fields = 'spend,reach,impressions,clicks,cpc,ctr,actions'
  const res = await fetch(graphUrl(`${adId}/insights?fields=${fields}&access_token=${creds.accessToken}`))
  const data = await res.json()
  if (!res.ok) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
  const row = data?.data?.[0]
  if (!row) return { spend: 0, reach: 0, impressions: 0, clicks: 0, cpc: 0, ctr: 0, messages: 0 }
  const messagesAction = (row.actions ?? []).find((a: any) => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')
  return {
    spend: Number(row.spend ?? 0), reach: Number(row.reach ?? 0), impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0), cpc: Number(row.cpc ?? 0), ctr: Number(row.ctr ?? 0),
    messages: Number(messagesAction?.value ?? 0),
  }
}

export async function listAdAccounts(userAccessToken: string): Promise<{ id: string; name: string; currency: string; account_status: number; funding_source_details?: unknown }[]> {
  if (isMockMode()) {
    return [{ id: 'act_1234567890', name: 'Cuenta publicitaria de prueba (mock)', currency: 'MXN', account_status: 1, funding_source_details: { id: 'mock_funding' } }]
  }
  const res = await fetch(graphUrl(`me/adaccounts?fields=id,name,currency,account_status,funding_source_details&access_token=${userAccessToken}`))
  const data = await res.json()
  if (!res.ok) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
  return data.data ?? []
}

// ── Targeting Search (autocompletado de Ubicación/Intereses del wizard) ────
// Sin esto el wizard no tenía forma de resolver "Reynosa" a una ubicación
// real de Meta -- el campo de Ubicación guardaba el texto tal cual y
// buildTargetingSpec no sabía qué hacer con él, así que el alcance estimado
// siempre caía al país completo (ver Promocionar paso 2, bug reportado
// 2026-11-09). Mismo problema con Intereses: se fabricaba un id falso a
// partir del nombre en vez de pedirle a Meta el id real de adinterest.
export interface TargetingSearchResult {
  key: string
  name: string
  type?: 'country' | 'region' | 'city' | 'zip' // solo viene en adgeolocation
  audienceSizeLower?: number
  audienceSizeUpper?: number
}

const GEO_TYPE_FROM_META: Record<string, GeoLocationPick['type']> = {
  country: 'country', region: 'region', city: 'city', zip: 'zip',
}

export async function searchTargeting(
  creds: AdsCredentials,
  kind: 'adgeolocation' | 'adinterest',
  query: string,
): Promise<TargetingSearchResult[]> {
  const q = query.trim()
  if (!q) return []
  if (isMockMode()) {
    const seed = await mockHash(kind + q)
    if (kind === 'adgeolocation') {
      return [
        { key: `mock_city_${seed}`, name: q, type: 'city' },
        { key: `mock_region_${seed}`, name: `${q} (estado, mock)`, type: 'region' },
      ]
    }
    const n = parseInt(seed.slice(0, 6), 16)
    return [{ key: `mock_interest_${seed}`, name: q, audienceSizeLower: 10000 + (n % 500000), audienceSizeUpper: 50000 + (n % 1000000) }]
  }
  const qs = new URLSearchParams({ type: kind, q, access_token: creds.accessToken })
  if (kind === 'adgeolocation') qs.set('location_types', JSON.stringify(['country', 'region', 'city', 'zip']))
  const res = await fetch(graphUrl(`search?${qs}`))
  const data = await res.json()
  if (!res.ok) throw new MetaAdsError(translateMetaError(data), data?.error?.code, data?.error?.error_subcode)
  const rows = (data.data ?? []) as any[]
  if (kind === 'adgeolocation') {
    return rows
      .filter((r) => GEO_TYPE_FROM_META[r.type])
      .map((r) => ({ key: r.key, name: r.name, type: GEO_TYPE_FROM_META[r.type] }))
  }
  return rows.map((r) => ({ key: r.id, name: r.name, audienceSizeLower: r.audience_size_lower, audienceSizeUpper: r.audience_size_upper }))
}
