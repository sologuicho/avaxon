// Pruebas unitarias de _shared/metaAds.ts -- corren con `deno test`, sin red
// y sin base de datos (META_ADS_MODE=mock se fuerza acá mismo).
// Cubren: construcción de targeting_spec, referencia al creative
// (object_story_id/source_instagram_media_id reusado tal cual), modo mock
// determinista, traducción de errores de Meta.

Deno.env.set('META_ADS_MODE', 'mock')

import { assert, assertEquals, assertNotEquals, assertThrows, assertRejects } from 'jsr:@std/assert@1'
import {
  buildTargetingSpec, buildCreativeRef, translateMetaError, minDailyBudget, getAdsMode,
  createCampaign, createAdSet, createAdCreative, createAd, getDeliveryEstimate, getInsights,
  searchTargeting, OBJECTIVE_TO_META, OPTIMIZATION_GOAL_FOR,
} from './metaAds.ts'

Deno.test('getAdsMode: sin definir truena con error claro, sin llamar a Meta', () => {
  Deno.env.delete('META_ADS_MODE')
  assertThrows(() => getAdsMode(), Error, 'META_ADS_MODE')
  Deno.env.set('META_ADS_MODE', 'mock') // restaurar para el resto de las pruebas
})

Deno.test('getAdsMode: valor inválido truena con error claro, sin llamar a Meta', () => {
  Deno.env.set('META_ADS_MODE', 'test')
  assertThrows(() => getAdsMode(), Error, 'META_ADS_MODE')
  Deno.env.set('META_ADS_MODE', 'mock')
})

Deno.test('getAdsMode: "live" es válido (no truena, aunque no haya red disponible en esta prueba)', () => {
  Deno.env.set('META_ADS_MODE', 'live')
  assertEquals(getAdsMode(), 'live')
  Deno.env.set('META_ADS_MODE', 'mock') // restaurar para el resto de las pruebas
})

Deno.test('buildTargetingSpec: modo automático solo trae país + edad adulta amplia', () => {
  const spec = buildTargetingSpec('auto', {}, 'auto', 'MX')
  assertEquals(spec.age_min, 18)
  assertEquals(spec.age_max, 65)
  assertEquals((spec.geo_locations as any).countries, ['MX'])
  assert(!('genders' in spec))
  assert(!('flexible_spec' in spec))
})

Deno.test('buildTargetingSpec: modo personalizado con radio geográfico', () => {
  const spec = buildTargetingSpec('custom', { geo: { type: 'radius', lat: 19.4, lng: -99.1, radius_km: 10 }, age_min: 25, age_max: 45, genders: ['female'] }, 'auto')
  const geo: any = spec.geo_locations
  assertEquals(geo.custom_locations[0].radius, 10)
  assertEquals(spec.age_min, 25)
  assertEquals(spec.age_max, 45)
  assertEquals((spec as any).genders, [2])
})

Deno.test('buildTargetingSpec: ubicaciones resueltas (locations) agrupan por tipo, no caen al país completo', () => {
  const spec = buildTargetingSpec('custom', {
    geo: { type: 'locations', locations: [
      { key: '2267', name: 'Reynosa', type: 'city' },
      { key: '3847', name: 'Tamaulipas', type: 'region' },
    ] },
  }, 'auto')
  const geo: any = spec.geo_locations
  assertEquals(geo.cities, [{ key: '2267' }])
  assertEquals(geo.regions, [{ key: '3847' }])
  assert(!('countries' in geo)) // ya no debe quedar en México entero
})

Deno.test('buildTargetingSpec: locations vacío cae de vuelta al país (nunca manda geo_locations roto)', () => {
  const spec = buildTargetingSpec('custom', { geo: { type: 'locations', locations: [], country: 'MX' } }, 'auto')
  assertEquals((spec.geo_locations as any).countries, ['MX'])
})

Deno.test('buildTargetingSpec: intereses solo se incluyen en modo personalizado', () => {
  const auto = buildTargetingSpec('auto', { interests: [{ id: '1', name: 'Comida' }] }, 'auto')
  assert(!('flexible_spec' in auto))
  const custom = buildTargetingSpec('custom', { interests: [{ id: '1', name: 'Comida' }] }, 'auto')
  assertEquals((custom as any).flexible_spec[0].interests[0].id, '1')
})

