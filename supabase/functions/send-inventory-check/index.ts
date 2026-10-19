import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Cron: envía plantillas de inventario al staff de cada org.
// ?type=morning  → plantilla matutina con menú actual (llama a las 7am hora local)
// ?type=periodic → check-in de medio día (llama a la 1pm hora local)
//
// Los crons se configuran en Supabase con:
//   select cron.schedule('inventory-morning',  '0 13 * * *', $$select net.http_post(url, '{"type":"morning"}',  'application/json')$$);
//   select cron.schedule('inventory-periodic', '0 19 * * *', $$select net.http_post(url, '{"type":"periodic"}', 'application/json')$$);
// (UTC: 13:00 = 7am CST, 19:00 = 1pm CST)

const GRAPH = 'https://graph.facebook.com/v22.0'

// Nombres de plantilla en Meta (deben estar aprobadas)
const TEMPLATE_MORNING  = 'menu_dia_hf'
const TEMPLATE_PERIODIC = 'check_periodico_hf'

Deno.serve(async (req: Request) => {
  const type = new URL(req.url).searchParams.get('type') ?? 'morning'

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  // Obtener staff activo que recibe inventory checks
  const { data: staffList, error } = await sb
    .from('org_staff')
    .select('phone, name, organization_id, notify_via_phone_number_id')
    .eq('active', true)
    .eq('receives_inventory_check', true)

  if (error || !staffList?.length) {
    return new Response(JSON.stringify({ ok: true, sent: 0, note: 'no staff configured' }), { status: 200 })
  }

  const results: any[] = []

  for (const staff of staffList) {
    try {
      // Token del número de Avaxon para enviar el mensaje
      const { data: pnRow } = await sb
        .from('phone_numbers')
        .select('whatsapp_accounts(access_token)')
        .eq('phone_number_id', staff.notify_via_phone_number_id)
        .single()

      const accessToken = (pnRow?.whatsapp_accounts as any)?.access_token
      if (!accessToken) { results.push({ phone: staff.phone, error: 'no access_token' }); continue }

      let templateName: string
      let components: any[]

      if (type === 'morning') {
        // Catálogo completo de comida del día para que el chef elija qué habrá hoy
        const { data: botCfg } = await sb
          .from('bot_configs')
          .select('inventory_config')
          .eq('organization_id', staff.organization_id)
          .maybeSingle()

        const catalog = ((botCfg?.inventory_config as any)?.catalog as string)?.trim()
          || 'Responde con los platillos del dia de hoy'

        templateName = TEMPLATE_MORNING
        components = [
          { type: 'body', parameters: [{ type: 'text', text: catalog }] },
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'INVENTARIO_OK_MORNING' }] },
        ]
      } else {
        // Inventario activo actual para confirmar si hay cambios en el día
        const { data: botCfg } = await sb
          .from('bot_configs')
          .select('daily_inventory')
          .eq('organization_id', staff.organization_id)
          .maybeSingle()

        const rawInventory = botCfg?.daily_inventory?.trim()
          || 'Sin inventario definido aun'
        const inventory = rawInventory.replace(/[\n\r\t]+/g, ' • ')

        templateName = TEMPLATE_PERIODIC
        components = [
          { type: 'body', parameters: [{ type: 'text', text: inventory }] },
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'INVENTARIO_OK_PERIODIC' }] },
        ]
      }

      const res = await fetch(`${GRAPH}/${staff.notify_via_phone_number_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: staff.phone,
          type: 'template',
          template: {
            name: templateName,
            language: { code: 'es_MX' },
            components,
          },
        }),
      })
      const data = await res.json()
      results.push({ phone: staff.phone, ok: res.ok, data })
    } catch (e) {
      results.push({ phone: staff.phone, error: (e as Error).message })
    }
  }

  return new Response(JSON.stringify({ ok: true, type, sent: results.length, results }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
