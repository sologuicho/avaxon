import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'
import { sendZapierEvent } from '../_shared/zapier.ts'
import { getGoogleAccessToken } from '../_shared/google.ts'
import { fechaHoraToUtcIso } from '../_shared/timezone.ts'
import { notifyAppointment } from '../_shared/appointmentEmail.ts'
import { stripeFetch } from '../_shared/stripe.ts'
import { flagNeedsHuman } from '../_shared/humanHandoff.ts'

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

// Detecta cuando el cliente pide explícitamente hablar con una persona —
// independiente de si el system_prompt de la org sabe usar notify_owner.
const HUMAN_HANDOFF_REGEX = /hablar con (alguien|una persona|un asesor|un humano|un agente|un ejecutivo|un representante)|atenci[oó]n humana|quiero un asesor|p[aá]same con (alguien|una persona)|comun[ií]came con (alguien|una persona)|necesito (hablar|que me atienda) (con )?(una persona|un humano)|representante humano/i

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

const PAYMENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'crear_link_pago',
      description: 'Genera un link de pago de Stripe para un producto o servicio del catálogo (Inventario), usando el precio YA guardado ahí. SOLO se puede usar con un producto que esté listado en el CATÁLOGO del contexto del sistema, con el nombre EXACTO como aparece ahí. Nunca la uses para un monto libre, personalizado, o un producto que no esté en esa lista — en esos casos no la llames, dile al cliente que un asesor le confirmará el monto.',
      parameters: {
        type: 'object',
        properties: {
          producto: { type: 'string', description: 'Nombre EXACTO del producto/servicio tal como aparece en el catálogo' },
          cantidad: { type: 'number', description: 'Cantidad, por defecto 1' },
        },
        required: ['producto'],
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
    const timeMin = fechaHoraToUtcIso(fecha, '00:00:00', timezone)
    const timeMax = fechaHoraToUtcIso(fecha, '23:59:59', timezone)
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${calendarToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin, timeMax, timeZone: timezone, items: [{ id: 'primary' }] }),
    })
    if (!res.ok) return `No se pudo consultar el calendario (error ${res.status}).`
    const data = await res.json()
    const busy: { start: string; end: string }[] = data.calendars?.primary?.busy ?? []
    if (busy.length === 0) return `El día ${fecha} no tiene citas registradas. Puedes ofrecer cualquier horario dentro del horario de atención del negocio.`
    // Google regresa start/end en UTC (sufijo Z) — convertir a la hora local
    // de la org, no cortar el string asumiendo que ya viene en esa zona.
    const toLocalHour = (iso: string) =>
      new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })
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
  const scheduledAt = fechaHoraToUtcIso(args.fecha, args.hora, timezone)
  const endAt = new Date(new Date(scheduledAt).getTime() + duracion * 60000).toISOString()

  // Guardar en DB — las citas agendadas por el bot quedan "pending": las
  // confirma el negocio, no quedan como confirmadas automáticamente.
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
      status:          'pending',
    })
    .select('id')
    .single()

  if (apptErr || !appt) {
    return `Error guardando la cita: ${apptErr?.message ?? 'desconocido'}`
  }

  await notifyAppointment(sb, appt.id, 'created', 'whatsapp')

  // Mueve el contacto a "Calificado" en el pipeline (solo si sigue en una
  // etapa temprana — no se toca si ya está qualified/won/lost) y le agrega
  // la etiqueta de que el bot le agendó una cita.
  try {
    const { data: contactRow } = await sb
      .from('contacts')
      .select('status, tags')
      .eq('id', contactId)
      .maybeSingle()

    const currentStatus = contactRow?.status
    const tags = new Set<string>(contactRow?.tags || [])
    tags.add('Cita agendada por bot')

    const contactUpdate: Record<string, unknown> = {
      tags: Array.from(tags),
      updated_at: new Date().toISOString(),
    }
    if (!currentStatus || currentStatus === 'new' || currentStatus === 'contacted') {
      contactUpdate.status = 'qualified'
    }
    await sb.from('contacts').update(contactUpdate).eq('id', contactId)
  } catch (e) {
    console.error('Error actualizando pipeline/etiqueta del contacto:', e)
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
    const newScheduledAt = fechaHoraToUtcIso(args.nueva_fecha!, args.nueva_hora!, timezone)
    // Reagendar por el bot también deja la cita "pending" — requiere
    // reconfirmación del negocio, igual que al agendarla por primera vez.
    await sb.from('appointments')
      .update({ scheduled_at: newScheduledAt, status: 'pending', updated_at: new Date().toISOString() })
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
    await notifyAppointment(sb, appt.id, 'rescheduled', 'whatsapp')
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
    await notifyAppointment(sb, appt.id, 'cancelled', 'whatsapp')
    return `Cita cancelada correctamente.`
  }
}

