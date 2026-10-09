import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'
import { sendZapierEvent } from '../_shared/zapier.ts'
import { getGoogleAccessToken } from '../_shared/google.ts'

// ── Meta webhook receiver ────────────────────────────────────────────────────
// GET  → verificación de webhook
// POST → mensajes entrantes. Responde 200 a Meta de inmediato (EdgeRuntime.waitUntil)
//        para evitar retries; el procesamiento real corre en background.
//
// Debounce: cuando el usuario manda varios mensajes seguidos, cada invocación
// espera DEBOUNCE_MS. Si durante esa espera llega un mensaje más nuevo, esta
// invocación se retira — la más nueva contesta, juntando todos los pendientes.
//
// Function calling: si la org tiene Google Calendar conectado, GPT-4o puede
// llamar a consultar_disponibilidad, agendar_cita y cancelar_o_reagendar_cita.
// El bot confirma con el usuario antes de agendar (instrucción en las tools).

const DEBOUNCE_MS = 5000

// ── Timezone offset helper (México) ─────────────────────────────────────────
const TZ_OFFSETS: Record<string, string> = {
  'America/Mexico_City': '-06:00',
  'America/Monterrey':   '-06:00',
  'America/Matamoros':   '-06:00',
  'America/Chihuahua':   '-07:00',
  'America/Hermosillo':  '-07:00',
  'America/Mazatlan':    '-07:00',
  'America/Tijuana':     '-08:00',
  'America/Cancun':      '-05:00',
}
function tzOffset(tz: string): string { return TZ_OFFSETS[tz] || '-06:00' }

// ── Tool definitions ─────────────────────────────────────────────────────────
const APPOINTMENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'consultar_disponibilidad',
      description: 'Consulta los horarios ocupados del negocio en Google Calendar para una fecha. Úsala cuando el cliente pregunte qué días u horas están disponibles para una cita.',
      parameters: {
        type: 'object',
        properties: {
          fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD, ej: 2026-10-15' },
        },
        required: ['fecha'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agendar_cita',
      description: 'Agenda una cita en el calendario del negocio. Solo llama esta función cuando el cliente haya confirmado EXPLÍCITAMENTE la fecha, la hora y el servicio. Si hay alguna duda o el cliente no ha confirmado, pregúntale primero antes de agendar.',
      parameters: {
        type: 'object',
        properties: {
          fecha:    { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
          hora:     { type: 'string', description: 'Hora en formato HH:MM (24h), ej: 14:30' },
          servicio: { type: 'string', description: 'Nombre del servicio o motivo de la cita' },
          nombre:   { type: 'string', description: 'Nombre completo del cliente' },
          duracion_minutos: { type: 'number', description: 'Duración de la cita en minutos, por defecto 60' },
        },
        required: ['fecha', 'hora', 'servicio', 'nombre'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancelar_o_reagendar_cita',
      description: 'Cancela o reagenda una cita existente del cliente. Para reagendar, incluye nueva_fecha y nueva_hora; para solo cancelar, omite esos campos.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'string', description: 'ID de la cita a modificar' },
          nueva_fecha:    { type: 'string', description: 'Nueva fecha YYYY-MM-DD (solo para reagendar)' },
          nueva_hora:     { type: 'string', description: 'Nueva hora HH:MM (solo para reagendar)' },
        },
        required: ['appointment_id'],
      },
    },
  },
]

// ── Herramienta: consultar disponibilidad ────────────────────────────────────
async function consultarDisponibilidad(
  fecha: string,
  calendarToken: string,
  timezone: string,
): Promise<string> {
  try {
    const offset = tzOffset(timezone)
    const timeMin = `${fecha}T00:00:00${offset}`
    const timeMax = `${fecha}T23:59:59${offset}`
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${calendarToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin, timeMax, timeZone: timezone, items: [{ id: 'primary' }] }),
    })
    if (!res.ok) return `No se pudo consultar el calendario (error ${res.status}).`
    const data = await res.json()
    const busy: { start: string; end: string }[] = data.calendars?.primary?.busy ?? []
    if (busy.length === 0) return `El día ${fecha} no tiene citas registradas. Puedes ofrecer cualquier horario dentro del horario de atención del negocio.`
    const toLocalHour = (iso: string) => iso.substring(11, 16)
    const slots = busy.map(b => `${toLocalHour(b.start)}–${toLocalHour(b.end)}`).join(', ')
    return `El día ${fecha} tiene los siguientes horarios ocupados: ${slots}. Puedes agendar en cualquier hueco libre dentro del horario del negocio.`
  } catch (e) {
    return `Error consultando el calendario: ${(e as Error).message}`
  }
}

