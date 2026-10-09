import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyStripeSignature } from '../_shared/stripe.ts'
import { sendZapierEvent } from '../_shared/zapier.ts'

// ── Webhook de Stripe (cuentas conectadas) ──────────────────────────────────
// --no-verify-jwt: Stripe llama sin JWT de Supabase: la autenticación real es
// la firma en el header Stripe-Signature, verificada contra
// STRIPE_WEBHOOK_SECRET sobre el body crudo (antes de cualquier parseo).
//
// checkout.session.completed → marca el payment como pagado, avisa al dueño
//   del negocio por WhatsApp (al número de Configuración → Contacto) y manda
//   payment_completed a Zapier.
// account.updated → releer charges_enabled y actualizar el status del card.

const corsHeaders = { 'Access-Control-Allow-Origin': '*' }
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

async function notifyBusinessOwner(
  sb: ReturnType<typeof createClient>,
  organizationId: string,
  waToken: string,
  text: string,
): Promise<void> {
  try {
    const { data: profile } = await sb
      .from('organization_profile')
      .select('whatsapp, phone')
      .eq('organization_id', organizationId)
      .maybeSingle()
    const toPhone = (profile?.whatsapp || profile?.phone || '').replace(/\D/g, '')
    if (!toPhone) return

    const { data: pn } = await sb
      .from('phone_numbers')
      .select('phone_number_id, whatsapp_accounts(access_token)')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()
    if (!pn?.phone_number_id) return

    const token = (pn.whatsapp_accounts as any)?.access_token || waToken
    await fetch(`https://graph.facebook.com/v20.0/${pn.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone, type: 'text', text: { body: text } }),
    })
  } catch (e) {
    console.error('No se pudo avisar al dueño del negocio:', e)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || ''
  const WA_TOKEN = Deno.env.get('WA_ACCESS_TOKEN') || ''

  if (!STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET no configurado')
    return json({ error: 'Webhook no configurado' }, 500)
  }

  const rawBody = await req.text()
  const sigHeader = req.headers.get('Stripe-Signature')
  const validSig = await verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET)
  if (!validSig) {
    console.error('Firma de Stripe inválida')
    return json({ error: 'Invalid signature' }, 400)
  }

  let event: any
  try { event = JSON.parse(rawBody) } catch { return json({ error: 'Invalid JSON' }, 400) }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const sessionId = session.id

      const { data: payment } = await sb
        .from('payments')
        .select('id, organization_id, concept, amount, contact_id')
        .eq('session_id', sessionId)
        .maybeSingle()

      if (payment) {
        await sb.from('payments').update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', payment.id)

        const amountFmt = Number(payment.amount).toLocaleString('es-MX', { minimumFractionDigits: 2 })
        await notifyBusinessOwner(
          sb, payment.organization_id, WA_TOKEN,
          `✅ *Pago recibido*\n\nConcepto: ${payment.concept}\nMonto: $${amountFmt} MXN`,
        )

        sendZapierEvent(sb, payment.organization_id, 'payment_completed', {
          payment_id: payment.id,
          concept: payment.concept,
          amount: payment.amount,
          contact_id: payment.contact_id,
        })
      } else {
        console.error('checkout.session.completed sin payment correspondiente:', sessionId)
      }
    }

    if (event.type === 'account.updated') {
      const account = event.data.object
      const accountId = account.id
      const chargesEnabled = !!account.charges_enabled

      const { data: integ } = await sb
        .from('integrations')
        .select('organization_id, status')
        .eq('provider', 'stripe')
        .eq('credentials->>account_id', accountId)
        .maybeSingle()

      if (integ) {
        const newStatus = chargesEnabled ? 'connected' : 'pending'
        if (integ.status !== 'disconnected') {
          await sb.from('integrations').update({
            status: newStatus,
            config: { email: account.email || null, charges_enabled: chargesEnabled, test_mode: STRIPE_SECRET_KEY.startsWith('sk_test_') },
            connected_at: chargesEnabled ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
          }).eq('organization_id', integ.organization_id).eq('provider', 'stripe')
        }
      }
    }

    return json({ ok: true })
  } catch (e) {
    console.error('Error procesando webhook de Stripe:', e)
    return json({ error: 'Error interno' }, 500)
  }
})
