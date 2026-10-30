import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fechaHoraToUtcIso } from './timezone.ts'
import { notifyAppointment } from './appointmentEmail.ts'
import { logBotError } from './botErrorLog.ts'

// ── Herramientas de agenda (consultar disponibilidad / agendar / cancelar o
// reagendar) -- movido tal cual desde webhook-wa (sin cambiar su
// comportamiento) para que webhook-ig y webhook-fb puedan ofrecer el mismo
// agendamiento real por function-calling que ya tenía WhatsApp, en vez de
// solo texto libre sin ninguna herramienta de calendario.

export const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export const APPOINTMENT_TOOLS = [
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
          hora:     { type: 'string', description: 'Hora EXACTA con AM o PM explícito, formato "HH:MM AM/PM" (ej: "05:00 PM", "09:00 AM") — NUNCA uses formato 24h aquí. Si el cliente dijo la hora sin aclarar AM/PM y no puedes saberlo con certeza del historial (ej. porque tú mismo ya propusiste esa hora con AM o PM antes), PREGÚNTASELO antes de llamar esta función — nunca adivines ni asumas.' },
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
          nueva_hora:     { type: 'string', description: 'Nueva hora con AM o PM explícito, formato "HH:MM AM/PM" (ej: "03:00 PM") — solo para reagendar. Nunca uses formato 24h ni adivines AM/PM; si hay duda, pregúntale al cliente primero.' },
        },
        required: ['appointment_id'],
      },
    },
  },
]

// null = el negocio no configuró horarios (no se puede saber si está abierto).
// `at` por defecto es ahora — pero también se usa con la hora de una cita
// que se quiere agendar, para no dejar agendar fuera de horario aunque se
// pida a cualquier hora (ver agendarCita/cancelarOReagendarCita).
export function isWithinBusinessHours(hours: any, timezone: string, at: Date = new Date()): boolean | null {
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

// ── Herramienta: consultar disponibilidad ────────────────────────────────────
export async function consultarDisponibilidad(
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
export async function extractAppointmentSlot(
  combinedText: string,
  lastBotMessage: string,
  nowLabel: string,
  timezone: string,
  openaiKey: string,
): Promise<{ fecha: string; hora: string | null; horaAmbigua: boolean; horaAlt: string | null } | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0,
        max_tokens: 150,
        messages: [
          {
            role: 'system',
            content: `Analiza el mensaje del cliente y decide si está pidiendo, proponiendo, confirmando o preguntando por una cita/horario en un día y hora concretos (no cuenta solo preguntar "qué días atienden" sin mencionar un día específico). Hoy es ${nowLabel} (zona horaria ${timezone}) — resuelve referencias relativas ("hoy", "mañana", "el viernes", etc.) usando esa fecha.${lastBotMessage ? ` Si el mensaje del cliente es solo una CONFIRMACIÓN sin fecha/hora propia (ej. "sí", "confirmo", "agenda", o tocó un botón como "Agendar cita"), usa la fecha/hora que el bot ya había propuesto en su último mensaje: "${lastBotMessage.replace(/"/g, "'")}".` : ''} Responde SOLO con JSON: {"solicita_horario": true|false, "fecha": "YYYY-MM-DD"|null, "hora": "HH:MM"|null, "hora_ambigua": true|false, "hora_alt": "HH:MM"|null}. "hora" y "hora_alt" en formato 24h. Si el cliente dio un número de 1 a 11 SIN decir "de la mañana/tarde/noche" ni "am/pm" (ej. "a las 7"), es ambigua: "hora_ambigua": true, "hora" = esa hora interpretada como AM, y "hora_alt" = la misma hora interpretada como PM (+12h). Si especificó claramente AM/PM o mañana/tarde/noche, o es una hora de las 13 a 23 (ya sin ambigüedad posible), "hora_ambigua": false y "hora_alt": null. Si menciona o confirma el día pero no se puede determinar ninguna hora, deja "hora": null. Si no hay fecha concreta (ni propia ni confirmando la del bot), "solicita_horario": false y "fecha": null.`,
          },
          { role: 'user', content: combinedText },
        ],
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}')
    if (!parsed?.solicita_horario || !parsed?.fecha) return null
    return {
      fecha: parsed.fecha,
      hora: parsed.hora || null,
      horaAmbigua: !!parsed.hora_ambigua,
      horaAlt: parsed.hora_alt || null,
    }
  } catch (e) {
    console.error('extractAppointmentSlot: error inesperado:', e)
    return null
  }
}

