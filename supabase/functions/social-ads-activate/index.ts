import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders, json, resolveAdsCaller, getAdConnection, getOwnedPromotion } from '../_shared/socialAdsAuth.ts'
import { updateNodeStatus } from '../_shared/metaAds.ts'

// ── Único camino para pasar una promoción de PAUSED a ACTIVE en Meta ───────
// social-ads-create SIEMPRE deja todo en PAUSED -- esta función solo corre
// después de que el usuario vio el resumen del paso 5 y confirmó de forma
// explícita (el frontend no permite llegar aquí sin ese clic).
//
// NO está desplegada a producción -- solo existe en el repo para revisión.

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const resolved = await resolveAdsCaller(req)
  if ('error' in resolved) return resolved.error
  const { ctx } = resolved

  let body: { promotion_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  if (!body.promotion_id) return json({ error: 'promotion_id es requerido' }, 422)

  const promo = await getOwnedPromotion(ctx.adminClient, ctx.organizationId, body.promotion_id)
  if (!promo) return json({ error: 'Promoción no encontrada' }, 404)
  if (promo.status !== 'pausada' && promo.status !== 'borrador') {
    return json({ error: `Esta promoción ya está en estado "${promo.status}", no se puede activar desde aquí.` }, 422)
  }
  if (!promo.meta_ad_id) return json({ error: 'Esta promoción todavía no se creó en Meta.' }, 422)

  const conn = await getAdConnection(ctx.adminClient, ctx.organizationId)
  if (!conn) return json({ error: 'Conecta tu cuenta publicitaria de Meta.' }, 422)

  try {
    await updateNodeStatus({ adAccountId: conn.ad_account_id, accessToken: conn.accessToken }, promo.meta_ad_id, 'ACTIVE')
  } catch (e: any) {
    return json({ error: e.message ?? 'No se pudo activar en Meta' }, 502)
  }

  // Al activar, Meta entra en revisión -- el estado real (aprobado/rechazado)
  // lo confirma social-ads-metrics-sync en su próxima corrida.
  const { data: updated } = await ctx.adminClient
    .from('social_promotions').update({ status: 'en_revision', updated_at: new Date().toISOString() })
    .eq('id', promo.id).select('*').single()

  await ctx.adminClient.from('social_promotion_audit').insert({
    promotion_id: promo.id, organization_id: ctx.organizationId, action: 'activar', actor_id: ctx.userId, detail: {},
  })

  return json({ ok: true, promotion: updated })
})