Deno.test('buildTargetingSpec: placements fijo agrega publisher_platforms', () => {
  const spec = buildTargetingSpec('auto', {}, 'instagram_business')
  assertEquals((spec as any).publisher_platforms, ['instagram'])
})

Deno.test('buildTargetingSpec: categoría HEC-F (empleo/vivienda/crédito) manda targeting_automation.advantage_audience=0 (requisito Marketing API v26.0)', () => {
  const withCategory = buildTargetingSpec('custom', { age_min: 18 }, 'auto', 'MX', ['HOUSING'])
  assertEquals((withCategory as any).targeting_automation, { advantage_audience: 0 })
  const withoutCategory = buildTargetingSpec('custom', { age_min: 18 }, 'auto', 'MX', [])
  assert(!('targeting_automation' in withoutCategory))
  const politicalOnly = buildTargetingSpec('custom', {}, 'auto', 'MX', ['ISSUES_ELECTIONS_POLITICS'])
  assert(!('targeting_automation' in politicalOnly)) // HEC-F es solo empleo/vivienda/crédito, no política
})

Deno.test('buildCreativeRef: Facebook reusa external_post_id tal cual como object_story_id', () => {
  const ref = buildCreativeRef('facebook_page', '123456_987654')
  assertEquals(ref, { object_story_id: '123456_987654' })
})

Deno.test('buildCreativeRef: Instagram usa source_instagram_media_id + page_id', () => {
  const ref = buildCreativeRef('instagram_business', '17895695668004550', '123456')
  assertEquals((ref as any).source_instagram_media_id, '17895695668004550')
  assertEquals((ref as any).page_id, '123456')
})

Deno.test('OBJECTIVE_TO_META y OPTIMIZATION_GOAL_FOR cubren los 4 objetivos del wizard', () => {
  for (const obj of ['engagement', 'whatsapp', 'traffic', 'awareness']) {
    assert(OBJECTIVE_TO_META[obj], `falta mapping de objetivo para ${obj}`)
    assert(OPTIMIZATION_GOAL_FOR[obj], `falta optimization_goal para ${obj}`)
  }
})

Deno.test('minDailyBudget: usa el piso configurado para MXN y no truena para otras monedas', () => {
  Deno.env.set('META_ADS_MIN_DAILY_BUDGET_MXN', '75')
  assertEquals(minDailyBudget('MXN'), 75)
  assertEquals(minDailyBudget('USD'), 75) // sin tabla de conversión -- mismo piso como salvaguarda
  Deno.env.delete('META_ADS_MIN_DAILY_BUDGET_MXN')
})

Deno.test('translateMetaError: token vencido (190) da mensaje claro de reconectar', () => {
  const msg = translateMetaError({ error: { code: 190, message: 'raw' } })
  assert(/reconec|expir/i.test(msg))
})

Deno.test('translateMetaError: rate limit (613) da mensaje claro de reintentar', () => {
  const msg = translateMetaError({ error: { code: 613, message: 'raw' } })
  assert(/límite|intenta/i.test(msg))
})

Deno.test('translateMetaError: fallback nunca expone el JSON crudo sin envolver', () => {
  const msg = translateMetaError({ error: { code: 999, message: 'algo raro pasó' } })
  assert(msg.includes('algo raro pasó'))
  assert(msg.startsWith('Meta rechazó la operación'))
})

const creds = { adAccountId: 'act_test123', accessToken: 'fake-token-mock' }

