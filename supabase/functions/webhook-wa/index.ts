import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'
import { sendZapierEvent } from '../_shared/zapier.ts'
import { getGoogleAccessToken } from '../_shared/google.ts'
import { fechaHoraToUtcIso } from '../_shared/timezone.ts'
import { notifyAppointment } from '../_shared/appointmentEmail.ts'
import { stripeFetch } from '../_shared/stripe.ts'
import { flagNeedsHuman, notifyOwnerAlert } from '../_shared/humanHandoff.ts'
import { logBotError } from '../_shared/botErrorLog.ts'

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

// Respuestas del bot rechazando un horario/cita por fuera de atención — se
// quitan del historial que ve el modelo (ver chatHistory abajo) para que no
// copie la conclusión de un rechazo viejo en vez de volver a evaluarla.
const BOT_SCHEDULE_REJECTION_REGEX = /no podemos agendar|no se puede agendar|fuera del horario de atenci[oó]n|fuera de horario|horario de atenci[oó]n es de/i

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
          nombre:   { type: 'string', description: 'Nombre completo REAL del cliente, tal como él lo dijo en la conversación. Si no lo sabes, pregúntaselo ANTES de llamar esta herramienta — nunca pongas un nombre genérico como "Cliente" o "Sin nombre".' },
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
  hours?: any,
): Promise<string> {
  try {
    const timeMin = fechaHoraToUtcIso(fecha, '00:00:00', timezone)
    const timeMax = fechaHoraToUtcIso(fecha, '23:59:59', timezone)

    // Ventana real de atención para ESE día — para que el bot nunca ofrezca
    // horas fuera de ella, ni siquiera cuando no hay citas registradas.
    let windowLabel: string
    if (hours && typeof hours === 'object') {
      const dayKey = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(new Date(timeMin)).toLowerCase().slice(0, 3)
      const h = hours[dayKey]
      windowLabel = (!h || h.closed || !h.open || !h.close)
        ? `el negocio está CERRADO ese día (${fecha}) — no ofrezcas ningún horario ese día, propón otro día`
        : `el horario de atención ese día (${fecha}) es de ${h.open} a ${h.close} — SOLO puedes ofrecer horas dentro de ese rango`
    } else {
      windowLabel = 'no hay horario de atención configurado — no inventes ni asumas uno, dile al cliente que un asesor le confirmará el horario'
    }

    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${calendarToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin, timeMax, timeZone: timezone, items: [{ id: 'primary' }] }),
    })
    if (!res.ok) return `No se pudo consultar el calendario (error ${res.status}).`
    const data = await res.json()
    const busy: { start: string; end: string }[] = data.calendars?.primary?.busy ?? []
    if (busy.length === 0) return `El día ${fecha} no tiene citas registradas; ${windowLabel}.`
    // Google regresa start/end en UTC (sufijo Z) — convertir a la hora local
    // de la org, no cortar el string asumiendo que ya viene en esa zona.
    const toLocalHour = (iso: string) =>
      new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })
    const slots = busy.map(b => `${toLocalHour(b.start)}–${toLocalHour(b.end)}`).join(', ')
    return `El día ${fecha} tiene los siguientes horarios ocupados: ${slots}; ${windowLabel}. Ofrece un hueco libre dentro de ese rango.`
  } catch (e) {
    return `Error consultando el calendario: ${(e as Error).message}`
  }
}

// ── Detección en código de una fecha/hora pedida en el mensaje ─────────────
// El modelo puede copiar la conclusión de un rechazo viejo del historial en
// vez de volver a evaluar el horario — para que la decisión de disponibilidad
// NUNCA dependa solo del prompt, esto extrae la fecha/hora con una llamada
// aparte y chica a OpenAI (temperatura 0, sin herramientas), y el código
// mismo (no el modelo) decide si está dentro de horario y libre en el
// calendario. El resultado se inyecta como dato obligatorio más abajo.
async function extractAppointmentSlot(
  combinedText: string,
  nowLabel: string,
  timezone: string,
  openaiKey: string,
): Promise<{ fecha: string; hora: string | null } | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 100,
        messages: [
          {
            role: 'system',
            content: `Analiza el mensaje del cliente y decide si está pidiendo, proponiendo o preguntando por una cita/horario en un día y hora concretos (no cuenta solo preguntar "qué días atienden" sin mencionar un día específico). Hoy es ${nowLabel} (zona horaria ${timezone}) — resuelve referencias relativas ("hoy", "mañana", "el viernes", etc.) usando esa fecha. Responde SOLO con JSON: {"solicita_horario": true|false, "fecha": "YYYY-MM-DD"|null, "hora": "HH:MM"|null}. "hora" en formato 24h; si menciona el día pero no una hora concreta, deja "hora": null. Si no hay fecha concreta, "solicita_horario": false y "fecha": null.`,
          },
          { role: 'user', content: combinedText },
        ],
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}')
    if (!parsed?.solicita_horario || !parsed?.fecha) return null
    return { fecha: parsed.fecha, hora: parsed.hora || null }
  } catch (e) {
    console.error('extractAppointmentSlot: error inesperado:', e)
    return null
  }
}

