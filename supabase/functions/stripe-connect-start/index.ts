import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { stripeFetch } from '../_shared/stripe.ts'
import { signState } from '../_shared/google.ts' // helper genérico de HMAC state, no es específico de Google

// ── Inicia Stripe Connect (cuentas Standard, cargos directos) ──────────────
// Crea la cuenta conectada Standard (o reusa la existente si ya se había
// creado antes pero no se terminó el onboarding) y genera un Account Link.
// El dashboard redirige al navegador a la url que devuelve esta función.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

const DASHBOARD_URL = 'https://avaxon.lat/dashboard/'
const CALLBACK_URL = 'https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/stripe-connect-callback'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')
  const OAUTH_STATE_SECRET = Deno.env.get('OAUTH_STATE_SECRET')

  if (!STRIPE_SECRET_KEY || !OAUTH_STATE_SECRET) {
    console.error('Faltan secrets: STRIPE_SECRET_KEY / OAUTH_STATE_SECRET')
    return json({ error: 'Stripe no está configurado' }, 500)
  }

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: { organization_id?: string }
  try { body = await req.json() } catch { body = {} }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient
    .from('profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .maybeSingle()

  const organizationId = body.organization_id || profile?.organization_id
  if (!organizationId) return json({ error: 'organization_id requerido' }, 422)
  if (profile?.role !== 'super_admin' && organizationId !== profile?.organization_id) {
    return json({ error: 'No autorizado para esta organización' }, 403)
  }

  try {
    const { data: integ } = await adminClient
      .from('integrations')
      .select('credentials')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe')
      .maybeSingle()

    let accountId = (integ?.credentials as { account_id?: string } | null)?.account_id

    if (!accountId) {
      const account = await stripeFetch('/accounts', STRIPE_SECRET_KEY, {
        body: {
          type: 'standard',
          country: 'MX',
          business_type: 'individual',
        },
      })
      accountId = account.id

      await adminClient.from('integrations').upsert({
        organization_id: organizationId,
        provider: 'stripe',
        status: 'pending',
        credentials: { account_id: accountId },
        config: { test_mode: STRIPE_SECRET_KEY.startsWith('sk_test_') },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'organization_id,provider' })
    }

    const state = await signState(organizationId, OAUTH_STATE_SECRET)
    const returnUrl = `${CALLBACK_URL}?state=${encodeURIComponent(state)}`
    const refreshUrl = `${DASHBOARD_URL}?conexion=stripe_retry`

    const accountLink = await stripeFetch('/account_links', STRIPE_SECRET_KEY, {
      body: {
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      },
    })

    return json({ ok: true, url: accountLink.url })
  } catch (e) {
    console.error('Error iniciando Stripe Connect:', e)
    return json({ error: e instanceof Error ? e.message : 'Error de Stripe' }, 502)
  }
})