// ── Herramienta: crear link de pago (SOLO catálogo, nunca monto libre) ──────
// El bot nunca decide montos ni conceptos — busca el producto EXACTO en
// `products` (Inventario) de la org y usa el precio guardado ahí. Si no lo
// encuentra, no crea nada: regresa un mensaje para que el bot le diga al
// cliente que un asesor confirmará el monto (y active notify_owner).
async function crearLinkPago(
  args: { producto: string; cantidad?: number },
  organizationId: string,
  contactId: string,
  sb: ReturnType<typeof createClient>,
  stripeSecretKey: string,
): Promise<string> {
  const { data: integ } = await sb
    .from('integrations')
    .select('status, credentials')
    .eq('organization_id', organizationId)
    .eq('provider', 'stripe')
    .maybeSingle()

  const accountId = (integ?.credentials as { account_id?: string } | null)?.account_id
  if (integ?.status !== 'connected' || !accountId) {
    return 'Stripe no está conectado para este negocio — no se puede generar el link. Dile al cliente que un asesor le ayudará con el pago.'
  }

  const { data: products } = await sb
    .from('products')
    .select('id, name, price, status')
    .eq('organization_id', organizationId)
    .neq('status', 'agotado')
    .ilike('name', args.producto.trim())

  const product = products?.[0]
  if (!product) {
    return `"${args.producto}" no está en el catálogo (o está agotado) — NO inventes un precio ni crees un link. Dile al cliente que un asesor le confirmará el monto, y marca notify_owner en true.`
  }

  const cantidad = args.cantidad && args.cantidad > 0 ? args.cantidad : 1
  const amount = Number(product.price) * cantidad
  const amountCents = Math.round(amount * 100)

  try {
    const session = await stripeFetch('/checkout/sessions', stripeSecretKey, {
      stripeAccount: accountId,
      body: {
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'mxn',
            product_data: { name: product.name },
            unit_amount: amountCents,
          },
          quantity: cantidad,
        }],
        success_url: 'https://avaxon.lat/dashboard/?pago=exitoso',
        cancel_url: 'https://avaxon.lat/dashboard/?pago=cancelado',
      },
    })

    const { data: payment, error: insErr } = await sb.from('payments').insert({
      organization_id: organizationId,
      contact_id:       contactId,
      amount,
      currency:         'mxn',
      concept:          product.name,
      status:           'pending',
      checkout_url:     session.url,
      session_id:       session.id,
      stripe_account_id: accountId,
      created_by_bot:   true,
    }).select('id').single()

    if (insErr || !payment) {
      console.error('Error guardando payment (bot):', insErr)
      return 'Hubo un error guardando el cobro. Dile al cliente que un asesor le ayudará con el pago.'
    }

    const amountFmt = amount.toLocaleString('es-MX', { minimumFractionDigits: 2 })
    const shortUrl = `https://avaxon.lat/p/${payment.id}`
    return `Link de pago creado correctamente. Dile al cliente: "Aquí tienes tu link de pago por *${product.name}* ($${amountFmt} MXN): ${shortUrl}"`
  } catch (e) {
    console.error('Error creando Checkout Session (bot):', e)
    return 'Hubo un error con Stripe al crear el link. Dile al cliente que un asesor le ayudará con el pago.'
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
  STRIPE_SECRET_KEY: string
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

  const social = profile.social || {}
  if (social.facebook) lines.push(`Facebook: ${social.facebook}`)
  if (social.instagram) lines.push(`Instagram: ${social.instagram}`)
  if (social.tiktok) lines.push(`TikTok: ${social.tiktok}`)

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
  let needsHumanBefore = false
  const { data: existing } = await sb
    .from('conversations')
    .select('id, needs_human')
    .eq('organization_id', organization_id)
    .eq('contact_id', contact_row.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) {
    conversation_id = existing.id
    needsHumanBefore = !!existing.needs_human
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
  let incomingBatchText = ''

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
    incomingBatchText += ' ' + parsedMsg.content
    if (parsedMsg.imageDataUrl) {
      lastImageDataUrl = parsedMsg.imageDataUrl
      lastImageCaption  = parsedMsg.imageCaption
    }
  }

  if (!lastInsertedAt) return

  // ── 4b. Bandeja de atención humana ──────────────────────────────────────
  // Si la conversación YA necesitaba humano, el bot se queda callado (el
  // mensaje de arriba ya se guardó, así que sigue viéndose en el dashboard)
  // hasta que alguien la marque "atendida". Si el cliente lo pide apenas
  // ahora en este turno, se marca, se manda un acuse fijo (no depende de que
  // el system_prompt de la org sepa manejar esto) y tampoco se llama a GPT.
  if (needsHumanBefore) return

  if (HUMAN_HANDOFF_REGEX.test(incomingBatchText)) {
    await flagNeedsHuman(sb, conversation_id, organization_id, 'El cliente pidió hablar con alguien')
    const ackText = 'Ya anoté tu solicitud — en un momento una persona de nuestro equipo te atiende por aquí mismo. 🙌'
    const ackRes = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: fromPhone, type: 'text', text: { body: ackText } }),
    })
    const ackData = await ackRes.json().catch(() => ({}))
    await sb.from('messages').insert({
      conversation_id, organization_id, direction: 'outbound', content: ackText,
      media_type: 'text', wa_message_id: ackData.messages?.[0]?.id ?? null, processed_at: new Date().toISOString(),
    })
    return
  }

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
    .select('description, phone, whatsapp, email, website, address, maps_url, hours, social')
    .eq('organization_id', organization_id)
    .maybeSingle()

  const businessContext = buildBusinessContextBlock(orgProfile)

  // ── 6. Zona horaria de la org + Google Calendar (si está conectado) ────────
  // Siempre se resuelve la zona horaria real de la org (no solo cuando hay
  // Calendar conectado) — la necesita el bot para interpretar "hoy"/"mañana"
  // y para convertir bien la hora que da el cliente a UTC al agendar.
  const { data: orgRow } = await sb
    .from('organizations')
    .select('timezone')
    .eq('id', organization_id)
    .maybeSingle()
  const timezone = orgRow?.timezone || 'America/Matamoros'
  const calendarToken = await getGoogleAccessToken(sb, organization_id)

  // ── 6b. Stripe conectado + catálogo (Inventario) para links de pago ────────
  // El bot SOLO puede generar links de pago de productos del catálogo, con el
  // precio que ya está guardado ahí — nunca un monto que diga el cliente.
  const { data: stripeInteg } = await sb
    .from('integrations')
    .select('status')
    .eq('organization_id', organization_id)
    .eq('provider', 'stripe')
    .maybeSingle()
  const stripeConnected = stripeInteg?.status === 'connected'

  let catalogCtx = ''
  if (stripeConnected) {
    const { data: products } = await sb
      .from('products')
      .select('name, price')
      .eq('organization_id', organization_id)
      .neq('status', 'agotado')
      .order('name')

    if (products && products.length > 0) {
      const lines = products.map(p => `- ${p.name}: $${Number(p.price).toLocaleString('es-MX', { minimumFractionDigits: 2 })} MXN`)
      catalogCtx = `\n\nCATÁLOGO (Inventario — estos son los ÚNICOS productos/servicios para los que puedes generar un link de pago, con el precio exacto de aquí):\n${lines.join('\n')}\n\nCuando el cliente quiera pagar algo de esta lista, usa la herramienta crear_link_pago con el nombre EXACTO del producto. Si pide algo que NO está en esta lista, o un monto libre/personalizado/"lo que sea", NUNCA inventes un precio ni uses la herramienta — dile que un asesor le confirmará el monto y activa notify_owner en true.`
    } else {
      catalogCtx = `\n\nSin catálogo configurado: no tienes ningún producto/servicio con precio para generar links de pago. Si el cliente pide pagar algo, dile que un asesor le confirmará el monto y activa notify_owner en true. Nunca inventes un precio ni generes un link.`
    }
  }

  // ── 7. Construir system prompt ─────────────────────────────────────────────
  const now = new Date()
  const todayLabel = now.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone })
  const nowTimeLabel = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: timezone })

  const hasBusinessHours = Object.values(orgProfile?.hours || {}).some((h: any) => h && !h.closed && h.open && h.close)
  const hoursGuardrail = hasBusinessHours
    ? ''
    : ' No conoces el horario de atención del negocio (no está configurado) — NUNCA inventes ni asumas un horario. Si el cliente pregunta qué horarios hay disponibles para agendar, dile que un asesor del negocio le confirmará el horario exacto; no le propongas horas por tu cuenta.'

  const calendarCtx = calendarToken
    ? `\n\nCALENDARIO ACTIVO: Puedes consultar disponibilidad y agendar citas usando las herramientas disponibles. Ahora mismo es ${todayLabel}, ${nowTimeLabel} (zona horaria ${timezone}) — usa esta fecha y hora, en esta zona, para interpretar expresiones relativas como "hoy", "mañana" o "en una hora". Cuando el cliente quiera agendar: 1) Consulta disponibilidad. 2) Propón horarios libres dentro del horario de atención del negocio.${hoursGuardrail} 3) Confirma con el cliente fecha, hora y servicio explícitamente. 4) Agénda solo tras esa confirmación. Las citas que agendas quedan pendientes de confirmación por el negocio, no confirmadas automáticamente — puedes decírselo al cliente.`
    : ''

  const systemPrompt = [
    botConfig.system_prompt,
    businessContext,
    calendarCtx,
    catalogCtx,
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

  const toolsArr = [
    ...(calendarToken ? APPOINTMENT_TOOLS : []),
    ...(stripeConnected ? PAYMENT_TOOLS : []),
  ]
  const tools = toolsArr.length > 0 ? toolsArr : undefined
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
          } else if (toolCall.function.name === 'crear_link_pago') {
            toolResult = await crearLinkPago(args, organization_id, contact_row.id, sb, env.STRIPE_SECRET_KEY)
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

  // Bandeja de atención humana — para cualquier org (no solo Avaxon). La
  // respuesta de este turno SÍ se manda (ver abajo): notify_owner describe
  // el cierre del bot para este turno, no cancela lo que ya iba a decir.
  if (notifyOwner) {
    await flagNeedsHuman(sb, conversation_id, organization_id, 'El agente marcó que el cliente necesita atención')
  }

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

// ── Verifica que el POST venga realmente de Meta ────────────────────────────
// Meta firma cada entrega con HMAC-SHA256 del body crudo usando el App
// Secret, en el header X-Hub-Signature-256 ("sha256=<hex>"). El GET de
// verificación (hub.verify_token) solo protege el handshake inicial — sin
// esto, cualquiera que conociera la URL del webhook podía mandar POSTs
// falsos y hacer que el bot respondiera/gastara OpenAI y WhatsApp.
async function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const expectedHex = signatureHeader.slice('sha256='.length).toLowerCase()
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuffer  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  const computedHex = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
  if (computedHex.length !== expectedHex.length) return false
  let diff = 0
  for (let i = 0; i < computedHex.length; i++) diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req: Request) => {
  const VERIFY_TOKEN = Deno.env.get('WEBHOOK_VERIFY_TOKEN')!
  const APP_SECRET    = Deno.env.get('META_APP_SECRET') ?? ''
  const env: Env = {
    WA_TOKEN:     Deno.env.get('WA_ACCESS_TOKEN')!,
    OPENAI_KEY:   Deno.env.get('OPENAI_API_KEY')!,
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SERVICE_KEY:  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    STRIPE_SECRET_KEY: Deno.env.get('STRIPE_SECRET_KEY') || '',
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

  const rawBody = await req.text()

  if (!APP_SECRET) {
    console.error('webhook-wa: META_APP_SECRET no está configurado — se rechaza el POST por seguridad')
    return new Response('Unauthorized', { status: 401 })
  }
  const signature = req.headers.get('x-hub-signature-256')
  if (!(await verifyMetaSignature(rawBody, signature, APP_SECRET))) {
    console.error('webhook-wa: firma X-Hub-Signature-256 inválida o ausente')
    return new Response('Unauthorized', { status: 401 })
  }

  let body: any
  try { body = JSON.parse(rawBody) } catch { return new Response('Bad JSON', { status: 400 }) }

  EdgeRuntime.waitUntil(handleIncoming(body, env))
  return new Response('ok', { status: 200 })
})
