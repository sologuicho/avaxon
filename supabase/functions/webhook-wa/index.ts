import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Meta webhook receiver ────────────────────────────────────────────────────
// GET  → verificación de webhook
// POST → mensajes de texto e interactive (respuestas de botones)

Deno.serve(async (req: Request) => {
  const VERIFY_TOKEN = Deno.env.get('WEBHOOK_VERIFY_TOKEN')!
  const WA_TOKEN     = Deno.env.get('WA_ACCESS_TOKEN')!
  const OPENAI_KEY   = Deno.env.get('OPENAI_API_KEY')!
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // ── Verificación de webhook (GET) ──────────────────────────────────────────
  if (req.method === 'GET') {
    const url       = new URL(req.url)
    const mode      = url.searchParams.get('hub.mode')
    const token     = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 })
    }
    return new Response('Forbidden', { status: 403 })
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  let body: any
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }

  const entry  = body?.entry?.[0]
  const change = entry?.changes?.[0]
  const value  = change?.value
  if (!value?.messages?.length) return new Response('ok', { status: 200 })

  const msg     = value.messages[0]
  const meta    = value.metadata
  const contact = value.contacts?.[0]

  // Aceptar texto y respuestas de botones interactivos
  const isText   = msg.type === 'text'
  const isButton = msg.type === 'interactive' && msg.interactive?.type === 'button_reply'
  if (!isText && !isButton) return new Response('ok', { status: 200 })

  const phoneNumberId = meta?.phone_number_id
  const fromPhone     = msg.from
  const messageText   = isText
    ? (msg.text?.body ?? '')
    : (msg.interactive.button_reply.title ?? '')
  const contactName   = contact?.profile?.name ?? null
  const waMessageId   = msg.id

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  // ── 1. Resolver organización por phone_number_id ───────────────────────────
  const { data: pn } = await sb
    .from('phone_numbers')
    .select('id, organization_id')
    .eq('phone_number_id', phoneNumberId)
    .single()

  if (!pn) {
    console.error('phone_number_id no encontrado en BD:', phoneNumberId)
    return new Response('ok', { status: 200 })
  }

  const { organization_id } = pn

  // ── 2. Upsert contacto ─────────────────────────────────────────────────────
  const { data: contact_row } = await sb
    .from('contacts')
    .upsert(
      { organization_id, phone: fromPhone, name: contactName, last_seen_at: new Date().toISOString() },
      { onConflict: 'organization_id,phone' }
    )
    .select('id')
    .single()

  if (!contact_row) return new Response('ok', { status: 200 })

  // ── 3. Obtener o crear conversación abierta ────────────────────────────────
  let conversation_id: string
  const { data: existing } = await sb
    .from('conversations')
    .select('id')
    .eq('organization_id', organization_id)
    .eq('contact_id', contact_row.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) {
    conversation_id = existing.id
    await sb.from('conversations')
      .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', conversation_id)
  } else {
    const { data: newConv } = await sb
      .from('conversations')
      .insert({
        organization_id,
        contact_id:      contact_row.id,
        phone_number_id: pn.id,
        status:          'open',
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (!newConv) return new Response('ok', { status: 200 })
    conversation_id = newConv.id
  }

  // ── 4. Guardar mensaje entrante ────────────────────────────────────────────
  await sb.from('messages').insert({
    conversation_id,
    organization_id,
    direction:     'inbound',
    content:       messageText,
    media_type:    'text',
    wa_message_id: waMessageId,
  })

  // ── 5. Bot IA (solo si está habilitado para esta org) ──────────────────────
  const { data: botConfig } = await sb
    .from('bot_configs')
    .select('system_prompt, enabled')
    .eq('organization_id', organization_id)
    .eq('enabled', true)
    .maybeSingle()

  if (!botConfig) return new Response('ok', { status: 200 })

  const { data: history } = await sb
    .from('messages')
    .select('direction, content')
    .eq('conversation_id', conversation_id)
    .order('created_at', { ascending: false })
    .limit(10)

  const chatHistory = (history ?? []).reverse().map(m => ({
    role:    m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }))

  const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:           'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: botConfig.system_prompt },
        ...chatHistory,
      ],
      max_tokens:  400,
      temperature: 0.7,
    }),
  })

  const aiData   = await aiRes.json()
  const rawReply = aiData.choices?.[0]?.message?.content?.trim()
  if (!rawReply) return new Response('ok', { status: 200 })

  // Parsear JSON de GPT: { text: string, buttons?: string[] }
  let parsed: { text: string; buttons?: string[] }
  try {
    parsed = JSON.parse(rawReply)
  } catch {
    parsed = { text: rawReply }
  }

  const replyText    = parsed.text ?? rawReply
  const buttonLabels = (parsed.buttons ?? []).slice(0, 3)

  // ── 6. Construir y enviar mensaje WhatsApp ─────────────────────────────────
  let waPayload: any

  if (buttonLabels.length > 0) {
    waPayload = {
      messaging_product: 'whatsapp',
      to:   fromPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: replyText },
        action: {
          buttons: buttonLabels.map((label: string, i: number) => ({
            type:  'reply',
            reply: { id: `btn_${i}`, title: label.slice(0, 20) },
          })),
        },
      },
    }
  } else {
    waPayload = {
      messaging_product: 'whatsapp',
      to:   fromPhone,
      type: 'text',
      text: { body: replyText },
    }
  }

  const waRes  = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(waPayload),
  })
  const waData = await waRes.json()

  // ── 7. Guardar mensaje saliente ───────────────────────────────────────────
  const savedContent = buttonLabels.length > 0
    ? `${replyText}\n[Botones: ${buttonLabels.join(' | ')}]`
    : replyText

  await sb.from('messages').insert({
    conversation_id,
    organization_id,
    direction:     'outbound',
    content:       savedContent,
    media_type:    'text',
    wa_message_id: waData.messages?.[0]?.id ?? null,
  })

  return new Response('ok', { status: 200 })
})