// Decide en código (no en el modelo) si una fecha+hora concreta está
// disponible: dentro de horario de atención Y sin choque en Google Calendar.
async function checkRequestedSlot(
  fecha: string,
  hora: string,
  calendarToken: string,
  timezone: string,
  hours: any,
): Promise<string> {
  const atDate = new Date(fechaHoraToUtcIso(fecha, hora + ':00', timezone))
  const within = isWithinBusinessHours(hours, timezone, atDate)

  if (within === false) {
    const dayKey = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(atDate).toLowerCase().slice(0, 3)
    const h = hours?.[dayKey]
    const windowTxt = (!h || h.closed || !h.open || !h.close)
      ? 'el negocio no atiende ese día'
      : `el horario de atención ese día es de ${h.open} a ${h.close}`
    return `${hora} del ${fecha}: FUERA DE HORARIO (${windowTxt}).`
  }

  try {
    const timeMin = fechaHoraToUtcIso(fecha, '00:00:00', timezone)
    const timeMax = fechaHoraToUtcIso(fecha, '23:59:59', timezone)
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${calendarToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin, timeMax, timeZone: timezone, items: [{ id: 'primary' }] }),
    })
    if (!res.ok) return `${hora} del ${fecha}: no se pudo verificar el calendario (error ${res.status}) — de todos modos está dentro del horario de atención.`
    const data = await res.json()
    const busy: { start: string; end: string }[] = data.calendars?.primary?.busy ?? []
    const slotStart = atDate.getTime()
    const slotEnd = slotStart + 60 * 60 * 1000
    const overlap = busy.find(b => new Date(b.start).getTime() < slotEnd && new Date(b.end).getTime() > slotStart)
    if (overlap) return `${hora} del ${fecha}: OCUPADO — ya hay algo agendado en ese horario, propón otra hora.`
    return `${hora} del ${fecha}: DISPONIBLE (dentro de horario y sin citas registradas en ese momento).`
  } catch (e) {
    return `${hora} del ${fecha}: no se pudo verificar el calendario (${(e as Error).message}) — de todos modos está dentro del horario de atención.`
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
  conversationId: string,
  hours: any,
): Promise<string> {
  const duracion = args.duracion_minutos || 60
  const scheduledAt = fechaHoraToUtcIso(args.fecha, args.hora, timezone)
  const endAt = new Date(new Date(scheduledAt).getTime() + duracion * 60000).toISOString()

  // El cliente puede escribir a cualquier hora, pero la CITA tiene que
  // caer dentro del horario de atención del negocio — no basta con que
  // el system_prompt se lo pida a GPT, aquí se rechaza de verdad.
  if (isWithinBusinessHours(hours, timezone, new Date(scheduledAt)) === false) {
    return `No se puede agendar el ${args.fecha} a las ${args.hora} porque está fuera del horario de atención del negocio. Consulta disponibilidad y propónle al cliente un horario dentro del horario configurado.`
  }

  // El nombre REAL del contacto siempre manda sobre lo que haya puesto el
  // modelo — nunca se guarda un nombre genérico inventado ("Cliente", etc.)
  // como si fuera el nombre real. Si no hay nombre real ni uno válido en
  // args.nombre, se rechaza el agendado para que el bot primero lo pregunte.
  const GENERIC_NAME_REGEX = /^(cliente|sin nombre|n\/?a|desconocido|cliente de whatsapp|whatsapp)$/i
  const { data: contactNameRow } = await sb.from('contacts').select('name, phone').eq('id', contactId).maybeSingle()
  const realName = (contactNameRow?.name || '').trim()
  const contactPhone = contactNameRow?.phone || ''
  const providedName = (args.nombre || '').trim()

  let finalName: string
  if (realName) {
    finalName = realName
  } else if (providedName && !GENERIC_NAME_REGEX.test(providedName)) {
    finalName = providedName
    // Se guarda en el contacto para que la próxima vez ya se sepa su nombre.
    await sb.from('contacts').update({ name: finalName, updated_at: new Date().toISOString() }).eq('id', contactId)
  } else {
    return 'No se puede agendar todavía: no tienes el nombre completo del cliente. Pregúntaselo primero y vuelve a intentar el agendado cuando te lo diga — no uses un nombre genérico como "Cliente".'
  }

  // Guardar en DB — las citas agendadas por el bot quedan "pending": las
  // confirma el negocio, no quedan como confirmadas automáticamente.
  const { data: appt, error: apptErr } = await sb
    .from('appointments')
    .insert({
      organization_id: organizationId,
      contact_id:      contactId,
      contact_name:    finalName,
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
        summary:     `${args.servicio} — ${finalName}`,
        description: `Cita agendada por WhatsApp vía Avaxon.\nTeléfono: ${contactPhone || 'sin teléfono'}`,
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
    } else {
      const errData = await eventRes.json().catch(() => ({}))
      await logBotError(sb, {
        organization_id: organizationId, conversation_id: conversationId,
        type: 'calendar_failed', error_code: String(eventRes.status),
        detail: `No se pudo crear el evento en Google Calendar para la cita ${appt.id}: ${JSON.stringify(errData)}`,
        source: 'webhook-wa:agendar_cita',
      })
    }
  } catch (e) {
    // Se sigue devolviendo la cita como agendada (ya quedó en nuestra BD) —
    // solo el evento de Google falló, no la cita en sí.
    await logBotError(sb, {
      organization_id: organizationId, conversation_id: conversationId,
      type: 'calendar_failed', detail: `Error creando evento en Google Calendar para la cita ${appt.id}: ${(e as Error).message}`,
      source: 'webhook-wa:agendar_cita',
    })
  }

  return `Cita agendada correctamente. ID: ${appt.id}. Fecha: ${args.fecha} a las ${args.hora}. Servicio: ${args.servicio}. ${googleEventId ? 'Evento creado en Google Calendar.' : ''}`
}

