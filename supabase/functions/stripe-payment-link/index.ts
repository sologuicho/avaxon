import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { stripeFetch } from '../_shared/stripe.ts'

// ── Crea un link de pago (Stripe Checkout) en la cuenta conectada ──────────
// Cargo directo: el header Stripe-Account hace que la cuenta conectada sea
// la que cobra (el dinero nunca pasa por la cuenta de plataforma de Avaxon).
// Sin comisión de plataforma por ahora — ver el bloque comentado para
// activarla después.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

// Cuando se active el fee de plataforma, ajustar este porcentaje y
// descomentar application_fee_amount en el payment_intent_data de abajo.
const PLATFORM_FEE_PCT = 0 // ej. 0.02 = 2%

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')
  if (!STRIPE_SECRET_KEY) return json({ error: 'Stripe no está configurado' }, 500)

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: { organization_id?: string; contact_id?: string; concept?: string; amount?: number }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

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

  const concept = body.concept?.trim()
  const amount = Number(body.amount)
  if (!concept) return json({ error: 'concept es requerido' }, 422)
  if (!amount || amount <= 0) return json({ error: 'amount debe ser mayor a 0' }, 422)

  const { data: integ } = await adminClient
    .from('integrations')
    .select('status, credentials')
    .eq('organization_id', organizationId)
    .eq('provider', 'stripe')
    .maybeSingle()

  const accountId = (integ?.credentials as { account_id?: string } | null)?.account_id
  if (integ?.status !== 'connected' || !accountId) {
    return json({ error: 'Stripe no está conectado para esta organización' }, 422)
  }

  try {
    const amountCents = Math.round(amount * 100)

    const session = await stripeFetch('/checkout/sessions', STRIPE_SECRET_KEY, {
      stripeAccount: accountId,
      body: {
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'mxn',
            product_data: { name: concept },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        success_url: 'https://avaxon.lat/dashboard/?pago=exitoso',
        cancel_url: 'https://avaxon.lat/dashboard/?pago=cancelado',
        // payment_intent_data: PLATFORM_FEE_PCT > 0 ? {
        //   application_fee_amount: Math.round(amountCents * PLATFORM_FEE_PCT),
        // } : undefined,
      },
    })

    const { data: payment, error: insErr } = await adminClient.from('payments').insert({
      organization_id: organizationId,
      contact_id: body.contact_id || null,
      amount,
      currency: 'mxn',
      concept,
      status: 'pending',
      checkout_url: session.url,
      session_id: session.id,
      stripe_account_id: accountId,
      created_by: user.id,
    }).select('id').single()

    if (insErr) {
      console.error('Error guardando payment:', insErr)
      return json({ error: 'Link creado pero no se pudo guardar: ' + insErr.message }, 500)
    }

    return json({ ok: true, url: session.url, payment_id: payment.id })
  } catch (e) {
    console.error('Error creando Checkout Session:', e)
    return json({ error: e instanceof Error ? e.message : 'Error de Stripe' }, 502)
  }
})
