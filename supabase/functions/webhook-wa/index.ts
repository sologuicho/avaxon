import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'

// ── Meta webhook receiver ────────────────────────────────────────────────────
// GET  → verificación de webhook
// POST → mensajes entrantes. Responde 200 a Meta de inmediato (EdgeRuntime.waitUntil)
//        para evitar retries; el procesamiento real corre en background.
//
// Token por cliente: cada phone_numbers tiene su whatsapp_accounts.access_token;
// si no existe, se usa WA_ACCESS_TOKEN (System User de Avaxon) como fallback.
//
// Debounce de mensajes fragmentados: cuando el usuario manda varios mensajes
// seguidos ("oye" / "si" / "es que" / "quiero ver los planes"), cada uno se
// guarda por separado y esta invocación espera DEBOUNCE_MS antes de contestar.
// Si durante esa espera llega un mensaje más nuevo del mismo contacto, esta
// invocación se retira sin hacer nada — la invocación del mensaje más nuevo es
// la que termina respondiendo, juntando en un solo turno para GPT-4o TODOS los
// mensajes entrantes que en ese momento sigan sin procesar (processed_at NULL).
//
// El snapshot de IDs a marcar como procesados se toma justo antes de llamar a
// GPT-4o — si llega un mensaje nuevo mientras se genera la respuesta, ese
// mensaje NO se marca (sigue pendiente) y lo recoge su propia invocación.

const DEBOUNCE_MS = 5000

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

interface Env {
  WA_TOKEN: string   // fallback si el cliente no tiene token propio
  OPENAI_KEY: string
  SUPABASE_URL: string
  SERVICE_KEY: string
}

interface ParsedMessage {
  waMessageId: string
  content: string
  mediaType: 'text' | 'image' | 'audio'
  imageDataUrl: string | null
  imageCaption: string
}

// Extrae texto/tipo de UN mensaje crudo de Meta (texto, botón, imagen o audio).
// Devuelve null para tipos no soportados (video, documento, ubicación, sticker...).
// `token` es el access_token del cliente (o el fallback global) para media.
async function parseMessage(msg: any, token: string, openaiKey: string): Promise<ParsedMessage | null> {
  const isText   = msg.type === 'text'
  const isButton = msg.type === 'interactive' && msg.interactive?.type === 'button_reply'
  const isImage  = msg.type === 'image'
  const isAudio  = msg.type === 'audio'
  if (!isText && !isButton && !isImage && !isAudio) return null

  let content = ''
  let mediaType: 'text' | 'image' | 'audio' = 'text'
  let imageDataUrl: string | null = null
  let imageCaption = ''

  if (isText) {
    content = msg.text?.body ?? ''
  } else if (isButton) {
    content = msg.interactive.button_reply.title ?? ''
  } else if (isImage) {
    mediaType = 'image'
    imageCaption = msg.image?.caption ?? ''
    const media = msg.image?.id ? await getMediaUrl(msg.image.id, token) : null
    const bytes = media ? await downloadMedia(media.url, token) : null
    if (bytes && media) {
      imageDataUrl = `data:${media.mime};base64,${encodeBase64(bytes)}`
      content = imageCaption ? `[Imagen] ${imageCaption}` : '[Imagen]'
    } else {
      content = '[Imagen — no se pudo procesar]'
    }
  } else if (isAudio) {
    mediaType = 'audio'
    const media = msg.audio?.id ? await getMediaUrl(msg.audio.id, token) : null
    const bytes = media ? await downloadMedia(media.url, token) : null
    const transcript = bytes && media ? await transcribeAudio(bytes, media.mime, openaiKey) : null
    content = transcript ? `[Audio] ${transcript}` : '[Audio — no se pudo transcribir]'
  }

  return { waMessageId: msg.id, content, mediaType, imageDataUrl, imageCaption }
}

async function fireZapier(
  sb: ReturnType<typeof createClient>,
  organization_id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { data: integ } = await sb
    .from('integrations')
    .select('config')
    .eq('organization_id', organization_id)
    .eq('provider', 'zapier')
    .eq('status', 'connected')
    .maybeSingle()
  const url = (integ?.config as any)?.webhook_url
  if (!url) return
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
  }).catch(() => {})
}

