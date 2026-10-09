import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Encola recordatorios de citas (24h y 1h antes) ───────────────────────────
// Corre cada 15 minutos vía pg_cron.
// Busca citas confirmadas en el rango 22–26h (ventana 24h) y 45–75min (ventana 1h).
// Inserta en `reminders` con appointment_id + reminder_type para evitar duplicados
// (constraint unique en la tabla).
// El envío real lo hace send-reminders cada minuto.

const WINDOW_24H = { minMs: 22 * 60 * 60 * 1000, maxMs: 26 * 60 * 60 * 1000 }
const WINDOW_1H  = { minMs: 45 * 60 * 1000,       maxMs: 75 * 60 * 1000       }

function formatLocalTime(isoDate: string, timezone: string): string {
  try {
    return new Date(isoDate).toLocaleString('es-MX', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: timezone,
    })
  } catch {
    return isoDate
  }
}

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  const now = Date.now()

  // Rango de scheduled_at que cubre ambas ventanas: [45min, 26h] desde ahora.
  const rangeMin = new Date(now + WINDOW_1H.minMs).toISOString()
  const rangeMax = new Date(now + WINDOW_24H.maxMs).toISOString()

  const { data: appointments, error } = await sb
    .from('appointments')
    .select(`
      id, title, service, scheduled_at, contact_id, contact_name, organization_id,
      contacts!inner(phone),
      organizations!inner(timezone)
    `)
    .eq('status', 'confirmed')
    .gte('scheduled_at', rangeMin)
    .lte('scheduled_at', rangeMax)

  if (error) {
    console.error('Error leyendo appointments:', error.message)
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 })
  }

  if (!appointments?.length) {
    return new Response(JSON.stringify({ ok: true, scheduled: 0 }), { status: 200 })
  }

  // Obtener phone_number_id activo por org (1 por org).
  const orgIds = [...new Set(appointments.map(a => a.organization_id))]
  const { data: phoneNumbers } = await sb
    .from('phone_numbers')
    .select('organization_id, phone_number_id')
    .in('organization_id', orgIds)
    .eq('status', 'active')

  const orgPhoneMap = Object.fromEntries(
    (phoneNumbers ?? []).map(pn => [pn.organization_id, pn.phone_number_id])
  )

  let scheduled = 0

  for (const appt of appointments) {
    const phoneNumberId = orgPhoneMap[appt.organization_id]
    if (!phoneNumberId) continue

    const contactPhone = (appt.contacts as any)?.phone
    if (!contactPhone) continue

    const timezone = (appt.organizations as any)?.timezone || 'America/Matamoros'
    const scheduledMs = new Date(appt.scheduled_at).getTime()
    const diffMs = scheduledMs - now

    const serviceName = appt.service || appt.title || 'tu cita'
    const contactName = appt.contact_name || 'cliente'
    const timeLabel   = formatLocalTime(appt.scheduled_at, timezone)

    // ── Ventana 24h ──────────────────────────────────────────────────────────
    if (diffMs >= WINDOW_24H.minMs && diffMs <= WINDOW_24H.maxMs) {
      const sendAt = new Date(scheduledMs - 24 * 60 * 60 * 1000).toISOString()
      const message = `📅 *Recordatorio de cita — mañana*\n\nHola ${contactName}, te recordamos que tienes una cita mañana:\n\n*Servicio:* ${serviceName}\n*Fecha y hora:* ${timeLabel}\n\n¿Alguna duda? Escríbenos aquí. ✅`

      const { error: insErr } = await sb.from('reminders').insert({
        appointment_id:  appt.id,
        reminder_type:   '24h',
        send_at:         sendAt,
        to_phone:        contactPhone,
        message,
        phone_number_id: phoneNumberId,
      })
      // error 23505 = ya existe (unique constraint) — no es error real
      if (!insErr || insErr.code === '23505') {
        if (!insErr) scheduled++
      } else {
        console.error(`Error encolando recordatorio 24h para cita ${appt.id}:`, insErr.message)
      }
    }

    // ── Ventana 1h ───────────────────────────────────────────────────────────
    if (diffMs >= WINDOW_1H.minMs && diffMs <= WINDOW_1H.maxMs) {
      const sendAt = new Date(scheduledMs - 60 * 60 * 1000).toISOString()
      const message = `⏰ *Tu cita es en 1 hora*\n\nHola ${contactName}, en 1 hora tienes:\n\n*Servicio:* ${serviceName}\n*Hora:* ${timeLabel}\n\n¡Te esperamos! 🙌`

      const { error: insErr } = await sb.from('reminders').insert({
        appointment_id:  appt.id,
        reminder_type:   '1h',
        send_at:         sendAt,
        to_phone:        contactPhone,
        message,
        phone_number_id: phoneNumberId,
      })
      if (!insErr || insErr.code === '23505') {
        if (!insErr) scheduled++
      } else {
        console.error(`Error encolando recordatorio 1h para cita ${appt.id}:`, insErr.message)
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, scheduled, total: appointments.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