// ── Helpers de hora: 12h↔24h y aritmética en minutos-del-día ────────────────
// Todo esto existe para que la conversión AM/PM nunca dependa de que el
// modelo la haga bien sola — un "5:00 PM" mal convertido a "05:00" fue
// justo la causa de que el bot dijera "las 5pm están fuera de horario".
function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + (m || 0)
}

function minutesTo24h(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function to12hLabel(hhmm24: string): string {
  const [h, m] = hhmm24.split(':').map(Number)
  const period = h < 12 ? 'a.m.' : 'p.m.'
  let h12 = h % 12
  if (h12 === 0) h12 = 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

// "00:00" de cierre = fin del día (24:00) — mismo criterio que isWithinBusinessHours.
function closeMinutesFor(h: { close: string }): number {
  return h.close === '00:00' ? 24 * 60 : minutesOfDay(h.close)
}

function toMinutesOfDayInZone(iso: string, timezone: string): number {
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
  return minutesOfDay(hhmm)
}

// Convierte "5:00 PM" / "05:00 pm" / "12:30 AM" → "17:00" / "17:00" / "00:30".
// Exige AM/PM explícito a propósito — null si no lo trae, para que quien
// llame esto rechace y le pregunte al cliente en vez de adivinar.
function parse12hTo24h(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((raw || '').trim())
  if (!m) return null
  let h = parseInt(m[1], 10)
  const mm = m[2]
  if (h < 1 || h > 12 || Number(mm) > 59) return null
  const mer = m[3].toUpperCase()
  h = mer === 'AM' ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12)
  return `${String(h).padStart(2, '0')}:${mm}`
}

// De los huecos libres de ese día, los `count` más cercanos a targetMin —
// para que las "alternativas" que ofrece el bot sean reales y cercanas a lo
// que pidió el cliente, no horarios fijos inventados o copiados de un ejemplo.
function findNearbySlots(
  targetMin: number,
  openMin: number,
  closeMin: number,
  busy: { startMin: number; endMin: number }[],
  durationMin: number,
  count: number,
): number[] {
  const candidates: number[] = []
  for (let m = openMin; m + durationMin <= closeMin; m += 30) {
    const overlap = busy.some(b => m < b.endMin && (m + durationMin) > b.startMin)
    if (!overlap) candidates.push(m)
  }
  candidates.sort((a, b) => Math.abs(a - targetMin) - Math.abs(b - targetMin))
  return candidates.slice(0, count).sort((a, b) => a - b)
}

// Decide en código (no en el modelo) si una fecha+hora concreta está
// disponible: dentro de horario de atención Y sin choque en Google Calendar.
// `ok` distingue claramente "sí se puede" de "no" para que agendarCita /
// cancelarOReagendarCita puedan usar esta MISMA función como su única
// validación, en vez de repetir la lógica cada una por su lado.
export async function checkRequestedSlot(
  fecha: string,
  hora: string, // "HH:MM" 24h, ya validada
  calendarToken: string,
  timezone: string,
  hours: any,
): Promise<{ ok: boolean; message: string }> {
  const DURATION = 60
  const atDate = new Date(fechaHoraToUtcIso(fecha, hora + ':00', timezone))
  const within = isWithinBusinessHours(hours, timezone, atDate)
  const dayKey = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(atDate).toLowerCase().slice(0, 3)
  const h = hours?.[dayKey]
  const label = to12hLabel(hora)
  const targetMin = minutesOfDay(hora)

  if (within === false && (!h || h.closed || !h.open || !h.close)) {
    return { ok: false, message: `${label} del ${fecha}: FUERA DE HORARIO — el negocio no atiende ese día. Propónle al cliente otro día de atención.` }
  }

  let busyMin: { startMin: number; endMin: number }[] = []
  let fetchError: string | null = null
  try {
    const timeMin = fechaHoraToUtcIso(fecha, '00:00:00', timezone)
    const timeMax = fechaHoraToUtcIso(fecha, '23:59:59', timezone)
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${calendarToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin, timeMax, timeZone: timezone, items: [{ id: 'primary' }] }),
    })
    if (!res.ok) {
      fetchError = `error ${res.status}`
    } else {
      const data = await res.json()
      const busyRaw: { start: string; end: string }[] = data.calendars?.primary?.busy ?? []
      busyMin = busyRaw.map(b => ({ startMin: toMinutesOfDayInZone(b.start, timezone), endMin: toMinutesOfDayInZone(b.end, timezone) }))
    }
  } catch (e) {
    fetchError = (e as Error).message
  }

  if (within === false) {
    const openMin = minutesOfDay(h.open)
    const closeMin = closeMinutesFor(h)
    const base = `${label} del ${fecha}: FUERA DE HORARIO (el horario de atención ese día es de ${h.open} a ${h.close}).`
    if (fetchError) return { ok: false, message: `${base} No se pudo consultar el calendario para sugerir horas (${fetchError}) — propónle al cliente un horario dentro de ese rango.` }
    const alt = findNearbySlots(targetMin, openMin, closeMin, busyMin, DURATION, 3).map(m => to12hLabel(minutesTo24h(m)))
    return {
      ok: false,
      message: alt.length
        ? `${base} Horarios disponibles más cercanos a lo que pidió ese día: ${alt.join(', ')}. Ofrécele EXACTAMENTE esas horas, no inventes otras.`
        : `${base} No hay huecos disponibles ese día — propónle otro día de atención.`,
    }
  }

  if (fetchError) {
    return { ok: true, message: `${label} del ${fecha}: no se pudo verificar el calendario (${fetchError}) — de todos modos está dentro del horario de atención.` }
  }

  const overlap = busyMin.some(b => targetMin < b.endMin && (targetMin + DURATION) > b.startMin)
  if (overlap) {
    // h puede no existir si el negocio no tiene horario configurado (within
    // === null, no false) — en ese caso no hay rango del que sugerir cercanas.
    const alt = (h && h.open && h.close)
      ? findNearbySlots(targetMin, minutesOfDay(h.open), closeMinutesFor(h), busyMin, DURATION, 3).map(m => to12hLabel(minutesTo24h(m)))
      : []
    return {
      ok: false,
      message: alt.length
        ? `${label} del ${fecha}: OCUPADO — ya hay algo agendado en ese horario. Horarios libres más cercanos: ${alt.join(', ')}. Ofrécele EXACTAMENTE esas horas, no inventes otras.`
        : `${label} del ${fecha}: OCUPADO — ya hay algo agendado en ese horario, propón otra hora.`,
    }
  }

  return { ok: true, message: `${label} del ${fecha}: DISPONIBLE (dentro de horario y sin citas registradas en ese momento).` }
}

