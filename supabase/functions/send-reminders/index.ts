import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Procesador de recordatorios pendientes ───────────────────────────────────
// Lee la tabla `reminders` donde sent = false y send_at <= now(),
// envía cada mensaje por WhatsApp y lo marca como enviado.
// Corre cada minuto vía pg_cron (ver setup en supabase/migrations).
// No requiere JWT — solo cron interno lo llama.

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN     = Deno.env.get('WA_ACCESS_TOKEN')!

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  const { data: pending, error } = await sb
    .from('reminders')
    .select('id, to_phone, message, phone_number_id')
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
    // Buscar el access_token por cliente usando phone_number_id de Meta
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

    if (!waRes.ok) {
      const errBody = await waRes.text()
      console.error(`Error enviando reminder ${reminder.id}:`, errBody)
      continue
    }

    await sb.from('reminders').update({ sent: true }).eq('id', reminder.id)
    sent++
  }

  return new Response(JSON.stringify({ ok: true, sent, total: pending.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