async function handleIncoming(body: any, env: Env): Promise<void> {
  const { WA_TOKEN, OPENAI_KEY, SUPABASE_URL, SERVICE_KEY } = env

  const entry       = body?.entry?.[0]
  const change      = entry?.changes?.[0]
  const value       = change?.value
  const rawMessages = value?.messages
  if (!rawMessages?.length) return

  const meta          = value.metadata
  const contact        = value.contacts?.[0]
  const phoneNumberId  = meta?.phone_number_id
  const fromPhone      = rawMessages[0]?.from
  const contactName    = contact?.profile?.name ?? null

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  // ── 1. Resolver organización + token por cliente ────────────────────────────
  const { data: pn } = await sb
    .from('phone_numbers')
    .select('id, organization_id, whatsapp_accounts(access_token)')
    .eq('phone_number_id', phoneNumberId)
    .single()

  if (!pn) {
    console.error('phone_number_id no encontrado en BD:', phoneNumberId)
    return
  }
  const { organization_id } = pn
  const clientToken = (pn.whatsapp_accounts as any)?.access_token ?? WA_TOKEN

  // ── 2. Upsert contacto ─────────────────────────────────────────────────────
  const { data: contact_row } = await sb
    .from('contacts')
    .upsert(
      { organization_id, phone: fromPhone, name: contactName, last_seen_at: new Date().toISOString() },
      { onConflict: 'organization_id,phone' }
    )
    .select('id')
    .single()

  if (!contact_row) return

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
    if (!newConv) return
    conversation_id = newConv.id
    fireZapier(sb, organization_id, {
      event:           'new_contact',
      contact_name:    contactName ?? fromPhone,
      contact_phone:   fromPhone,
      conversation_id: newConv.id,
      organization_id,
    })
  }

  // ── 4. Procesar y guardar CADA mensaje entrante del payload ────────────────
  // Meta casi siempre manda un mensaje por webhook, pero value.messages es un
  // arreglo — se procesan todos, no solo el primero.
  let lastInsertedAt: string | null = null
  let lastImageDataUrl: string | null = null
  let lastImageCaption = ''

  for (const rawMsg of rawMessages) {
    const waMessageId = rawMsg?.id as string | undefined

    // Idempotencia: si Meta ya reintentó este mensaje, ya está guardado.
    if (waMessageId) {
      const { data: dup } = await sb
        .from('messages')
        .select('id')
        .eq('wa_message_id', waMessageId)
        .maybeSingle()
      if (dup) continue
    }

    const parsedMsg = await parseMessage(rawMsg, clientToken, OPENAI_KEY)
    if (!parsedMsg) continue // tipo no soportado

    const { data: inserted, error: insertErr } = await sb
      .from('messages')
      .insert({
        conversation_id,
        organization_id,
        direction:     'inbound',
        content:       parsedMsg.content,
        media_type:    parsedMsg.mediaType,
        wa_message_id: parsedMsg.waMessageId,
      })
      .select('created_at')
      .single()

    if (insertErr) {
      // 23505 = unique_violation: carrera con la constraint (reintento de Meta
      // llegó al mismo tiempo que el chequeo de arriba) — se ignora, no es error real.
      if (insertErr.code !== '23505') console.error('Error guardando mensaje entrante:', insertErr)
      continue
    }

    lastInsertedAt = inserted.created_at
    if (parsedMsg.imageDataUrl) {
      lastImageDataUrl = parsedMsg.imageDataUrl
      lastImageCaption  = parsedMsg.imageCaption
    }
  }

  if (!lastInsertedAt) return // todo era duplicado o de tipos no soportados

  // ── 5. Bot IA (solo si está habilitado para esta org) ──────────────────────
  const { data: botConfig } = await sb
    .from('bot_configs')
    .select('system_prompt, enabled')
    .eq('organization_id', organization_id)
    .eq('enabled', true)
    .maybeSingle()

  if (!botConfig) return

  // ── 6. Debounce: esperar y ceder el turno si llegó algo más nuevo ──────────
  await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS))

  const { data: newer } = await sb
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation_id)
    .eq('direction', 'inbound')
    .is('processed_at', null)
    .gt('created_at', lastInsertedAt)
    .limit(1)

  if (newer && newer.length > 0) return // no soy el último — la invocación más nueva contesta

  // ── 7. Snapshot de TODO lo pendiente en este momento (IDs fijos) ───────────
  const { data: pending } = await sb
    .from('messages')
    .select('id, content, created_at')
    .eq('conversation_id', conversation_id)
    .eq('direction', 'inbound')
    .is('processed_at', null)
    .order('created_at', { ascending: true })

  if (!pending || pending.length === 0) return
  const batchIds     = pending.map(m => m.id)
  const combinedText = pending.map(m => m.content).join('\n')

  // ── 8. Historial previo (ya procesado) + el turno combinado ────────────────
  const batchIdSet = new Set(batchIds)
  const { data: historyRaw } = await sb
    .from('messages')
    .select('id, direction, content')
    .eq('conversation_id', conversation_id)
    .order('created_at', { ascending: false })
    .limit(14 + batchIds.length)

  const chatHistory: any[] = (historyRaw ?? [])
    .filter(m => !batchIdSet.has(m.id))
    .slice(0, 14)
    .reverse()
    .map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content }))

  if (lastImageDataUrl) {
    chatHistory.push({
      role: 'user',
      content: [
        { type: 'text', text: combinedText || lastImageCaption || 'Describe brevemente esta imagen y ayuda al cliente con lo que necesita.' },
        { type: 'image_url', image_url: { url: lastImageDataUrl } },
      ],
    })
  } else {
    chatHistory.push({ role: 'user', content: combinedText })
  }

  // ── 9. Llamada a GPT-4o ──────────────────────────────────────────────────────
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
      max_tokens:  600,
      temperature: 0.7,
    }),
  })

  const aiData   = await aiRes.json()
  const rawReply = aiData.choices?.[0]?.message?.content?.trim()
  if (!rawReply) return

  let aiParsed: { text: string; buttons?: string[]; notify_owner?: boolean }
  try {
    aiParsed = JSON.parse(rawReply)
  } catch {
    aiParsed = { text: rawReply }
  }

  const replyText    = aiParsed.text ?? rawReply
  const buttonLabels = (aiParsed.buttons ?? []).slice(0, 3)
  const notifyOwner  = aiParsed.notify_owner === true

  // ── 10. Enviar mensaje WhatsApp (con el token del cliente) ──────────────────
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
    headers: { 'Authorization': `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(waPayload),
  })
  const waData = await waRes.json()

  // ── 11. Marcar como procesados SOLO los IDs de este batch (no todo NULL) ───
  await sb.from('messages')
    .update({ processed_at: new Date().toISOString() })
    .in('id', batchIds)

  // ── 12. Notificar al dueño si el lead quiere agendar ────────────────────────
  if (notifyOwner) {
    const leadName = contactName ?? fromPhone
    const notifText = `🔔 *Lead listo para agendar — Avaxon*\n\n*Contacto:* ${leadName}\n*WhatsApp:* wa.me/${fromPhone}\n\nConfirmó interés en el diagnóstico gratuito. ¡Escríbele pronto! 💼`
    await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   '19563285800',
        type: 'text',
        text: { body: notifText },
      }),
    }).catch(() => {})

    const sendAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    const reminderText = `⏰ *Recordatorio — Avaxon*\n\n${leadName} todavía espera respuesta para agendar su diagnóstico gratuito.\n\n*WhatsApp:* wa.me/${fromPhone}\n\n¡No pierdas este lead! 🎯`
    await sb.from('reminders').insert({
      send_at:         sendAt,
      to_phone:        '19563285800',
      message:         reminderText,
      phone_number_id: phoneNumberId,
    }).catch(() => {})
  }

  // ── 13. Guardar mensaje saliente (siempre queda "procesado") ───────────────
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
    processed_at:  new Date().toISOString(),
  })
}

Deno.serve(async (req: Request) => {
  const VERIFY_TOKEN = Deno.env.get('WEBHOOK_VERIFY_TOKEN')!
  const env: Env = {
    WA_TOKEN:     Deno.env.get('WA_ACCESS_TOKEN')!,
    OPENAI_KEY:   Deno.env.get('OPENAI_API_KEY')!,
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SERVICE_KEY:  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  }

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

  // Responder a Meta inmediatamente para evitar retries por timeout; el
  // procesamiento (incluido el debounce de ~8s) corre en background.
  EdgeRuntime.waitUntil(handleIncoming(body, env))
  return new Response('ok', { status: 200 })
})
