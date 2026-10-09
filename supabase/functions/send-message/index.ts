import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN          = Deno.env.get('WA_ACCESS_TOKEN')!

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: { conversation_id: string; message?: string; payment_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { conversation_id, message, payment_id } = body
  if (!conversation_id?.trim() || (!message?.trim() && !payment_id?.trim())) {
    return json({ error: 'conversation_id y (message o payment_id) son requeridos' }, 422)
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Get conversation → contact phone + org phone_number_id + per-client token
  const { data: conv, error: convErr } = await adminClient
    .from('conversations')
    .select('id, organization_id, contact_id, phone_number_id, contacts(phone), phone_numbers(phone_number_id, whatsapp_accounts(access_token))')
    .eq('id', conversation_id)
    .single()

  if (convErr || !conv) return json({ error: 'Conversación no encontrada' }, 404)

  const toPhone      = (conv.contacts as any)?.phone
  const metaPhoneId  = (conv.phone_numbers as any)?.phone_number_id ?? conv.phone_number_id
  const clientToken  = (conv.phone_numbers as any)?.whatsapp_accounts?.access_token ?? WA_TOKEN

  if (!toPhone)     return json({ error: 'El contacto no tiene número de teléfono' }, 422)
  if (!metaPhoneId) return json({ error: 'No hay Phone Number ID configurado para esta org' }, 422)

  const toDigits = toPhone.replace(/\D/g, '')
  const sendWA = (payload: Record<string, unknown>) =>
    fetch(`https://graph.facebook.com/v20.0/${metaPhoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toDigits, ...payload }),
    })

  let waRes: Response
  let waData: any
  let savedContent: string

  if (payment_id) {
    // ── Link de pago: botón CTA URL (link corto, no el de Stripe pegado) ────
    const { data: payment } = await adminClient
      .from('payments')
      .select('id, organization_id, concept, amount, currency')
      .eq('id', payment_id)
      .maybeSingle()

    if (!payment || payment.organization_id !== conv.organization_id) {
      return json({ error: 'Payment no encontrado para esta organización' }, 404)
    }

    const amountFmt  = Number(payment.amount).toLocaleString('es-MX', { minimumFractionDigits: 2 })
    const currency   = (payment.currency || 'mxn').toUpperCase()
    const shortUrl   = `https://avaxon.lat/p/${payment.id}`
    const bodyText   = `Aquí tienes tu link de pago por *${payment.concept}* ($${amountFmt} ${currency}):`
    const displayText = `Pagar $${amountFmt}`.slice(0, 20) // límite de WhatsApp para display_text

    waRes = await sendWA({
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: bodyText },
        action: {
          name: 'cta_url',
          parameters: { display_text: displayText, url: shortUrl },
        },
      },
    })
    waData = await waRes.json()
    savedContent = `${bodyText}\n${shortUrl}\n[Botones: ${displayText}]`

    // Fuera de la ventana de 24h (131026) → reintentar con plantilla aprobada
    if (!waRes.ok && waData?.error?.code === 131026) {
      const { data: integ } = await adminClient
        .from('integrations')
        .select('config')
        .eq('organization_id', conv.organization_id)
        .eq('provider', 'whatsapp')
        .maybeSingle()

      const templateName = (integ?.config as any)?.payment_link_template_name
      if (!templateName) {
        return json({ error: 'El contacto está fuera de la ventana de 24h y no hay plantilla de link de pago configurada (integrations.config.payment_link_template_name)' }, 422)
      }

      waRes = await sendWA({
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'es_MX' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: payment.concept }, { type: 'text', text: amountFmt }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: payment.id }] },
          ],
        },
      })
      waData = await waRes.json()
      savedContent = `[Plantilla ${templateName}] ${bodyText}\n${shortUrl}`
    }
  } else {
    waRes = await sendWA({ type: 'text', text: { body: message!.trim() } })
    waData = await waRes.json()
    savedContent = message!.trim()
  }

  if (!waRes.ok) {
    return json({ error: `WhatsApp API error: ${waData.error?.message ?? JSON.stringify(waData)}` }, 502)
  }

  const waMessageId = waData.messages?.[0]?.id ?? null

  // Store message in DB
  const { error: insertErr } = await adminClient.from('messages').insert({
    conversation_id,
    organization_id: conv.organization_id,
    direction:       'outbound',
    content:         savedContent,
    media_type:      'text',
  })

  if (insertErr) {
    return json({ error: `Mensaje enviado pero falló el registro: ${insertErr.message}` }, 500)
  }

  // Update conversation last_message_at
  await adminClient.from('conversations')
    .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', conversation_id)

  return json({ ok: true, wa_message_id: waMessageId })
})