// ── Herramienta: agendar cita ────────────────────────────────────────────────
export async function agendarCita(
  args: { fecha: string; hora: string; servicio: string; nombre: string; duracion_minutos?: number },
  organizationId: string,
  contactId: string,
  sb: ReturnType<typeof createClient>,
  calendarToken: string,
  timezone: string,
  conversationId: string,
  hours: any,
): Promise<string> {
  // La hora tiene que traer AM/PM explícito — nunca se adivina. Esto es lo
  // que de verdad causaba el bug "5pm fuera de horario": el modelo convertía
  // "5:00 p.m." a 24h él mismo y a veces lo mandaba como "05:00".
  const hora24 = parse12hTo24h(args.hora)
  if (!hora24) {
    return `La hora "${args.hora}" no viene en un formato claro con AM o PM. Pregúntale al cliente la hora exacta, aclarando si es de la mañana o de la tarde/noche, antes de agendar — nunca asumas ni adivines.`
  }
  const duracion = args.duracion_minutos || 60
  const scheduledAt = fechaHoraToUtcIso(args.fecha, hora24, timezone)
  const endAt = new Date(new Date(scheduledAt).getTime() + duracion * 60000).toISOString()

  // El cliente puede escribir a cualquier hora, pero la CITA tiene que caer
  // dentro del horario de atención Y estar libre en Google Calendar — misma
  // función que usa la verificación anticipada (ver checkRequestedSlot), así
  // nunca hay dos lógicas de validación que puedan desincronizarse.
  const slotCheck = await checkRequestedSlot(args.fecha, hora24, calendarToken, timezone, hours)
  if (!slotCheck.ok) {
    return `No se puede agendar: ${slotCheck.message} Usa EXACTAMENTE esa hora (${to12hLabel(hora24)}) al explicarle al cliente por qué no se pudo — no la reinterpretes ni la cambies por otra.`
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

  return `Cita agendada correctamente. ID: ${appt.id}. Fecha: ${args.fecha} a las ${to12hLabel(hora24)}. Servicio: ${args.servicio}. ${googleEventId ? 'Evento creado en Google Calendar.' : ''}`
}

// ── Herramienta: cancelar o reagendar ────────────────────────────────────────
export async function cancelarOReagendarCita(
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
    const nuevaHora24 = parse12hTo24h(args.nueva_hora!)
    if (!nuevaHora24) {
      return `La hora "${args.nueva_hora}" no viene en un formato claro con AM o PM. Pregúntale al cliente la hora exacta, aclarando si es de la mañana o de la tarde/noche, antes de reagendar — nunca asumas ni adivines.`
    }
    const newScheduledAt = fechaHoraToUtcIso(args.nueva_fecha!, nuevaHora24, timezone)
    // Misma regla y misma función que al agendar por primera vez: la nueva
    // hora tiene que caer dentro del horario de atención y estar libre.
    const slotCheck = await checkRequestedSlot(args.nueva_fecha!, nuevaHora24, calendarToken, timezone, hours)
    if (!slotCheck.ok) {
      return `No se puede reagendar: ${slotCheck.message} Usa EXACTAMENTE esa hora (${to12hLabel(nuevaHora24)}) al explicarle al cliente — no la reinterpretes ni la cambies por otra.`
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
    return `Cita reagendada para el ${args.nueva_fecha} a las ${to12hLabel(nuevaHora24)}.`
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

// ── Texto de sistema: calendario activo ─────────────────────────────────────
// Instrucciones de agenda que se inyectan al prompt -- movidas tal cual
// desde webhook-wa (antes construidas inline ahí).
export function buildCalendarCtx(params: {
  calendarToken: string | null
  todayLabel: string
  nowTimeLabel: string
  timezone: string
  hasBusinessHours: boolean
}): string {
  const { calendarToken, todayLabel, nowTimeLabel, timezone, hasBusinessHours } = params
  if (!calendarToken) return ''

  const hoursGuardrail = hasBusinessHours
    ? ''
    : ' No conoces el horario de atención del negocio (no está configurado) — NUNCA inventes ni asumas un horario. Si el cliente pregunta qué horarios hay disponibles para agendar, dile que un asesor del negocio le confirmará el horario exacto; no le propongas horas por tu cuenta.'

  return `\n\nCALENDARIO ACTIVO: Puedes consultar disponibilidad y agendar citas usando las herramientas disponibles. Ahora mismo es ${todayLabel}, ${nowTimeLabel} (zona horaria ${timezone}) — usa esta fecha y hora, en esta zona, para interpretar expresiones relativas como "hoy", "mañana" o "en una hora". Cada vez que el cliente pida o pregunte por una cita, vuelve a evaluar la disponibilidad y el horario DESDE CERO en este mismo turno (usa consultar_disponibilidad y compara contra "Horarios de atención" de arriba) — NUNCA copies ni repitas una respuesta de disponibilidad u horario que diste antes en esta conversación sin volver a verificarla: el horario pudo haber cambiado, y repetir un rechazo viejo sin revisarlo puede contradecir el horario actual. Cuando el cliente quiera agendar: 1) Consulta disponibilidad. 2) Propón horarios libres dentro del horario de atención del negocio.${hoursGuardrail} 3) Confirma con el cliente fecha, hora y servicio explícitamente. 4) Agénda solo tras esa confirmación — si propones o confirmas una hora fuera del horario de atención, la herramienta la va a rechazar. Las citas que agendas quedan pendientes de confirmación por el negocio, no confirmadas automáticamente — puedes decírselo al cliente.${hasBusinessHours ? ' NUNCA propongas, menciones como posible ni aceptes un día u hora fuera del horario de atención del negocio (ver "Horarios de atención" arriba) en NINGÚN momento de la conversación, aunque el cliente la pida o insista — ni siquiera como opción tentativa. Si pide un horario fuera de eso: 1) Dile explícitamente los días y horas reales de atención (ej. "atendemos martes a jueves de 9:00 a 12:00", agrupando días consecutivos con el mismo horario — usa la lista de "Horarios de atención" de arriba). 2) Usa consultar_disponibilidad en ESTE MISMO turno para ese día u otro día de atención próximo, y ofrécele 2 o 3 horarios REALES que la herramienta devuelva — los más cercanos a la hora que pidió el cliente, nunca horas fijas ni copiadas de un ejemplo. NUNCA respondas solo con una pregunta abierta como "¿te gustaría otro horario?" sin antes decir el horario real y ofrecer opciones concretas.' : ''}`
}

// ── Disponibilidad forzada en código ────────────────────────────────────────
// No depende de que el modelo decida llamar la herramienta: si el mensaje
// pide una fecha+hora concreta (o solo confirma una que el bot ya propuso),
// el CÓDIGO extrae esa fecha/hora y decide disponibilidad (horario + Google
// Calendar) ANTES de generar la respuesta, y se la pasa al modelo como dato
// obligatorio que no puede contradecir. Movido tal cual desde webhook-wa.
export async function buildForcedAvailabilityContext(params: {
  combinedText: string
  lastBotMessage: string
  todayLabel: string
  nowTimeLabel: string
  timezone: string
  openaiKey: string
  calendarToken: string | null
  hours: any
}): Promise<string> {
  const { combinedText, lastBotMessage, todayLabel, nowTimeLabel, timezone, openaiKey, calendarToken, hours } = params
  if (!calendarToken) return ''

  const slot = await extractAppointmentSlot(combinedText, lastBotMessage, `${todayLabel}, ${nowTimeLabel}`, timezone, openaiKey)
  if (!slot?.fecha || !slot.hora) return ''

  let resolvedHora = slot.hora
  let ambiguityNote = ''
  let forcedAvailabilityCtx = ''

  // "A las 7" sin AM/PM: si solo una de las dos interpretaciones cae dentro
  // del horario configurado, se asume esa (y se le pide al bot que la
  // confirme explícitamente) — solo se pregunta cuando de verdad hay dos
  // opciones viables (o ninguna).
  if (slot.horaAmbigua && slot.horaAlt) {
    const atA = new Date(fechaHoraToUtcIso(slot.fecha, slot.hora + ':00', timezone))
    const atB = new Date(fechaHoraToUtcIso(slot.fecha, slot.horaAlt + ':00', timezone))
    const withinA = isWithinBusinessHours(hours, timezone, atA)
    const withinB = isWithinBusinessHours(hours, timezone, atB)

    if (withinA === true && withinB !== true) {
      ambiguityNote = ` El cliente no dijo si era AM o PM — como ${to12hLabel(slot.horaAlt)} está fuera de horario y ${to12hLabel(slot.hora)} sí está dentro, ASUME ${to12hLabel(slot.hora)} pero DÍSELO explícitamente en tu respuesta (confírmale esa hora exacta) antes de agendar.`
    } else if (withinB === true && withinA !== true) {
      resolvedHora = slot.horaAlt
      ambiguityNote = ` El cliente no dijo si era AM o PM — como ${to12hLabel(slot.hora)} está fuera de horario y ${to12hLabel(slot.horaAlt)} sí está dentro, ASUME ${to12hLabel(slot.horaAlt)} pero DÍSELO explícitamente en tu respuesta (confírmale esa hora exacta) antes de agendar.`
    } else {
      forcedAvailabilityCtx = `\n\nHORA AMBIGUA: el cliente dijo una hora sin aclarar AM o PM, y tanto ${to12hLabel(slot.hora)} como ${to12hLabel(slot.horaAlt)} son posibles según el horario configurado. PREGÚNTALE explícitamente si es de la mañana o de la tarde/noche antes de ofrecer o confirmar cualquier horario — no asumas ni agendes todavía.`
    }
  }

  if (!forcedAvailabilityCtx) {
    const result = await checkRequestedSlot(slot.fecha, resolvedHora, calendarToken, timezone, hours)
    forcedAvailabilityCtx = `\n\nDISPONIBILIDAD YA VERIFICADA PARA LO QUE PIDE EL CLIENTE EN ESTE MENSAJE (dato real del calendario y el horario, obtenido en este mismo turno — NO lo contradigas, NO copies una conclusión distinta de respuestas anteriores, básate solo en esto): ${result.message}${ambiguityNote}`
  }

  return forcedAvailabilityCtx
}
