import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Procesador de recordatorios pendientes ───────────────────────────────────
// Lee la tabla `reminders` donde sent = false y send_at <= now(),
// envía cada mensaje por WhatsApp y lo marca como enviado.
// Corre cada minuto vía pg_cron.
//
// Para recordatorios de citas (appointment_id != null) que fallen por la
// ventana de 24h (error 131026), intenta reenviar con la plantilla
// `recordatorio_cita` si está registrada en la org. Si no existe la plantilla,
// marca el reminder como enviado con error para no reintentar indefinidamente.

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN     = Deno.env.get('WA_ACCESS_TOKEN')!

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  const { data: pending, error } = await sb
    .from('reminders')
    .select('id, to_phone, message, phone_number_id, appointment_id, reminder_type')
    .eq('sent', false)
    .lte('send_at', new Date().toISOString())
    .limit(50)

  if (error) {
    console.error('Error leyendo reminders:', error.message)
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 })
  }

  if (!pending || pending.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 })
  }

  let sent = 0

  for (const reminder of pending) {
    const { data: pn } = await sb
      .from('phone_numbers')
      .select('whatsapp_accounts(access_token)')
      .eq('phone_number_id', reminder.phone_number_id)
      .maybeSingle()

    const token = (pn?.whatsapp_accounts as any)?.access_token ?? WA_TOKEN

    const waRes = await fetch(
      `https://graph.facebook.com/v20.0/${reminder.phone_number_id}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:   reminder.to_phone,
          type: 'text',
          text: { body: reminder.message },
        }),
      }
    )

    if (waRes.ok) {
      await sb.from('reminders').update({ sent: true }).eq('id', reminder.id)
      sent++
      continue
    }

    const waData = await waRes.json().catch(() => ({}))
    const errorCode = waData?.error?.code

    // 131026 = fuera de la ventana de 24h — intentar con template si es cita
    if (errorCode === 131026 && reminder.appointment_id) {
      const templateSent = await tryAppointmentTemplate(
        reminder, token, sb,
      )
      if (templateSent) {
        await sb.from('reminders').update({ sent: true }).eq('id', reminder.id)
        sent++
      } else {
        // No hay template disponible — marcar para no reintentar
        await sb.from('reminders').update({ sent: true }).eq('id', reminder.id)
        console.warn(`Recordatorio ${reminder.id} no enviado (ventana 24h cerrada, sin template).`)
      }
    } else {
      console.error(`Error enviando reminder ${reminder.id} (${errorCode}):`, JSON.stringify(waData))
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, total: pending.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

// Intenta enviar con la plantilla `recordatorio_cita` si la org la tiene registrada.
// Los parámetros de la plantilla se extraen del mensaje de texto guardado.
async function tryAppointmentTemplate(
  reminder: { id: string; to_phone: string; phone_number_id: string; appointment_id: string | null; reminder_type: string | null },
  token: string,
  sb: ReturnType<typeof createClient>,
): Promise<boolean> {
  try {
    // Buscar el nombre del template configurado en la org
    const { data: appt } = await sb
      .from('appointments')
      .select('organization_id, contact_name, service, title, scheduled_at')
      .eq('id', reminder.appointment_id!)
      .maybeSingle()
    if (!appt) return false

    const { data: integ } = await sb
      .from('integrations')
      .select('config')
      .eq('organization_id', appt.organization_id)
      .eq('provider', 'whatsapp')
      .maybeSingle()

    const templateName = (integ?.config as any)?.reminder_template_name
    if (!templateName) return false

    const serviceName  = appt.service || appt.title || 'tu cita'
    const contactName  = appt.contact_name || ''
    const timeLabel    = new Date(appt.scheduled_at).toLocaleString('es-MX', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: true,
    })

    const templateRes = await fetch(
      `https://graph.facebook.com/v20.0/${reminder.phone_number_id}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:   reminder.to_phone,
          type: 'template',
          template: {
            name: templateName,
            language: { code: 'es_MX' },
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: contactName },
                { type: 'text', text: serviceName },
                { type: 'text', text: timeLabel },
              ],
            }],
          },
        }),
      }
    )
    return templateRes.ok
  } catch (e) {
    console.error('tryAppointmentTemplate error:', e)
    return false
  }
}
