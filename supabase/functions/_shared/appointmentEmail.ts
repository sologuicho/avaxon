import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendEmail } from './email.ts'

export type AppointmentEvent = 'created' | 'rescheduled' | 'cancelled'
export type AppointmentOrigin = 'whatsapp' | 'dashboard'

const SUBJECT_PREFIX: Record<AppointmentEvent, string> = {
  created: 'Nueva cita',
  rescheduled: 'Cita reagendada',
  cancelled: 'Cita cancelada',
}

const ACCENT = '#22c55e'
const DASHBOARD_URL = 'https://avaxon.lat/dashboard/'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function buildHtml(opts: {
  event: AppointmentEvent
  clientName: string
  phone: string
  service: string
  dateLabel: string
  timeLabel: string
  origin: AppointmentOrigin
}): string {
  const originLabel = opts.origin === 'whatsapp' ? 'WhatsApp (agendada por el bot)' : 'Dashboard'
  const title = SUBJECT_PREFIX[opts.event]
  return `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:32px 16px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:${ACCENT};padding:20px 24px">
      <span style="color:#fff;font-size:17px;font-weight:700">Avaxon</span>
    </div>
    <div style="padding:24px">
      <h2 style="margin:0 0 16px;font-size:18px;color:#0f172a">${escapeHtml(title)}</h2>
      <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#64748b;width:120px">Cliente</td><td style="padding:6px 0;font-weight:600">${escapeHtml(opts.clientName)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Teléfono</td><td style="padding:6px 0">${escapeHtml(opts.phone)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Servicio</td><td style="padding:6px 0">${escapeHtml(opts.service)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Fecha y hora</td><td style="padding:6px 0">${escapeHtml(opts.dateLabel)}, ${escapeHtml(opts.timeLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Origen</td><td style="padding:6px 0">${escapeHtml(originLabel)}</td></tr>
      </table>
      <div style="margin-top:24px">
        <a href="${DASHBOARD_URL}" style="display:inline-block;background:${ACCENT};color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px">Ver en el dashboard</a>
      </div>
    </div>
  </div>
</div>`.trim()
}

export async function notifyAppointment(
  sb: ReturnType<typeof createClient>,
  appointmentId: string,
  event: AppointmentEvent,
  origin: AppointmentOrigin,
): Promise<void> {
  try {
    const { data: appt } = await sb
      .from('appointments')
      .select('id, organization_id, contact_id, contact_name, title, service, scheduled_at, contacts(name, phone)')
      .eq('id', appointmentId)
      .maybeSingle()
    if (!appt) {
      console.error(`notifyAppointment: cita ${appointmentId} no encontrada`)
      return
    }

    const { data: org } = await sb
      .from('organizations')
      .select('timezone')
      .eq('id', appt.organization_id)
      .maybeSingle()
    const timezone = org?.timezone || 'America/Matamoros'

    const { data: profile } = await sb
      .from('organization_profile')
      .select('notification_email')
      .eq('organization_id', appt.organization_id)
      .maybeSingle()

    let notifyEmail: string | null = profile?.notification_email || null

    if (!notifyEmail) {
      const { data: owner } = await sb
        .from('profiles')
        .select('id')
        .eq('organization_id', appt.organization_id)
        .eq('role', 'owner')
        .limit(1)
        .maybeSingle()
      if (owner?.id) {
        const { data: ownerUser } = await sb.auth.admin.getUserById(owner.id)
        notifyEmail = ownerUser?.user?.email || null
      }
    }

    if (!notifyEmail) {
      console.warn(`notifyAppointment: sin correo de notificaciones para org ${appt.organization_id}`)
      return
    }

    const clientName = appt.contact_name || (appt.contacts as any)?.name || 'Sin nombre'
    const phone = (appt.contacts as any)?.phone || '—'
    const service = appt.service || appt.title || 'Cita'

    const dt = new Date(appt.scheduled_at)
    const dateLabel = dt.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: timezone })
    const timeLabel = dt.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: timezone })

    const subject = `${SUBJECT_PREFIX[event]}: ${clientName} — ${dateLabel}, ${timeLabel}`
    const html = buildHtml({ event, clientName, phone, service, dateLabel, timeLabel, origin })

    const result = await sendEmail({ to: notifyEmail, subject, html })
    if (!result.ok) {
      console.error(`notifyAppointment: Resend no pudo enviar (cita ${appointmentId}): ${result.error}`)
    }
  } catch (e) {
    // El envío de correo nunca debe romper el flujo de agendado.
    console.error('notifyAppointment: error inesperado', e)
  }
}
