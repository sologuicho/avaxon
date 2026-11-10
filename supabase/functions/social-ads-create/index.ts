import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders, json, resolveAdsCaller, getAdConnection } from '../_shared/socialAdsAuth.ts'
import {
  buildTargetingSpec, buildCreativeRef, createCampaign, createAdSet, createAdCreative, createAd,
  deleteNode, OPTIMIZATION_GOAL_FOR, AudienceSpec, AdsCredentials,
} from '../_shared/metaAds.ts'
import { validateBudget, validateSpecialAdCategory, validateDateRange, resolveEffectiveAudienceSpec } from './logic.ts'

// ── Paso 5 del wizard (confirmación) -> crea campaña/adset/creative/anuncio
//    EN PAUSED. Nunca activa nada por sí sola -- ver social-ads-activate.
//
// Idempotencia: el frontend genera un idempotency_key una sola vez al abrir
// el wizard y lo reenvía igual en reintentos/doble-click. Si ya existe una
// promoción con esa key, se regresa tal cual (sin volver a llamar a Meta).
// Si dos requests con la MISMA key llegan en una carrera real (ambas pasan
// el chequeo inicial al mismo tiempo), el unique(idempotency_key) de la
// tabla hace que una de las dos falle al insertar -- esa, en vez de dejar
// huérfanos, borra lo que acaba de crear en Meta y regresa la fila que sí
// ganó la carrera.
//
// Si falla cualquier paso de creación (campaña/adset/creative/anuncio), se
// borra en orden inverso lo ya creado en ESE intento antes de responder
// error -- nunca se deja un conjunto de anuncios huérfano sin registro.
//
// NO está desplegada a producción -- solo existe en el repo para revisión.

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const resolved = await resolveAdsCaller(req)
  if ('error' in resolved) return resolved.error
  const { ctx } = resolved

  let body: {
    post_target_id?: string
    idempotency_key?: string
    objective?: 'engagement' | 'whatsapp' | 'traffic' | 'awareness'
    audience_mode?: 'auto' | 'custom'
    audience_spec?: AudienceSpec
    saved_audience_id?: string
    budget_mode?: 'daily' | 'lifetime'
    budget_amount?: number
    start_time?: string
    end_time?: string | null
    placements?: 'auto' | 'facebook_page' | 'instagram_business'
    special_ad_categories?: string[]
  }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { post_target_id, idempotency_key, objective, budget_mode } = body
  if (!post_target_id || !idempotency_key || !objective || !budget_mode) {
    return json({ error: 'post_target_id, idempotency_key, objective y budget_mode son requeridos' }, 422)
  }
  if (!OPTIMIZATION_GOAL_FOR[objective]) return json({ error: 'objective inválido' }, 422)

  // ── Idempotencia: ¿ya existe? ──────────────────────────────────────────
  const { data: existing } = await ctx.adminClient
    .from('social_promotions').select('*').eq('idempotency_key', idempotency_key).maybeSingle()
  if (existing) {
    if (existing.organization_id !== ctx.organizationId) return json({ error: 'Forbidden' }, 403)
    return json({ ok: true, idempotent: true, promotion: existing })
  }

  // ── Validar que el post_target sea de esta org y ya esté publicado ────
  const { data: target } = await ctx.adminClient
    .from('social_post_targets')
    .select('id, organization_id, platform, status, external_post_id, social_account_id, social_accounts(external_id, facebook_page_id)')
    .eq('id', post_target_id).maybeSingle()
  if (!target || target.organization_id !== ctx.organizationId) return json({ error: 'Publicación no encontrada' }, 404)
  if (target.status !== 'publicado' || !target.external_post_id) {
    return json({ error: 'Solo se pueden promocionar publicaciones que ya estén publicadas.' }, 422)
  }

  const conn = await getAdConnection(ctx.adminClient, ctx.organizationId)
  if (!conn) return json({ error: 'Conecta tu cuenta publicitaria de Meta antes de promocionar.' }, 422)
  if (conn.status !== 'connected') return json({ error: `Tu cuenta publicitaria necesita atención (${conn.status}). Reconéctala desde Cuentas conectadas.` }, 422)

  // ── Validaciones de negocio (mismo mensaje claro que verá el cliente,
  //    antes de gastar una llamada a Meta) ──────────────────────────────
  const budgetAmount = Number(body.budget_amount)
  const budgetErr = validateBudget(budget_mode, budgetAmount, conn.currency)
  if (budgetErr) return json({ error: budgetErr }, 422)

  const startTime = body.start_time ?? new Date().toISOString()
  const dateErr = validateDateRange(startTime, body.end_time)
  if (dateErr) return json({ error: dateErr }, 422)

  let savedSpec: AudienceSpec | null = null
  if (body.saved_audience_id) {
    const { data: aud } = await ctx.adminClient
      .from('social_audiences').select('spec, organization_id').eq('id', body.saved_audience_id).maybeSingle()
    if (!aud || aud.organization_id !== ctx.organizationId) return json({ error: 'Público guardado no encontrado' }, 404)
    savedSpec = aud.spec
  }
  const audienceMode = body.audience_mode ?? 'auto'
  const effectiveSpec = resolveEffectiveAudienceSpec(savedSpec, body.audience_spec ?? null)

  const specialCategories = body.special_ad_categories?.filter(c => c && c !== 'NONE') ?? []
  const categoryErr = validateSpecialAdCategory(specialCategories, audienceMode, effectiveSpec)
  if (categoryErr) return json({ error: categoryErr }, 422)

  const placements = body.placements ?? 'auto'
  // Si el post solo se publicó en una red, no tiene sentido ofrecer la otra
  // como ubicación -- se fuerza a la red real del post.
  const effectivePlacements = placements === 'auto' ? target.platform : placements

  const targeting = buildTargetingSpec(audienceMode, effectiveSpec, effectivePlacements as any, 'MX', specialCategories)
  // La Page real de Meta: en un post de Facebook, la Page ES la cuenta
  // conectada (social_accounts.external_id) -- facebook_page_id ahí viene
  // NULL, esa columna solo se llena en la fila de Instagram, apuntando a su
  // Page vinculada. Necesario para destination_type=WHATSAPP/promoted_object
  // (objetivo "whatsapp") sin importar en qué red se publicó el post.
  const realFacebookPageId = target.platform === 'facebook_page'
    ? (target as any).social_accounts?.external_id ?? null
    : (target as any).social_accounts?.facebook_page_id ?? null
  const creativeRef = buildCreativeRef(
    target.platform as 'facebook_page' | 'instagram_business',
    target.external_post_id,
    (target as any).social_accounts?.facebook_page_id ?? null,
  )

  const creds: AdsCredentials = { adAccountId: conn.ad_account_id, accessToken: conn.accessToken }
  const budgetAmountCents = Math.round(budgetAmount * 100)

  const created: { campaignId?: string; adsetId?: string; creativeId?: string; adId?: string } = {}
  async function rollback() {
    if (created.adId) await deleteNode(creds, created.adId)
    if (created.creativeId) await deleteNode(creds, created.creativeId)
    if (created.adsetId) await deleteNode(creds, created.adsetId)
    if (created.campaignId) await deleteNode(creds, created.campaignId)
  }

  try {
    const campaign = await createCampaign(creds, {
      name: `Promoción ${post_target_id.slice(0, 8)}`, objective, specialAdCategories: specialCategories, status: 'PAUSED',
    })
    created.campaignId = campaign.id

    const adset = await createAdSet(creds, {
      name: `Conjunto ${post_target_id.slice(0, 8)}`, campaignId: campaign.id, objective,
      budgetMode: budget_mode, budgetAmountCents, targeting, startTime,
      endTime: body.end_time ?? undefined, status: 'PAUSED', facebookPageId: realFacebookPageId,
    })
    created.adsetId = adset.id

    const creative = await createAdCreative(creds, { name: `Creative ${post_target_id.slice(0, 8)}`, creativeRef })
    created.creativeId = creative.id

    const ad = await createAd(creds, { name: `Anuncio ${post_target_id.slice(0, 8)}`, adsetId: adset.id, creativeId: creative.id, status: 'PAUSED' })
    created.adId = ad.id
  } catch (e: any) {
    console.error('social-ads-create: fallo creando en Meta, haciendo rollback:', e)
    await rollback()
    return json({ error: e.message ?? 'No se pudo crear la promoción en Meta' }, 502)
  }

  const row = {
    organization_id: ctx.organizationId,
    post_target_id,
    idempotency_key,
    objective,
    audience_mode: audienceMode,
    audience_spec: effectiveSpec,
    saved_audience_id: body.saved_audience_id ?? null,
    budget_mode,
    budget_amount: budgetAmount,
    currency: conn.currency,
    start_time: startTime,
    end_time: body.end_time ?? null,
    placements: effectivePlacements,
    special_ad_categories: specialCategories,
    status: 'pausada', // ya existe en Meta, en PAUSED -- "activa" solo tras social-ads-activate
    meta_campaign_id: created.campaignId,
    meta_adset_id: created.adsetId,
    meta_ad_id: created.adId,
    meta_creative_id: created.creativeId,
    created_by: ctx.userId,
  }

  const { data: inserted, error: insertErr } = await ctx.adminClient.from('social_promotions').insert(row).select('*').single()

  if (insertErr || !inserted) {
    // Carrera real entre dos requests con la misma idempotency_key: la que
    // pierde el insert (23505 = unique_violation) borra lo que acaba de
    // crear en Meta y regresa la fila de la que sí ganó.
    if (insertErr?.code === '23505') {
      await rollback()
      const { data: winner } = await ctx.adminClient.from('social_promotions').select('*').eq('idempotency_key', idempotency_key).maybeSingle()
      if (winner) return json({ ok: true, idempotent: true, promotion: winner })
    }
    console.error('social-ads-create: fallo guardando social_promotions, haciendo rollback:', insertErr)
    await rollback()
    return json({ error: `Se creó en Meta pero no se pudo guardar: ${insertErr?.message}` }, 500)
  }

  await ctx.adminClient.from('social_promotion_audit').insert({
    promotion_id: inserted.id, organization_id: ctx.organizationId, action: 'crear', actor_id: ctx.userId,
    detail: { objective, budget_mode, budget_amount: budgetAmount, placements: effectivePlacements },
  })

  return json({ ok: true, promotion: inserted })
})