Deno.test('modo mock: createCampaign/createAdSet/createAdCreative/createAd devuelven ids con prefijo mock_ sin red', async () => {
  const campaign = await createCampaign(creds, { name: 'Promo test', objective: 'engagement', specialAdCategories: [] })
  assert(campaign.id.startsWith('mock_campaign_'))
  const adset = await createAdSet(creds, {
    name: 'Adset test', campaignId: campaign.id, objective: 'engagement',
    budgetMode: 'daily', budgetAmountCents: 5000, targeting: { age_min: 18 },
    startTime: new Date().toISOString(),
  })
  assert(adset.id.startsWith('mock_adset_'))
  const creative = await createAdCreative(creds, { name: 'Creative test', creativeRef: { object_story_id: '1_2' } })
  assert(creative.id.startsWith('mock_creative_'))
  const ad = await createAd(creds, { name: 'Ad test', adsetId: adset.id, creativeId: creative.id })
  assert(ad.id.startsWith('mock_ad_'))
})

Deno.test('modo mock: mismo input produce el mismo id de creative (determinista)', async () => {
  const a = await createAdCreative(creds, { name: 'x', creativeRef: { object_story_id: 'same_post' } })
  const b = await createAdCreative(creds, { name: 'x', creativeRef: { object_story_id: 'same_post' } })
  assertEquals(a.id, b.id)
  const c = await createAdCreative(creds, { name: 'x', creativeRef: { object_story_id: 'different_post' } })
  assertNotEquals(a.id, c.id)
})

Deno.test('modo mock: delivery_estimate regresa rango con lower < upper y reacciona al targeting', async () => {
  const est1 = await getDeliveryEstimate(creds, { optimizationGoal: 'REACH', targeting: { age_min: 18, age_max: 65 } })
  assert(est1.ready)
  assert(est1.lower > 0 && est1.lower < est1.upper)
  const est2 = await getDeliveryEstimate(creds, { optimizationGoal: 'REACH', targeting: { age_min: 25, age_max: 34 } })
  assertNotEquals(est1.lower, est2.lower) // público distinto -> estimado distinto
})

Deno.test('modo mock: gancho de prueba __E2E_MOCK_META_REJECT__ simula un rechazo real de Meta en createAdCreative', async () => {
  await assertRejects(
    () => createAdCreative(creds, { name: 'x', creativeRef: { object_story_id: 'page_post__E2E_MOCK_META_REJECT__' } }),
    Error,
    'Meta rechazó la operación',
  )
  // Sin el marcador, sigue funcionando normal (no rompe el resto del mock)
  const ok = await createAdCreative(creds, { name: 'x', creativeRef: { object_story_id: 'page_post_normal' } })
  assert(ok.id.startsWith('mock_creative_'))
})

Deno.test('modo mock: getInsights regresa métricas coherentes (cpc = spend/clicks, ctr en %)', async () => {
  const insights = await getInsights(creds, 'mock_ad_abc123')
  assert(insights.impressions > 0)
  assert(insights.clicks > 0)
  assert(insights.spend >= 0)
  const expectedCpc = Math.round((insights.spend / insights.clicks) * 100) / 100
  assertEquals(insights.cpc, expectedCpc)
})

Deno.test('modo mock: searchTargeting(adgeolocation) regresa ciudad+estado con el nombre buscado, sin red', async () => {
  const results = await searchTargeting(creds, 'adgeolocation', 'Reynosa')
  assert(results.length >= 1)
  assert(results.some(r => r.type === 'city' && r.name === 'Reynosa'))
  assert(results.every(r => r.key.startsWith('mock_')))
})

Deno.test('modo mock: searchTargeting(adinterest) regresa un id real-shaped (no fabricado a mano por el frontend)', async () => {
  const results = await searchTargeting(creds, 'adinterest', 'Restaurantes')
  assertEquals(results.length, 1)
  assertEquals(results[0].name, 'Restaurantes')
  assert(results[0].key.startsWith('mock_interest_'))
  assert(typeof results[0].audienceSizeLower === 'number')
})

Deno.test('searchTargeting: query vacía no llama a nada y regresa []', async () => {
  assertEquals(await searchTargeting(creds, 'adgeolocation', '   '), [])
})

Deno.test('modo mock: searchTargeting es determinista (mismo query -> mismo key)', async () => {
  const a = await searchTargeting(creds, 'adgeolocation', 'Monterrey')
  const b = await searchTargeting(creds, 'adgeolocation', 'Monterrey')
  assertEquals(a[0].key, b[0].key)
})
