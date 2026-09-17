import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Reporte nocturno de Avaxon ──────────────────────────────────────────────
// Cuenta la actividad de las últimas 24h y la manda por WhatsApp al número en
// el secret REPORT_PHONE. Pensado para correr una vez al día vía cron (ver
// supabase/config.toml). No requiere JWT porque solo cron/uso interno la llama.

const AVAXON_ORG_ID = 'e30d23e7-b512-44c8-a0bf-23f102300198'

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY        = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN           = Deno.env.get('WA_ACCESS_TOKEN')!
  const WA_PHONE_NUMBER_ID = Deno.env.get('WA_PHONE_NUMBER_ID')!
  const REPORT_PHONE       = Deno.env.get('REPORT_PHONE')

  if (!REPORT_PHONE) {
    console.error('REPORT_PHONE no está configurado — no se puede enviar el reporte')
    return new Response(JSON.stringify({ error: 'REPORT_PHONE not set' }), { status: 500 })
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [convRes, leadsRes, citasRes] = await Promise.all([
    sb.from('conversations').select('id', { count: 'exact', head: true })
      .eq('organization_id', AVAXON_ORG_ID).gte('last_message_at', since),
    sb.from('contacts').select('id', { count: 'exact', head: true })
      .eq('organization_id', AVAXON_ORG_ID).eq('status', 'qualified').gte('created_at', since),
    sb.from('appointments').select('id', { count: 'exact', head: true })
      .eq('organization_id', AVAXON_ORG_ID).gte('created_at', since),
  ])

  const conv  = convRes.count  ?? 0
  const leads = leadsRes.count ?? 0
  const citas = citasRes.count ?? 0

  const text = `Resumen de hoy:\n· ${conv} conversaciones atendidas\n· ${leads} leads calificados\n· ${citas} citas agendadas\n\nReporte automático de Avaxon.`

  const waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: REPORT_PHONE,
      type: 'text',
      text: { body: text },
    }),
  })

  const waData = await waRes.json()
  if (!waRes.ok) {
    console.error('Error enviando el reporte diario:', waData)
    return new Response(JSON.stringify({ error: waData }), { status: 500 })
  }

  return new Response(JSON.stringify({ ok: true, conv, leads, citas }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