// ── Herramienta: agendar cita ────────────────────────────────────────────────
async function agendarCita(
  args: { fecha: string; hora: string; servicio: string; nombre: string; duracion_minutos?: number },
  organizationId: string,
  contactId: string,
  sb: ReturnType<typeof createClient>,
  calendarToken: string,
  timezone: string,
): Promise<string> {
  const duracion = args.duracion_minutos || 60
  const offset   = tzOffset(timezone)
  const scheduledAt = `${args.fecha}T${args.hora}:00${offset}`
  const endAt = new Date(new Date(scheduledAt).getTime() + duracion * 60000).toISOString()

  // Guardar en DB
  const { data: appt, error: apptErr } = await sb
    .from('appointments')
    .insert({
      organization_id: organizationId,
      contact_id:      contactId,
      contact_name:    args.nombre,
      title:           args.servicio,
      service:         args.servicio,
      scheduled_at:    scheduledAt,
      duration_minutes: duracion,
      status:          'confirmed',
    })
    .select('id')
    .single()

  if (apptErr || !appt) {
    return `Error guardando la cita: ${apptErr?.message ?? 'desconocido'}`
  }

  // Crear evento en Google Calendar
  let googleEventId: string | null = null
  try {
    const eventRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${calendarToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary:     `${args.servicio} — ${args.nombre}`,
        description: `Cita agendada por WhatsApp vía Avaxon`,
        start: { dateTime: scheduledAt, timeZone: timezone },
        end:   { dateTime: endAt, timeZone: timezone },
      }),
    })
    if (eventRes.ok) {
      const eventData = await eventRes.json()
      googleEventId = eventData.id
      await sb.from('appointments')
        .update({ google_event_id: googleEventId, updated_at: new Date().toISOString() })
        .eq('id', appt.id)
    }
  } catch { /* continuar aunque Google falle */ }

  return `Cita agendada correctamente. ID: ${appt.id}. Fecha: ${args.fecha} a las ${args.hora}. Servicio: ${args.servicio}. ${googleEventId ? 'Evento creado en Google Calendar.' : ''}`
}

