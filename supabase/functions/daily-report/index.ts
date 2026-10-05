import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Reporte diario consolidado ───────────────────────────────────────────────
// Itera sobre todas las orgs con bot activo, calcula métricas de las últimas
// 24h y manda un resumen consolidado al número en REPORT_PHONE (Avaxon interno).
// Corre una vez al día vía pg_cron. No requiere JWT.

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY        = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN           = Deno.env.get('WA_ACCESS_TOKEN')!
  const WA_PHONE_NUMBER_ID = Deno.env.get('WA_PHONE_NUMBER_ID')!
  const REPORT_PHONE       = Deno.env.get('REPORT_PHONE')

  if (!REPORT_PHONE) {
    console.error('REPORT_PHONE no configurado')
    return new Response(JSON.stringify({ error: 'REPORT_PHONE not set' }), { status: 500 })
  }

  const sb    = createClient(SUPABASE_URL, SERVICE_KEY)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Orgs con bot activo
  const { data: bots } = await sb
    .from('bot_configs')
    .select('organization_id')
    .eq('enabled', true)

  const orgIds = (bots ?? []).map(b => b.organization_id)
  if (orgIds.length === 0) {
    return new Response(JSON.stringify({ ok: true, orgs: 0 }), { status: 200 })
  }

  // Nombres de orgs
  const { data: orgs } = await sb
    .from('organizations')
    .select('id, name')
    .in('id', orgIds)

  const orgNameMap: Record<string, string> = {}
  ;(orgs ?? []).forEach(o => { orgNameMap[o.id] = o.name })

  // Métricas por org (paralelo)
  const stats = await Promise.all(orgIds.map(async (orgId) => {
    const [convRes, leadsRes, msgsRes] = await Promise.all([
      sb.from('conversations').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).gte('last_message_at', since),
      sb.from('contacts').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).eq('status', 'qualified').gte('created_at', since),
      sb.from('messages').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).gte('created_at', since),
    ])
    return {
      name:  orgNameMap[orgId] ?? orgId.slice(0, 8),
      conv:  convRes.count  ?? 0,
      leads: leadsRes.count ?? 0,
      msgs:  msgsRes.count  ?? 0,
    }
  }))

  // Totales
  const totConv  = stats.reduce((s, r) => s + r.conv,  0)
  const totLeads = stats.reduce((s, r) => s + r.leads, 0)
  const totMsgs  = stats.reduce((s, r) => s + r.msgs,  0)

  // Formato del mensaje
  const date   = new Date().toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })
  const lines  = stats.map(r =>
    `• ${r.name}: ${r.conv} convs, ${r.leads} leads, ${r.msgs} msgs`
  ).join('\n')

  const text = [
    `📊 *Reporte Avaxon — ${date}*`,
    '',
    lines,
    '',
    `*Total:* ${totConv} convs · ${totLeads} leads · ${totMsgs} msgs`,
    `*Clientes activos:* ${orgIds.length}`,
  ].join('\n')

  const waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to:   REPORT_PHONE,
      type: 'text',
      text: { body: text },
    }),
  })

  const waData = await waRes.json()
  if (!waRes.ok) {
    console.error('Error enviando reporte diario:', waData)
    return new Response(JSON.stringify({ error: waData }), { status: 502 })
  }

  return new Response(
    JSON.stringify({ ok: true, orgs: orgIds.length, totConv, totLeads, totMsgs }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
})
