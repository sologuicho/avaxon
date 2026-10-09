import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { stripeV2Fetch } from '../_shared/stripe.ts'
import { verifyState } from '../_shared/google.ts'

// ── Retorno del onboarding de Stripe Connect v2 ──────────────────────────────
// Stripe redirige aquí al navegador (sin JWT — --no-verify-jwt).
// Autorización real: state HMAC firmado por stripe-connect-start.
// Verifica card_payments.status === 'active' (equivalente v2 de charges_enabled).

const DASHBOARD_URL = 'https://avaxon.lat/dashboard/'

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } })
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const state = url.searchParams.get('state')

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')
  const OAUTH_STATE_SECRET = Deno.env.get('OAUTH_STATE_SECRET')

  if (!STRIPE_SECRET_KEY || !OAUTH_STATE_SECRET || !state) {
    return redirect(`${DASHBOARD_URL}?conexion=stripe_error`)
  }

  try {
    const verified = await verifyState(state, OAUTH_STATE_SECRET)
    if (!verified) return redirect(`${DASHBOARD_URL}?conexion=stripe_error`)
    const organizationId = verified.org

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: integ } = await sb
      .from('integrations')
      .select('credentials')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe')
      .maybeSingle()

    const accountId = (integ?.credentials as { account_id?: string } | null)?.account_id
    if (!accountId) return redirect(`${DASHBOARD_URL}?conexion=stripe_error`)

    // ── Verificar estado v2 ─────────────────────────────────────────────────
    const account = await stripeV2Fetch(`/v2/core/accounts/${accountId}`, STRIPE_SECRET_KEY, { method: 'GET' })
    const cardPaymentsStatus = account.configuration?.merchant?.capabilities?.card_payments?.status
    const chargesEnabled = cardPaymentsStatus === 'active'
    const status = chargesEnabled ? 'connected' : 'pending'

    await sb.from('integrations').update({
      status,
      config: {
        email: account.identity?.email || null,
        charges_enabled: chargesEnabled,
        card_payments_status: cardPaymentsStatus || null,
        test_mode: STRIPE_SECRET_KEY.startsWith('sk_test_'),
      },
      connected_at: chargesEnabled ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('organization_id', organizationId).eq('provider', 'stripe')

    return redirect(`${DASHBOARD_URL}?conexion=${chargesEnabled ? 'stripe_ok' : 'stripe_pending'}`)
  } catch (e) {
    console.error('Error en stripe-connect-callback:', e)
    return redirect(`${DASHBOARD_URL}?conexion=stripe_error`)
  }
})