// ── Herramienta: cancelar o reagendar ────────────────────────────────────────
async function cancelarOReagendarCita(
  args: { appointment_id: string; nueva_fecha?: string; nueva_hora?: string },
  organizationId: string,
  sb: ReturnType<typeof createClient>,
  calendarToken: string,
  timezone: string,
  conversationId: string,
  hours: any,
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
    // Misma regla que al agendar por primera vez: la nueva hora tiene que
    // caer dentro del horario de atención, sin importar a qué hora se pida.
    if (isWithinBusinessHours(hours, timezone, new Date(newScheduledAt)) === false) {
      return `No se puede reagendar al ${args.nueva_fecha} a las ${args.nueva_hora} porque está fuera del horario de atención del negocio. Consulta disponibilidad y propónle al cliente un horario dentro del horario configurado.`
    }
    // Reagendar por el bot también deja la cita "pending" — requiere
    // reconfirmación del negocio, igual que al agendarla por primera vez.
    await sb.from('appointments')
      .update({ scheduled_at: newScheduledAt, status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', appt.id)

    if (appt.google_event_id) {
      const duracion = 60
      const endAt = new Date(new Date(newScheduledAt).getTime() + duracion * 60000).toISOString()
      try {
        const patchRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${appt.google_event_id}`,
          {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${calendarToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              start: { dateTime: newScheduledAt, timeZone: timezone },
              end:   { dateTime: endAt, timeZone: timezone },
            }),
          },
        )
        if (!patchRes.ok) {
          const errData = await patchRes.json().catch(() => ({}))
          await logBotError(sb, {
            organization_id: organizationId, conversation_id: conversationId,
            type: 'calendar_failed', error_code: String(patchRes.status),
            detail: `No se pudo reagendar el evento de Google Calendar de la cita ${appt.id}: ${JSON.stringify(errData)}`,
            source: 'webhook-wa:reagendar_cita',
          })
        }
      } catch (e) {
        await logBotError(sb, {
          organization_id: organizationId, conversation_id: conversationId,
          type: 'calendar_failed', detail: `Error reagendando evento de Google Calendar de la cita ${appt.id}: ${(e as Error).message}`,
          source: 'webhook-wa:reagendar_cita',
        })
      }
    }
    await notifyAppointment(sb, appt.id, 'rescheduled', 'whatsapp')
    return `Cita reagendada para el ${args.nueva_fecha} a las ${args.nueva_hora}.`
  } else {
    await sb.from('appointments')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', appt.id)

    if (appt.google_event_id) {
      try {
        const delRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${appt.google_event_id}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${calendarToken}` } },
        )
        // 410/404 = Google ya no tiene el evento (borrado antes, etc.) — no es
        // una falla real, la cita de todos modos ya quedó cancelada en la BD.
        if (!delRes.ok && delRes.status !== 404 && delRes.status !== 410) {
          const errData = await delRes.json().catch(() => ({}))
          await logBotError(sb, {
            organization_id: organizationId, conversation_id: conversationId,
            type: 'calendar_failed', error_code: String(delRes.status),
            detail: `No se pudo borrar el evento de Google Calendar de la cita ${appt.id}: ${JSON.stringify(errData)}`,
            source: 'webhook-wa:cancelar_cita',
          })
        }
      } catch (e) {
        await logBotError(sb, {
          organization_id: organizationId, conversation_id: conversationId,
          type: 'calendar_failed', detail: `Error borrando evento de Google Calendar de la cita ${appt.id}: ${(e as Error).message}`,
          source: 'webhook-wa:cancelar_cita',
        })
      }
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
  conversationId: string,
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
    .ilike('name', `%${args.producto.trim()}%`)

  const product = products?.[0]
  if (!product) {
    const { data: allProducts } = await sb
      .from('products')
      .select('name')
      .eq('organization_id', organizationId)
      .neq('status', 'agotado')
      .order('name')
    const catalogList = (allProducts ?? []).map(p => p.name).join(', ')

    // Avisa al dueño por correo directamente (no por notify_owner) — esto NO
    // debe pausar al bot ni marcar la conversación como "necesita humano".
    // El bot sigue contestando normal; la pausa total es solo para cuando el
    // cliente pide explícitamente hablar con una persona.
    notifyOwnerAlert(
      sb, organizationId, conversationId,
      '⚠️ Un cliente pidió cobrar algo fuera del catálogo',
      `El cliente pidió pagar "${args.producto}", que no está en el catálogo (Inventario).`,
    )

    return catalogList
      ? `"${args.producto}" no está en el catálogo (o está agotado) — NO inventes un precio ni crees un link. Dile al cliente que eso no está disponible, pero que sí puedes cobrarle: ${catalogList}. Si de verdad quiere algo que no está en esa lista, dile que un asesor le confirmará el monto. NO actives notify_owner por esto — ya se le avisó al dueño automáticamente y esto no debe pausar la conversación.`
      : `No hay ningún producto/servicio configurado todavía para cobro automático — NO inventes un precio ni crees un link. Dile al cliente que un asesor le confirmará el monto. NO actives notify_owner por esto — ya se le avisó al dueño automáticamente y esto no debe pausar la conversación.`
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
      await logBotError(sb, {
        organization_id: organizationId, conversation_id: conversationId,
        type: 'payment_link_failed', detail: `Error guardando el payment en la base: ${insErr?.message ?? 'desconocido'}`,
        source: 'webhook-wa:crear_link_pago',
      })
      return 'Hubo un error guardando el cobro. Dile al cliente que un asesor le ayudará con el pago.'
    }

    const amountFmt = amount.toLocaleString('es-MX', { minimumFractionDigits: 2 })
    const shortUrl = `https://avaxon.lat/p/${payment.id}`
    return `Link de pago creado correctamente. Dile al cliente: "Aquí tienes tu link de pago por *${product.name}* ($${amountFmt} MXN): ${shortUrl}"`
  } catch (e) {
    console.error('Error creando Checkout Session (bot):', e)
    await logBotError(sb, {
      organization_id: organizationId, conversation_id: conversationId,
      type: 'payment_link_failed', detail: `Error con Stripe creando el checkout session: ${(e as Error).message}`,
      source: 'webhook-wa:crear_link_pago',
    })
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

// null = el negocio no configuró horarios (no se puede saber si está abierto).
// `at` por defecto es ahora — pero también se usa con la hora de una cita
// que se quiere agendar, para no dejar agendar fuera de horario aunque se
// pida a cualquier hora (ver agendarCita/cancelarOReagendarCita).
function isWithinBusinessHours(hours: any, timezone: string, at: Date = new Date()): boolean | null {
  if (!hours || typeof hours !== 'object') return null
  const hasAny = DAY_ORDER.some(d => hours[d] && !hours[d].closed && hours[d].open && hours[d].close)
  if (!hasAny) return null

  const dayKey = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(at).toLowerCase().slice(0, 3)
  const h = hours[dayKey]
  if (!h || h.closed || !h.open || !h.close) return false

  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  // "00:00" como cierre significa medianoche = fin del día (24:00), no el
  // inicio — si no, "09:00–00:00" se compara como cerrado todo el día.
  const closeCmp = h.close === '00:00' ? '24:00' : h.close
  return hhmm >= h.open && hhmm <= closeCmp
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

  // ── Track campaign reply (responded_at) ────────────────────────────────────
  const normalizedFrom = fromPhone.startsWith('+') ? fromPhone : '+' + fromPhone
  const { data: ccReply } = await sb
    .from('campaign_contacts')
    .select('id, campaign_id')
    .eq('phone', normalizedFrom)
    .is('responded_at', null)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (ccReply) {
    const now = new Date().toISOString()
    await sb.from('campaign_contacts').update({ responded_at: now }).eq('id', ccReply.id)
    const { data: camp } = await sb.from('campaigns').select('responded_count').eq('id', ccReply.campaign_id).single()
    if (camp) await sb.from('campaigns').update({ responded_count: (camp.responded_count ?? 0) + 1, updated_at: now }).eq('id', ccReply.campaign_id)
  }

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
  let botResumedBefore = false
  let humanPauseActive = false
  const { data: existing } = await sb
    .from('conversations')
    .select('id, needs_human, bot_resumed_at, human_pause_until')
    .eq('organization_id', organization_id)
    .eq('contact_id', contact_row.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) {
    conversation_id = existing.id
    needsHumanBefore = !!existing.needs_human
    botResumedBefore = !!existing.bot_resumed_at
    humanPauseActive = !!existing.human_pause_until && new Date(existing.human_pause_until as string).getTime() > Date.now()
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

  // ── 4a. Horario y zona horaria de la org ────────────────────────────────
  // Se necesitan ya aquí (antes de la bandeja de atención humana) para
  // saber si hay que avisar "fuera de horario" al escalar con una persona.
  // Siempre se resuelve la zona horaria real de la org (no solo cuando hay
  // Calendar conectado) — la necesita el bot para interpretar "hoy"/"mañana"
  // y para convertir bien la hora que da el cliente a UTC al agendar.
  const { data: orgProfile } = await sb
    .from('organization_profile')
    .select('description, phone, whatsapp, email, website, address, maps_url, hours, social')
    .eq('organization_id', organization_id)
    .maybeSingle()
  const { data: orgRow } = await sb
    .from('organizations')
    .select('timezone')
    .eq('id', organization_id)
    .maybeSingle()
  const timezone  = orgRow?.timezone || 'America/Matamoros'
  const outOfHours = isWithinBusinessHours(orgProfile?.hours, timezone) === false

  // ── 4b. Bandeja de atención humana ──────────────────────────────────────
  // Si la conversación YA necesitaba humano Y nadie la retomó por timeout
  // (ver resume-paused-conversations), el bot se queda callado (el mensaje
  // de arriba ya se guardó, así que sigue viéndose en el dashboard) hasta
  // que alguien la marque "atendida". Si el cliente lo pide apenas ahora en
  // este turno, se marca, se manda un acuse fijo (no depende de que el
  // system_prompt de la org sepa manejar esto) y tampoco se llama a GPT.
  if (needsHumanBefore && !botResumedBefore) return

  // Alguien del equipo escribió manualmente hace poco (send-message marca
  // human_pause_until) — el bot se queda calladito un rato aunque needs_human
  // ya esté en false, para no pisarle la conversación a la persona mientras
  // sigue escribiendo. Se retoma solo, sin aviso, cuando el plazo pasa.
  if (humanPauseActive) return

  // El bot NUNCA deja de contestar por el horario del negocio (la landing
  // promete 24/7) — el horario solo afecta el texto de este acuse cuando el
  // cliente pide explícitamente hablar con alguien, y a qué horas se puede
  // agendar una cita (ver agendarCita/cancelarOReagendarCita). Después de
  // este acuse NO se corta la conversación: sigue al bot IA para que ayude
  // con lo demás que haya preguntado en el mismo mensaje.
  if (HUMAN_HANDOFF_REGEX.test(incomingBatchText)) {
    await flagNeedsHuman(sb, conversation_id, organization_id, 'El cliente pidió hablar con alguien')
    const ackText = outOfHours
      ? 'Ya anoté tu solicitud — ahorita estamos fuera de nuestro horario de atención, pero en cuanto abramos una persona de nuestro equipo te contesta por aquí mismo. Mientras tanto, sigo aquí para ayudarte en lo que pueda. 🙌'
      : 'Ya anoté tu solicitud — en un momento una persona de nuestro equipo te atiende por aquí mismo. 🙌'
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
  }

  // ── 5. Bot IA (solo si está habilitado) ────────────────────────────────────
  const { data: botConfig } = await sb
    .from('bot_configs')
    .select('system_prompt, enabled')
    .eq('organization_id', organization_id)
    .eq('enabled', true)
    .maybeSingle()

  if (!botConfig) return

  const businessContext = buildBusinessContextBlock(orgProfile)

  // ── 6. Google Calendar (si está conectado) ──────────────────────────────
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
      catalogCtx = `\n\nCATÁLOGO (Inventario — estos son los ÚNICOS productos/servicios para los que puedes generar un link de pago, con el precio exacto de aquí):\n${lines.join('\n')}\n\nCuando el cliente quiera pagar algo de esta lista, usa la herramienta crear_link_pago con el nombre EXACTO del producto. Si pide algo que NO está en esta lista, o un monto libre/personalizado/"lo que sea", NUNCA inventes un precio ni uses la herramienta — dile qué sí puedes cobrar de la lista, y que si de verdad quiere algo fuera de catálogo un asesor le confirmará el monto. NO actives notify_owner por esto — un cobro fuera de catálogo no pausa la conversación, solo se avisa al dueño automáticamente; sigue contestando normal.`
    } else {
      catalogCtx = `\n\nSin catálogo configurado: no tienes ningún producto/servicio con precio para generar links de pago. Si el cliente pide pagar algo, dile que un asesor le confirmará el monto. NO actives notify_owner por esto — no pausa la conversación, solo se avisa al dueño automáticamente; sigue contestando normal. Nunca inventes un precio ni generes un link.`
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
    ? `\n\nCALENDARIO ACTIVO: Puedes consultar disponibilidad y agendar citas usando las herramientas disponibles. Ahora mismo es ${todayLabel}, ${nowTimeLabel} (zona horaria ${timezone}) — usa esta fecha y hora, en esta zona, para interpretar expresiones relativas como "hoy", "mañana" o "en una hora". Cada vez que el cliente pida o pregunte por una cita, vuelve a evaluar la disponibilidad y el horario DESDE CERO en este mismo turno (usa consultar_disponibilidad y compara contra "Horarios de atención" de arriba) — NUNCA copies ni repitas una respuesta de disponibilidad u horario que diste antes en esta conversación sin volver a verificarla: el horario pudo haber cambiado, y repetir un rechazo viejo sin revisarlo puede contradecir el horario actual. Cuando el cliente quiera agendar: 1) Consulta disponibilidad. 2) Propón horarios libres dentro del horario de atención del negocio.${hoursGuardrail} 3) Confirma con el cliente fecha, hora y servicio explícitamente. 4) Agénda solo tras esa confirmación — si propones o confirmas una hora fuera del horario de atención, la herramienta la va a rechazar. Las citas que agendas quedan pendientes de confirmación por el negocio, no confirmadas automáticamente — puedes decírselo al cliente.${hasBusinessHours ? ' NUNCA propongas, menciones como posible ni aceptes un día u hora fuera del horario de atención del negocio (ver "Horarios de atención" arriba) en NINGÚN momento de la conversación, aunque el cliente la pida o insista — ni siquiera como opción tentativa. Si pide un horario fuera de eso: 1) Dile explícitamente los días y horas reales de atención (ej. "atendemos martes a jueves de 9:00 a 12:00", agrupando días consecutivos con el mismo horario — usa la lista de "Horarios de atención" de arriba). 2) Usa consultar_disponibilidad en ESTE MISMO turno para ese día u otro día de atención próximo, y ofrécele 2 o 3 horarios concretos ya disponibles (ej. "tengo libre el martes a las 9:00, 10:00 o 11:00"). NUNCA respondas solo con una pregunta abierta como "¿te gustaría otro horario?" sin antes decir el horario real y ofrecer opciones concretas.' : ''}`
    : ''

  // Respondes 24/7 sin importar el horario — esto solo le avisa al modelo
  // que ahorita el negocio está cerrado, para que sea honesto si necesita
  // escalar con una persona (notify_owner), en vez de prometer que alguien
  // le contesta "en un momento" a media noche.
  const outOfHoursCtx = (hasBusinessHours && outOfHours)
    ? `\n\nFUERA DE HORARIO AHORA: según el horario configurado, el negocio está cerrado en este momento (${todayLabel}, ${nowTimeLabel}). Sigue respondiendo y ayudando normalmente — nunca dejes de contestar por esto, y nunca le digas al cliente que "no puedes atenderlo" por el horario. Si decides activar notify_owner porque el cliente necesita que una persona del equipo le atienda, acláraselo en tu propio texto: que el negocio está fuera de horario ahorita y que una persona le escribe en cuanto abran — no prometas que alguien le contesta "en un momento".`
    : ''

  // Regla global, siempre activa: nunca prometer una acción futura sin haberla
  // hecho ya en este mismo turno (p. ej. "voy a verificar, un momento") —
  // o se usa la herramienta correspondiente AHORA y se da el resultado real,
  // o simplemente no se menciona que se va a revisar/checar nada.
  const noPromisesCtx = `\n\nNUNCA prometas que vas a hacer algo después ("voy a verificar y te digo", "dame un momento para checar", "en un rato te confirmo"). Si necesitas información de una herramienta (disponibilidad, precio, estado de una cita, etc.), úsala en este mismo turno y responde con el resultado real. Si no puedes resolverlo ahora, no menciones que lo vas a revisar — responde con lo que sí sabes, o activa notify_owner para que una persona del equipo lo atienda.`

  // WhatsApp no renderiza markdown de links ni encabezados — si el bot escribe
  // "[texto](url)" o "# título" se ven los corchetes/almohadillas tal cual.
  const formatCtx = `\n\nFORMATO DE WHATSAPP (obligatorio en TODOS tus mensajes): WhatsApp no soporta markdown de links ni encabezados. Nunca escribas un link como "[texto](url)" — manda la URL sola y tal cual, sin corchetes ni paréntesis alrededor. Nunca uses "#" para títulos. Para negritas usa *un asterisco* (nunca **dos**), para cursiva usa _un guion bajo_. No uses tablas ni bloques de código con backticks.`

  const systemPrompt = [
    botConfig.system_prompt,
    businessContext,
    calendarCtx,
    catalogCtx,
    outOfHoursCtx,
    noPromisesCtx,
    formatCtx,
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

  // Solo los mensajes recientes forman el turno actual; los atrasados (de hace rato)
  // se marcan como procesados pero quedan en el historial como contexto normal —
  // nunca se retoman como si fueran la solicitud actual, salvo que el cliente los repita.
  const STALE_THRESHOLD_MS = 15 * 60 * 1000
  const newestAt = new Date(pending[pending.length - 1].created_at).getTime()
  let current = pending.filter(m => newestAt - new Date(m.created_at).getTime() <= STALE_THRESHOLD_MS)
  if (current.length === 0) current = [pending[pending.length - 1]]

  const batchIds      = current.map(m => m.id)
  const allPendingIds  = pending.map(m => m.id)
  const combinedText  = current.map(m => m.content).join('\n')

  // ── 10. Historial previo + turno actual ────────────────────────────────────
  const batchIdSet = new Set(batchIds)
  const { data: historyRaw } = await sb
    .from('messages')
    .select('id, direction, content, sent_by')
    .eq('conversation_id', conversation_id)
    .order('created_at', { ascending: false })
    .limit(14 + allPendingIds.length)

  const chatHistory: any[] = (historyRaw ?? [])
    .filter(m => !batchIdSet.has(m.id))
    // Los mensajes que mandó un humano del equipo (sent_by) no son del bot — nunca se le
    // muestran como si fueran compromisos u ofrecimientos que él mismo hizo.
    .filter(m => !(m.direction === 'outbound' && m.sent_by))
    // Las respuestas viejas del bot rechazando un horario se quitan del historial —
    // si no, el modelo copia la CONCLUSIÓN de un rechazo pasado en vez de volver a
    // evaluarla, y el horario pudo haber cambiado desde entonces.
    .filter(m => !(m.direction === 'outbound' && BOT_SCHEDULE_REJECTION_REGEX.test(m.content)))
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

  // ── 10b. Disponibilidad forzada en código ──────────────────────────────────
  // No depende de que el modelo decida llamar la herramienta: si el mensaje
  // pide una fecha+hora concreta, el CÓDIGO extrae esa fecha/hora y decide
  // disponibilidad (horario + Google Calendar) ANTES de generar la respuesta,
  // y se la pasa al modelo como dato obligatorio que no puede contradecir.
  let forcedAvailabilityCtx = ''
  if (calendarToken) {
    const slot = await extractAppointmentSlot(combinedText, `${todayLabel}, ${nowTimeLabel}`, timezone, OPENAI_KEY)
    if (slot?.fecha && slot.hora) {
      const result = await checkRequestedSlot(slot.fecha, slot.hora, calendarToken, timezone, orgProfile?.hours)
      forcedAvailabilityCtx = `\n\nDISPONIBILIDAD YA VERIFICADA PARA LO QUE PIDE EL CLIENTE EN ESTE MENSAJE (dato real del calendario y el horario, obtenido en este mismo turno — NO lo contradigas, NO copies una conclusión distinta de respuestas anteriores, básate solo en esto): ${result}`
    }
  }

  // ── 11. Loop GPT-4o con function calling ───────────────────────────────────
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
  ]
  if (forcedAvailabilityCtx) messages.push({ role: 'system', content: forcedAvailabilityCtx })

  const toolsArr = [
    ...(calendarToken ? APPOINTMENT_TOOLS : []),
    ...(stripeConnected ? PAYMENT_TOOLS : []),
  ]
  const tools = toolsArr.length > 0 ? toolsArr : undefined
  let rawReply = ''
  let paymentLinkUrl: string | null = null
  const MAX_TOOL_LOOPS = 5

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    let aiRes: Response
    try {
      aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
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
    } catch (e) {
      console.error('Error de red llamando a OpenAI:', e)
      await logBotError(sb, {
        organization_id, conversation_id, type: 'model_error',
        detail: `Error de red llamando a OpenAI: ${(e as Error).message}`, source: 'webhook-wa:openai',
      })
      break
    }

    const aiData  = await aiRes.json().catch(() => ({}))
    const choice  = aiData.choices?.[0]
    const message = choice?.message

    if (!aiRes.ok || !message) {
      console.error('GPT no devolvió mensaje:', JSON.stringify(aiData))
      await logBotError(sb, {
        organization_id, conversation_id, type: 'model_error',
        error_code: !aiRes.ok ? String(aiRes.status) : (aiData?.error?.code ?? null),
        detail: `OpenAI no devolvió una respuesta usable: ${JSON.stringify(aiData).slice(0, 1500)}`,
        source: 'webhook-wa:openai',
      })
      break
    }

    if (choice.finish_reason === 'tool_calls' && message.tool_calls?.length) {
      messages.push(message) // assistant message con tool_calls

      for (const toolCall of message.tool_calls) {
        let toolResult: string
        try {
          const args = JSON.parse(toolCall.function.arguments)
          if (toolCall.function.name === 'consultar_disponibilidad') {
            toolResult = await consultarDisponibilidad(args.fecha, calendarToken!, timezone, orgProfile?.hours)
          } else if (toolCall.function.name === 'agendar_cita') {
            toolResult = await agendarCita(args, organization_id, contact_row.id, sb, calendarToken!, timezone, conversation_id, orgProfile?.hours)
            sendZapierEvent(sb, organization_id, 'appointment_booked', {
              contact_name:  args.nombre,
              contact_phone: fromPhone,
              service:       args.servicio,
              fecha:         args.fecha,
              hora:          args.hora,
            })
          } else if (toolCall.function.name === 'cancelar_o_reagendar_cita') {
            toolResult = await cancelarOReagendarCita(args, organization_id, sb, calendarToken!, timezone, conversation_id, orgProfile?.hours)
          } else if (toolCall.function.name === 'crear_link_pago') {
            toolResult = await crearLinkPago(args, organization_id, contact_row.id, sb, env.STRIPE_SECRET_KEY, conversation_id)
            const urlMatch = toolResult.match(/https:\/\/avaxon\.lat\/p\/[a-zA-Z0-9-]+/)
            if (urlMatch) paymentLinkUrl = urlMatch[0]
          } else {
            toolResult = 'Herramienta no reconocida.'
          }
        } catch (e) {
          toolResult = `Error ejecutando la herramienta: ${(e as Error).message}`
          await logBotError(sb, {
            organization_id: organization_id, conversation_id: conversation_id,
            type: 'edge_function_500', detail: `Falla inesperada ejecutando ${toolCall.function.name}: ${(e as Error).message}`,
            source: 'webhook-wa:tool_call',
          })
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
    // markdown de links "[texto](url)" -> solo la URL suelta (WhatsApp no lo renderiza)
    .replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '$2')
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
  // Si esta respuesta trae el link de pago que se generó en este turno, se manda
  // como botón de URL nativo de WhatsApp (cta_url) en vez de un link suelto en el texto.
  let waPayload: any
  if (paymentLinkUrl && replyText.includes(paymentLinkUrl)) {
    // Se reemplaza la URL por una frase (no se borra a secas) para no dejar
    // huecos como "($300.00 MXN): . Si necesitas..." cuando hay texto después
    // del link — y si queda un ":" o "-" pegado justo antes, se cambia a ".".
    const bodyText = replyText
      .replace(paymentLinkUrl, 'Toca el botón para pagar')
      .replace(/[:\-–—]\s*(Toca el botón para pagar)/, '. $1')
      .replace(/\s{2,}/g, ' ')
      .trim()
      || 'Toca el botón para pagar.'
    waPayload = {
      messaging_product: 'whatsapp',
      to:   fromPhone,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: bodyText },
        action: {
          name:       'cta_url',
          parameters: { display_text: 'Pagar ahora', url: paymentLinkUrl },
        },
      },
    }
  } else if (buttonLabels.length > 0) {
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
  const waData = await waRes.json().catch(() => ({}))
  if (!waRes.ok) {
    console.error('Meta rechazó la respuesta del bot:', JSON.stringify(waData))
    await logBotError(sb, {
      organization_id, conversation_id, type: 'meta_rejected',
      error_code: String(waData?.error?.code ?? waRes.status),
      detail: `Meta rechazó la respuesta del bot: ${JSON.stringify(waData).slice(0, 1500)}`,
      source: 'webhook-wa:send_reply',
    })
  }

  // ── 14. Marcar como procesados todos los pendientes (actuales y atrasados) ─
  await sb.from('messages')
    .update({ processed_at: new Date().toISOString() })
    .in('id', allPendingIds)

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

  const change = body?.entry?.[0]?.changes?.[0]
  if (change?.field === 'message_template_status_update') {
    EdgeRuntime.waitUntil(handleTemplateStatusUpdate(change.value, env))
    return new Response('ok', { status: 200 })
  }

  // Delivery/read receipts for campaigns
  const statuses = change?.value?.statuses
  if (statuses?.length) {
    EdgeRuntime.waitUntil(handleStatuses(statuses, env).catch(e => console.error('handleStatuses error:', e)))
    return new Response('ok', { status: 200 })
  }

  EdgeRuntime.waitUntil(
    handleIncoming(body, env).catch(e => {
      console.error('handleIncoming: excepción no controlada:', e)
      const sb = createClient(env.SUPABASE_URL, env.SERVICE_KEY)
      return logBotError(sb, {
        type: 'edge_function_500',
        detail: `webhook-wa: excepción no controlada procesando el mensaje: ${(e as Error)?.message ?? e}`,
        source: 'webhook-wa:handleIncoming',
      })
    }),
  )
  return new Response('ok', { status: 200 })
})

// ── Estado real de una plantilla, directo de Meta ───────────────────────────
// Meta manda este evento cuando revisa una plantilla (APPROVED/REJECTED/
// PAUSED/DISABLED/…) — antes nada escuchaba esto y el estado en el dashboard
// se marcaba a mano. Ahora message_templates.status solo lo mueve Meta (este
// webhook) o la sincronización manual (ver sync-templates), nunca el equipo.
function cleanTemplateReason(reason: unknown): string | null {
  const r = typeof reason === 'string' ? reason.trim() : ''
  return r && r !== 'NONE' ? r : null
}

async function handleStatuses(statuses: any[], env: Env): Promise<void> {
  const sb = createClient(env.SUPABASE_URL, env.SERVICE_KEY)
  for (const s of statuses) {
    const status      = s.status       // 'sent' | 'delivered' | 'read' | 'failed'
    const recipientId = s.recipient_id // E.164 phone we sent to
    if (!recipientId || (status !== 'delivered' && status !== 'read')) continue

    const updateField = status === 'delivered' ? 'delivered_at' : 'read_at'
    const countField  = status === 'delivered' ? 'delivered_count' : 'read_count'
    const now = new Date().toISOString()

    const { data: cc } = await sb
      .from('campaign_contacts')
      .select('id, campaign_id')
      .eq('phone', recipientId)
      .eq('status', 'sent')
      .is(updateField, null)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!cc) continue

    await sb.from('campaign_contacts').update({ [updateField]: now }).eq('id', cc.id)

    const { data: camp } = await sb.from('campaigns').select(countField).eq('id', cc.campaign_id).single()
    if (camp) await sb.from('campaigns').update({ [countField]: ((camp as any)[countField] ?? 0) + 1, updated_at: now }).eq('id', cc.campaign_id)
  }
}

async function handleTemplateStatusUpdate(value: any, env: Env): Promise<void> {
  const newStatus = value?.event
  const metaId    = value?.message_template_id ? String(value.message_template_id) : null
  const name      = value?.message_template_name
  const language  = value?.message_template_language
  if (!newStatus || (!metaId && !name)) return

  const sb = createClient(env.SUPABASE_URL, env.SERVICE_KEY)
  const update = {
    status:          newStatus,
    rejected_reason: newStatus === 'REJECTED' ? cleanTemplateReason(value?.reason) : null,
    updated_at:       new Date().toISOString(),
  }

  let q = sb.from('message_templates').update(update)
  q = metaId ? q.eq('meta_template_id', metaId) : q.eq('name', name).eq('language', language)
  const { error } = await q
  if (error) console.error('handleTemplateStatusUpdate: error actualizando estado:', error)
}
