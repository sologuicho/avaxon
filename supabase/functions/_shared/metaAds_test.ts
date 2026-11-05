// Pruebas unitarias de _shared/metaAds.ts -- corren con `deno test`, sin red
// y sin base de datos (META_ADS_MODE=mock se fuerza acá mismo).
// Cubren: construcción de targeting_spec, referencia al creative
// (object_story_id/source_instagram_media_id reusado tal cual), modo mock
// determinista, traducción de errores de Meta.

Deno.env.set('META_ADS_MODE', 'mock')

import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import {
  buildTargetingSpec, buildCreativeRef, translateMetaError, minDailyBudget,
  createCampaign, createAdSet, createAdCreative, createAd, getDeliveryEstimate, getInsights,
  OBJECTIVE_TO_META, OPTIMIZATION_GOAL_FOR,
} from './metaAds.ts'

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

Deno.test('modo mock: getInsights regresa métricas coherentes (cpc = spend/clicks, ctr en %)', async () => {
  const insights = await getInsights(creds, 'mock_ad_abc123')
  assert(insights.impressions > 0)
  assert(insights.clicks > 0)
  assert(insights.spend >= 0)
  const expectedCpc = Math.round((insights.spend / insights.clicks) * 100) / 100
  assertEquals(insights.cpc, expectedCpc)
})
