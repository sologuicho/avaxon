import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { decryptField } from '../_shared/crypto.ts'
import { getInsights } from '../_shared/metaAds.ts'

// ── Cron: sincroniza métricas + estado real de cada promoción activa ──────
// Corre cada N minutos (ver supabase/config.toml, igual patrón que
// social-post-scheduler/social-token-health-check: verify_jwt=false, no
// necesita JWT de usuario porque no actúa a nombre de nadie en particular).
//
// Por cada promoción en 'activa'|'en_revision'|'pausada' recientes (no
// 'finalizada'/'rechazada'/'error'/'borrador'):
//   1. Trae insights del día -> upsert en social_promotion_metrics.
//   2. Refresca los acumulados en social_promotions.
//   3. Si end_time ya pasó -> 'finalizada' (sin llamar a Meta, es una
//      consecuencia de fecha, no un estado que Meta reporte).
//
// NO está desplegada a producción -- solo existe en el repo para revisión.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (_req: Request) => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: promos, error } = await sb
    .from('social_promotions')
    .select('id, organization_id, meta_ad_id, status, end_time')
    .in('status', ['activa', 'en_revision', 'pausada'])
    .limit(200)

  if (error) {
    console.error('social-ads-metrics-sync: error leyendo social_promotions:', error)
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 })
  }

  let synced = 0, finalized = 0, failed = 0
  const today = new Date().toISOString().slice(0, 10)
  const connCache = new Map<string, { ad_account_id: string; accessToken: string } | null>()

  for (const promo of promos ?? []) {
    try {
      // Fecha de fin ya pasada -> finalizada, sin tocar Meta.
      if (promo.end_time && new Date(promo.end_time) < new Date()) {
        await sb.from('social_promotions').update({ status: 'finalizada', updated_at: new Date().toISOString() }).eq('id', promo.id)
        await sb.from('social_promotion_audit').insert({ promotion_id: promo.id, organization_id: promo.organization_id, action: 'finalizar', detail: {} })
        finalized++
        continue
      }
      if (!promo.meta_ad_id) continue

      if (!connCache.has(promo.organization_id)) {
        const { data: conn } = await sb.from('social_ad_connections').select('ad_account_id, access_token').eq('organization_id', promo.organization_id).maybeSingle()
        connCache.set(promo.organization_id, conn ? { ad_account_id: conn.ad_account_id, accessToken: await decryptField(conn.access_token) } : null)
      }
      const conn = connCache.get(promo.organization_id)
      if (!conn) continue

      const insights = await getInsights({ adAccountId: conn.ad_account_id, accessToken: conn.accessToken }, promo.meta_ad_id)

      await sb.from('social_promotion_metrics').upsert({
        promotion_id: promo.id, date: today,
        spend: insights.spend, reach: insights.reach, impressions: insights.impressions,
        clicks: insights.clicks, cpc: insights.cpc, ctr: insights.ctr, messages: insights.messages,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'promotion_id,date' })

      await sb.from('social_promotions').update({
        spend_total: insights.spend, reach_total: insights.reach, impressions_total: insights.impressions,
        clicks_total: insights.clicks, messages_total: insights.messages, updated_at: new Date().toISOString(),
      }).eq('id', promo.id)

      synced++
    } catch (e) {
      console.error(`social-ads-metrics-sync: fallo con promoción ${promo.id}:`, e)
      failed++
    }
  }

  return new Response(JSON.stringify({ ok: true, synced, finalized, failed, total: (promos ?? []).length }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
