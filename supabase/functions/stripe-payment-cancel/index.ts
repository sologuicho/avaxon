import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { stripeFetch } from '../_shared/stripe.ts'

// ── Cancela un cobro pendiente ──────────────────────────────────────────────
// Expira el Checkout Session en Stripe (cargo directo, header Stripe-Account)
// y marca el payment como `cancelled`. Solo se puede cancelar un pending.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

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

  let body: { payment_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const paymentId = body.payment_id
  if (!paymentId) return json({ error: 'payment_id es requerido' }, 422)

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient
    .from('profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .maybeSingle()

  const { data: payment } = await adminClient
    .from('payments')
    .select('id, organization_id, status, session_id, stripe_account_id')
    .eq('id', paymentId)
    .maybeSingle()

  if (!payment) return json({ error: 'Cobro no encontrado' }, 404)
  if (profile?.role !== 'super_admin' && payment.organization_id !== profile?.organization_id) {
    return json({ error: 'No autorizado para esta organización' }, 403)
  }
  if (payment.status !== 'pending') {
    return json({ error: 'Solo se puede cancelar un cobro pendiente' }, 422)
  }
  if (!payment.session_id || !payment.stripe_account_id) {
    return json({ error: 'Este cobro no tiene un Checkout Session de Stripe asociado' }, 422)
  }

  let finalStatus = 'cancelled'

  try {
    await stripeFetch(`/checkout/sessions/${payment.session_id}/expire`, STRIPE_SECRET_KEY, {
      stripeAccount: payment.stripe_account_id,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)

    if (msg.includes('status of `expired`')) {
      finalStatus = 'expired'   // ya estaba expirada en Stripe, solo actualizamos la BD
    } else if (msg.includes('status of `complete`')) {
      return json({ error: 'Este cobro ya fue pagado, no se puede cancelar' }, 409)
    } else {
      console.error('Error expirando Checkout Session:', e)
      return json({ error: msg || 'Error de Stripe' }, 502)
    }
  }

  const { error: updErr } = await adminClient.from('payments').update({
    status: finalStatus,
    updated_at: new Date().toISOString(),
  }).eq('id', paymentId)

  if (updErr) return json({ error: `Cancelado en Stripe pero no se pudo actualizar: ${updErr.message}` }, 500)

  return json({ ok: true })
})
