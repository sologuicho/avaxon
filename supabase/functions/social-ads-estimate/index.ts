import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders, json, resolveAdsCaller, getAdConnection } from '../_shared/socialAdsAuth.ts'
import { buildTargetingSpec, getDeliveryEstimate, OPTIMIZATION_GOAL_FOR, translateMetaError, AudienceSpec } from '../_shared/metaAds.ts'

// ── Paso 2 del wizard: alcance estimado ─────────────────────────────────────
// Nunca se muestra como garantizado -- el frontend lo pinta como rango
// ("X – Y personas aprox.") y el propio delivery_estimate de Meta puede
// regresar estimate_ready=false si el público es demasiado angosto, lo que
// también se pasa tal cual al frontend para que avise.
//
// NO está desplegada a producción -- solo existe en el repo para revisión.

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const resolved = await resolveAdsCaller(req)
  if ('error' in resolved) return resolved.error
  const { ctx } = resolved

  let body: {
    objective?: string
    audience_mode?: 'auto' | 'custom'
    audience_spec?: AudienceSpec
    placements?: 'auto' | 'facebook_page' | 'instagram_business'
  }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const objective = body.objective
  if (!objective || !OPTIMIZATION_GOAL_FOR[objective]) return json({ error: 'objective inválido' }, 422)

  const conn = await getAdConnection(ctx.adminClient, ctx.organizationId)
  if (!conn) return json({ error: 'Conecta tu cuenta publicitaria de Meta antes de estimar el alcance.' }, 422)
  if (conn.status !== 'connected') return json({ error: `Tu cuenta publicitaria necesita atención (${conn.status}). Reconéctala desde Cuentas conectadas.` }, 422)

  const targeting = buildTargetingSpec(body.audience_mode ?? 'auto', body.audience_spec ?? {}, body.placements ?? 'auto')

  try {
    const estimate = await getDeliveryEstimate(
      { adAccountId: conn.ad_account_id, accessToken: conn.accessToken },
      { optimizationGoal: OPTIMIZATION_GOAL_FOR[objective], targeting },
    )
    return json({ ok: true, estimate_lower: estimate.lower, estimate_upper: estimate.upper, estimate_ready: estimate.ready })
  } catch (e: any) {
    return json({ error: e.message ?? translateMetaError(e) }, 502)
  }
})