// ── Herramienta: cancelar o reagendar ────────────────────────────────────────
async function cancelarOReagendarCita(
  args: { appointment_id: string; nueva_fecha?: string; nueva_hora?: string },
  organizationId: string,
  sb: ReturnType<typeof createClient>,
  calendarToken: string,
  timezone: string,
): Promise<string> {
  const { data: appt } = await sb
    .from('appointments')
    .select('id, title, service, scheduled_at, google_event_id, status')
    .eq('id', args.appointment_id)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (!appt) return `No se encontró la cita con ID ${args.appointment_id}.`
  if (appt.status === 'cancelled') return `La cita ya estaba cancelada.`

  const isReschedule = !!(args.nueva_fecha && args.nueva_hora)

  if (isReschedule) {
    const offset = tzOffset(timezone)
    const newScheduledAt = `${args.nueva_fecha}T${args.nueva_hora}:00${offset}`
    await sb.from('appointments')
      .update({ scheduled_at: newScheduledAt, status: 'confirmed', updated_at: new Date().toISOString() })
      .eq('id', appt.id)

    if (appt.google_event_id) {
      const duracion = 60
      const endAt = new Date(new Date(newScheduledAt).getTime() + duracion * 60000).toISOString()
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${appt.google_event_id}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${calendarToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start: { dateTime: newScheduledAt, timeZone: timezone },
            end:   { dateTime: endAt, timeZone: timezone },
          }),
        },
      ).catch(() => {})
    }
    return `Cita reagendada para el ${args.nueva_fecha} a las ${args.nueva_hora}.`
  } else {
    await sb.from('appointments')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', appt.id)

    if (appt.google_event_id) {
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${appt.google_event_id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${calendarToken}` } },
      ).catch(() => {})
    }
    return `Cita cancelada correctamente.`
  }
}

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
  WA_TOKEN: string
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

const DAY_LABELS: Record<string, string> = {
  mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves',
  fri: 'Viernes', sat: 'Sábado', sun: 'Domingo',
}
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

function buildBusinessContextBlock(profile: any): string {
  if (!profile) return ''
  const lines: string[] = []

  if (profile.description) lines.push(`Descripción: ${profile.description}`)
  if (profile.phone) lines.push(`Teléfono: ${profile.phone}`)
  if (profile.whatsapp) lines.push(`WhatsApp: ${profile.whatsapp}`)
  if (profile.email) lines.push(`Correo: ${profile.email}`)
  if (profile.website) lines.push(`Sitio web: ${profile.website}`)
  if (profile.address) lines.push(`Dirección: ${profile.address}`)
  if (profile.maps_url) lines.push(`Ubicación en Google Maps: ${profile.maps_url}`)

  const hours = profile.hours || {}
  const hourLines = DAY_ORDER
    .filter(day => hours[day])
    .map(day => {
      const h = hours[day]
      return h.closed ? `${DAY_LABELS[day]}: cerrado` : `${DAY_LABELS[day]}: ${h.open}–${h.close}`
    })
  if (hourLines.length) {
    lines.push('Horarios de atención:')
    hourLines.forEach(l => lines.push(`- ${l}`))
  }

  if (!lines.length) return ''
  return `INFORMACIÓN DEL NEGOCIO (de Configuración — usa esto para responder sobre contacto, ubicación y horarios; no inventes datos que no estén aquí):\n${lines.join('\n')}`
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
    sendZapierEvent(sb, organization_id, 'lead_created', {
      contact_name:    contactName ?? fromPhone,
      contact_phone:   fromPhone,
      conversation_id: newConv.id,
    })
  }

  // ── 4. Procesar y guardar CADA mensaje entrante ────────────────────────────
  let lastInsertedAt: string | null = null
  let lastImageDataUrl: string | null = null
  let lastImageCaption = ''

  for (const rawMsg of rawMessages) {
    const waMessageId = rawMsg?.id as string | undefined

    if (waMessageId) {
      const { data: dup } = await sb
        .from('messages')
        .select('id')
        .eq('wa_message_id', waMessageId)
        .maybeSingle()
      if (dup) continue
    }

    const parsedMsg = await parseMessage(rawMsg, clientToken, OPENAI_KEY)
    if (!parsedMsg) continue

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
      if (insertErr.code !== '23505') console.error('Error guardando mensaje entrante:', insertErr)
      continue
    }

    lastInsertedAt = inserted.created_at
    if (parsedMsg.imageDataUrl) {
      lastImageDataUrl = parsedMsg.imageDataUrl
      lastImageCaption  = parsedMsg.imageCaption
    }
  }

  if (!lastInsertedAt) return

  // ── 5. Bot IA (solo si está habilitado) ────────────────────────────────────
  const { data: botConfig } = await sb
    .from('bot_configs')
    .select('system_prompt, enabled')
    .eq('organization_id', organization_id)
    .eq('enabled', true)
    .maybeSingle()

  if (!botConfig) return

  const { data: orgProfile } = await sb
    .from('organization_profile')
    .select('description, phone, whatsapp, email, website, address, maps_url, hours')
    .eq('organization_id', organization_id)
    .maybeSingle()

  const businessContext = buildBusinessContextBlock(orgProfile)

  // ── 6. Google Calendar: token + timezone (si está conectado) ───────────────
  const calendarToken = await getGoogleAccessToken(sb, organization_id)
  let timezone = 'America/Matamoros'
  if (calendarToken) {
    const { data: org } = await sb
      .from('organizations')
      .select('timezone')
      .eq('id', organization_id)
      .maybeSingle()
    timezone = org?.timezone || 'America/Matamoros'
  }

  // ── 7. Construir system prompt ─────────────────────────────────────────────
  const today = new Date().toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone })
  const calendarCtx = calendarToken
    ? `\n\nCALENDARIO ACTIVO: Puedes consultar disponibilidad y agendar citas usando las herramientas disponibles. Hoy es ${today}. Cuando el cliente quiera agendar: 1) Consulta disponibilidad. 2) Propón horarios libres. 3) Confirma con el cliente. 4) Agénda solo tras confirmación explícita.`
    : ''

  const systemPrompt = [
    botConfig.system_prompt,
    businessContext,
    calendarCtx,
  ].filter(Boolean).join('\n\n')

  // ── 8. Debounce ────────────────────────────────────────────────────────────
  await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS))

  const { data: newer } = await sb
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation_id)
    .eq('direction', 'inbound')
    .is('processed_at', null)
    .gt('created_at', lastInsertedAt)
    .limit(1)

  if (newer && newer.length > 0) return

  // ── 9. Snapshot de mensajes pendientes ────────────────────────────────────
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

  // ── 10. Historial previo + turno actual ────────────────────────────────────
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

  // ── 11. Loop GPT-4o con function calling ───────────────────────────────────
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
  ]

  const tools = calendarToken ? APPOINTMENT_TOOLS : undefined
  let rawReply = ''
  const MAX_TOOL_LOOPS = 5

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:           'gpt-4o',
        response_format: { type: 'json_object' },
        messages,
        tools,
        max_tokens:  600,
        temperature: 0.7,
      }),
    })

    const aiData  = await aiRes.json()
    const choice  = aiData.choices?.[0]
    const message = choice?.message

    if (!message) {
      console.error('GPT no devolvió mensaje:', JSON.stringify(aiData))
      break
    }

    if (choice.finish_reason === 'tool_calls' && message.tool_calls?.length) {
      messages.push(message) // assistant message con tool_calls

      for (const toolCall of message.tool_calls) {
        let toolResult: string
        try {
          const args = JSON.parse(toolCall.function.arguments)
          if (toolCall.function.name === 'consultar_disponibilidad') {
            toolResult = await consultarDisponibilidad(args.fecha, calendarToken!, timezone)
          } else if (toolCall.function.name === 'agendar_cita') {
            toolResult = await agendarCita(args, organization_id, contact_row.id, sb, calendarToken!, timezone)
            sendZapierEvent(sb, organization_id, 'appointment_booked', {
              contact_name:  args.nombre,
              contact_phone: fromPhone,
              service:       args.servicio,
              fecha:         args.fecha,
              hora:          args.hora,
            })
          } else if (toolCall.function.name === 'cancelar_o_reagendar_cita') {
            toolResult = await cancelarOReagendarCita(args, organization_id, sb, calendarToken!, timezone)
          } else {
            toolResult = 'Herramienta no reconocida.'
          }
        } catch (e) {
          toolResult = `Error ejecutando la herramienta: ${(e as Error).message}`
        }

        messages.push({
          role:         'tool',
          tool_call_id: toolCall.id,
          content:      toolResult,
        })
      }
      // continuar el loop para obtener la respuesta final
    } else {
      rawReply = message.content?.trim() ?? ''
      break
    }
  }

  if (!rawReply) return

  // ── 12. Parsear respuesta JSON del bot ─────────────────────────────────────
  let aiParsed: { text: string; buttons?: string[]; notify_owner?: boolean }
  try {
    aiParsed = JSON.parse(rawReply)
  } catch {
    aiParsed = { text: rawReply }
  }

  const replyText = (aiParsed.text ?? rawReply)
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/~~([^~\n]+)~~/g, '~$1~')
    .replace(/^#{1,6}\s+/gm, '')
  const buttonLabels = (aiParsed.buttons ?? []).slice(0, 3)
  const notifyOwner  = aiParsed.notify_owner === true

  // ── 13. Enviar respuesta por WhatsApp ──────────────────────────────────────
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

  // ── 14. Marcar como procesados los IDs de este batch ──────────────────────
  await sb.from('messages')
    .update({ processed_at: new Date().toISOString() })
    .in('id', batchIds)

  // ── 15. Notificar al dueño si el lead quiere agendar (Avaxon) ─────────────
  if (notifyOwner) {
    const leadName    = contactName ?? fromPhone
    const AVAXON_PHONE = '528991709336'
    const notifText   = `🔔 *Lead listo para agendar — Avaxon*\n\n*Contacto:* ${leadName}\n*WhatsApp:* wa.me/${fromPhone}\n\nConfirmó interés en el diagnóstico gratuito. ¡Escríbele pronto! 💼`
    await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   AVAXON_PHONE,
        type: 'text',
        text: { body: notifText },
      }),
    }).catch(() => {})

    const sendAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    const reminderText = `⏰ *Recordatorio — Avaxon*\n\n${leadName} todavía espera respuesta para agendar su diagnóstico gratuito.\n\n*WhatsApp:* wa.me/${fromPhone}\n\n¡No pierdas este lead! 🎯`
    const { error: reminderErr } = await sb.from('reminders').insert({
      send_at:         sendAt,
      to_phone:        AVAXON_PHONE,
      message:         reminderText,
      phone_number_id: phoneNumberId,
    })
    if (reminderErr) console.error('reminder insert error:', reminderErr.message)

    sendZapierEvent(sb, organization_id, 'lead_qualified', {
      contact_name:    leadName,
      contact_phone:   fromPhone,
      conversation_id,
    })
  }

  // ── 16. Guardar mensaje saliente ──────────────────────────────────────────
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

  if (req.method === 'GET') {
    const url       = new URL(req.url)
    const mode      = url.searchParams.get('hub.mode')
    const token     = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      const sb = createClient(env.SUPABASE_URL, env.SERVICE_KEY)
      await sb.from('phone_numbers').update({ webhook_verified: true }).eq('status', 'active')
      return new Response(challenge, { status: 200 })
    }
    return new Response('Forbidden', { status: 403 })
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  let body: any
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }

  EdgeRuntime.waitUntil(handleIncoming(body, env))
  return new Response('ok', { status: 200 })
})
