import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders, json, resolveAdsCaller, getAdConnection } from '../_shared/socialAdsAuth.ts'
import { searchTargeting, translateMetaError, getAdsMode, MetaAdsError } from '../_shared/metaAds.ts'

// ── Autocompletado de Ubicación/Intereses del wizard de Promocionar ────────
// Proxy fino sobre la Targeting Search de Meta (type=adgeolocation /
// adinterest) -- el token de la cuenta publicitaria nunca sale del backend,
// así que el frontend no puede llamar a graph.facebook.com directo.

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try { getAdsMode() } catch (e: any) { return json({ error: e.message }, 500) }

  const resolved = await resolveAdsCaller(req)
  if ('error' in resolved) return resolved.error
  const { ctx } = resolved

  let body: { type?: string; q?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const kind = body.type
  const q = (body.q ?? '').trim()
  if (kind !== 'adgeolocation' && kind !== 'adinterest') {
    return json({ error: 'type debe ser "adgeolocation" o "adinterest"' }, 422)
  }
  if (q.length < 2) return json({ ok: true, results: [] })

  const conn = await getAdConnection(ctx.adminClient, ctx.organizationId)
  if (!conn) return json({ error: 'No hay cuenta publicitaria conectada' }, 422)

  try {
    const results = await searchTargeting({ adAccountId: conn.ad_account_id, accessToken: conn.accessToken }, kind, q)
    return json({ ok: true, results })
  } catch (e) {
    const err = e as MetaAdsError
    return json({ error: err.message ?? translateMetaError(e) }, 502)
  }
})
