import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'

// ── Meta webhook receiver ────────────────────────────────────────────────────
// GET  → verificación de webhook (Meta llama esto una vez al configurar)
// POST → mensajes entrantes: texto, imagen (Vision), audio (Whisper) y
//        respuestas de botones interactivos. El bot responde en JSON
//        { text, buttons? } para poder mandar botones de WhatsApp cuando
//        aplica.

async function getMediaUrl(mediaId: string, token: string): Promise<{ url: string; mime: string } | null> {
  const res = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const data = await res.json()
  if (!data.url) return null
  return { url: data.url, mime: data.mime_type ?? 'application/octet-stream' }
}

async function downloadMedia(url: string, token: string): Promise<ArrayBuffer | null> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return null
  return await res.arrayBuffer()
}

async function transcribeAudio(bytes: ArrayBuffer, mime: string, apiKey: string): Promise<string | null> {
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : 'ogg'
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), `audio.${ext}`)
  form.append('model', 'whisper-1')
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.text ?? null
}

Deno.serve(async (req: Request) => {
  const VERIFY_TOKEN   = Deno.env.get('WEBHOOK_VERIFY_TOKEN')!
  const WA_TOKEN       = Deno.env.get('WA_ACCESS_TOKEN')!
  const OPENAI_KEY     = Deno.env.get('OPENAI_API_KEY')!
  const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

  // Tipos soportados: texto, respuesta de botón interactivo, imagen (Vision) y
  // audio (transcripción). El resto (video, documento, ubicación, sticker...)
  // se ignora por ahora.
  const isText   = msg.type === 'text'
  const isButton = msg.type === 'interactive' && msg.interactive?.type === 'button_reply'
  const isImage  = msg.type === 'image'
  const isAudio  = msg.type === 'audio'
  if (!isText && !isButton && !isImage && !isAudio) return new Response('ok', { status: 200 })

  const phoneNumberId = meta?.phone_number_id   // ID Meta del número receptor
  const fromPhone      = msg.from                 // número del cliente (sin +)
  const contactName    = contact?.profile?.name ?? null
  const waMessageId    = msg.id

  // ── Construir el texto a guardar y, si aplica, el bloque de imagen para GPT-4o ──
  let messageText = ''
  let mediaType: 'text' | 'image' | 'audio' = 'text'
  let imageDataUrl: string | null = null

  if (isText) {
    messageText = msg.text?.body ?? ''
  } else if (isButton) {
    messageText = msg.interactive.button_reply.title ?? ''
  } else if (isImage) {
    mediaType = 'image'
    const caption = msg.image?.caption ?? ''
    const media = msg.image?.id ? await getMediaUrl(msg.image.id, WA_TOKEN) : null
    const bytes = media ? await downloadMedia(media.url, WA_TOKEN) : null
    if (bytes && media) {
      imageDataUrl = `data:${media.mime};base64,${encodeBase64(bytes)}`
      messageText = caption ? `[Imagen] ${caption}` : '[Imagen]'
    } else {
      messageText = '[Imagen — no se pudo procesar]'
    }
  } else if (isAudio) {
    mediaType = 'audio'
    const media = msg.audio?.id ? await getMediaUrl(msg.audio.id, WA_TOKEN) : null
    const bytes = media ? await downloadMedia(media.url, WA_TOKEN) : null
    const transcript = bytes && media ? await transcribeAudio(bytes, media.mime, OPENAI_KEY) : null
    messageText = transcript ? `[Audio] ${transcript}` : '[Audio — no se pudo transcribir]'
  }

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
  const { data: savedMsg } = await sb.from('messages').insert({
    conversation_id,
    organization_id,
    direction:     'inbound',
    content:       messageText,
    media_type:    mediaType,
    wa_message_id: waMessageId,
  }).select('created_at').single()

  // ── 5. Bot IA (solo si está habilitado para esta org) ──────────────────────
  const { data: botConfig } = await sb
    .from('bot_configs')
    .select('system_prompt, enabled')
    .eq('organization_id', organization_id)
    .eq('enabled', true)
    .maybeSingle()

  if (!botConfig) return new Response('ok', { status: 200 })

  // ── Debounce: esperar 5 s por si el usuario manda varios mensajes seguidos ──
  // Usamos el created_at real de BD (no Date.now()) para evitar drift por latencia de queries.
  const msgTimestamp = savedMsg?.created_at ?? new Date().toISOString()
  await new Promise(resolve => setTimeout(resolve, 5000))

  // Si llegó un mensaje más reciente de este contacto en la misma conversación,
  // ese invocation lo procesará — este sale sin responder para evitar doble respuesta.
  const { data: newerMsg } = await sb
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation_id)
    .eq('direction', 'inbound')
    .gt('created_at', msgTimestamp)
    .limit(1)
    .maybeSingle()

  if (newerMsg) return new Response('ok', { status: 200 })

  // Traer todos los mensajes inbound recientes (últimos 8 s) para combinarlos en un solo turno
  const batchSince = new Date(Date.now() - 8000).toISOString()
  const { data: batchMsgs } = await sb
    .from('messages')
    .select('content, created_at')
    .eq('conversation_id', conversation_id)
    .eq('direction', 'inbound')
    .gte('created_at', batchSince)
    .order('created_at', { ascending: true })

  const combinedUserText = batchMsgs && batchMsgs.length > 1
    ? batchMsgs.map(m => m.content).join('\n')
    : messageText

  const { data: history } = await sb
    .from('messages')
    .select('direction, content, created_at')
    .eq('conversation_id', conversation_id)
    .order('created_at', { ascending: false })
    .limit(12)

  // Construir historial excluyendo los mensajes del batch actual (se fusionan en uno)
  const batchIds = new Set((batchMsgs ?? []).map(m => m.created_at))
  const chatHistory: any[] = (history ?? [])
    .reverse()
    .filter(m => m.direction === 'outbound' || !batchIds.has(m.created_at))
    .map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content }))

  // Añadir el turno combinado del usuario al final
  chatHistory.push({ role: 'user', content: combinedUserText })

  // Si el mensaje actual trae una imagen procesada, se reemplaza el último
  // turno (el que se acaba de insertar arriba) por contenido multimodal para
  // GPT-4o Vision.
  if (imageDataUrl && chatHistory.length > 0) {
    const last = chatHistory[chatHistory.length - 1]
    last.content = [
      { type: 'text', text: (msg.image?.caption ?? '').trim() || 'Describe brevemente esta imagen y ayuda al cliente con lo que necesita.' },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ]
  }

  // Llamada a GPT-4o. El system_prompt debe pedir salida JSON { text, buttons? }.
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

  const waRes = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
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
