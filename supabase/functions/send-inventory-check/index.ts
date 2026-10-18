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
const TEMPLATE_MORNING           = 'menu_diario_check'
// inventario_check_periodico quedó aprobada como MARKETING — ya no se usa.
// inventario_check_v3 es solo el respaldo del check de mediodía cuando la
// ventana de 24h está cerrada; si está abierta se manda un mensaje
// interactivo normal, sin gastar plantilla.
const TEMPLATE_PERIODIC_FALLBACK = 'inventario_check_v3'
const WINDOW_MS = 24 * 60 * 60 * 1000

// Meta rechaza (error 132018) cualquier variable de plantilla con saltos de
// línea/tabs o con más de 4 espacios seguidos.
function sanitizeForTemplate(text: string): string {
  return text.replace(/[\n\r\t]+/g, ' • ').replace(/ {2,}/g, ' ').trim()
}

async function getDailyMenu(sb: ReturnType<typeof createClient>, organizationId: string): Promise<string> {
  const { data: botCfg } = await sb
    .from('bot_configs')
    .select('daily_inventory')
    .eq('organization_id', organizationId)
    .maybeSingle()
  const raw = (botCfg as any)?.daily_inventory?.trim()
    || 'Sin inventario definido — responde con los platillos del día 🍽️'
  return sanitizeForTemplate(raw)
}

// ¿Esta persona nos escribió en las últimas 24h? Si sí, se le puede mandar
// un mensaje interactivo normal (no gasta plantilla); si no, hay que usar
// una plantilla aprobada.
async function isWindowOpen(sb: ReturnType<typeof createClient>, organizationId: string, phone: string): Promise<boolean> {
  const { data: contact } = await sb
    .from('contacts')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('phone', phone)
    .maybeSingle()
  if (!contact) return false

  const { data: conv } = await sb
    .from('conversations')
    .select('id')
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!conv) return false

  const { data: lastInbound } = await sb
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conv.id)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!lastInbound) return false

  return Date.now() - new Date(lastInbound.created_at).getTime() < WINDOW_MS
}

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

      const sendWA = (body: Record<string, unknown>) =>
        fetch(`${GRAPH}/${staff.notify_via_phone_number_id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: staff.phone, ...body }),
        })

      if (type === 'morning') {
        const inventory = await getDailyMenu(sb, staff.organization_id)
        const res = await sendWA({
          type: 'template',
          template: {
            name: TEMPLATE_MORNING,
            language: { code: 'es_MX' },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: inventory }] },
              { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'INVENTARIO_OK_MORNING' }] },
            ],
          },
        })
        const data = await res.json()
        results.push({ phone: staff.phone, ok: res.ok, data })
        continue
      }

      // ── periodic (mediodía) ──────────────────────────────────────────────
      const windowOpen = await isWindowOpen(sb, staff.organization_id, staff.phone)

      if (windowOpen) {
        // Ventana abierta: mensaje interactivo normal, sin plantilla.
        const res = await sendWA({
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: 'Revisión de inventario: ¿hay cambios en lo disponible?' },
            action: { buttons: [{ type: 'reply', reply: { id: 'inv_ok_periodic', title: 'Sin cambios' } }] },
          },
        })
        const data = await res.json()
        results.push({ phone: staff.phone, ok: res.ok, via: 'interactive', data })
        continue
      }

      // Ventana cerrada: respaldo con plantilla aprobada, ligada a fecha + menú.
      const { data: orgRow } = await sb.from('organizations').select('timezone').eq('id', staff.organization_id).maybeSingle()
      const timezone = (orgRow as any)?.timezone || 'America/Matamoros'
      const fechaLabel = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', timeZone: timezone })
      const menu = await getDailyMenu(sb, staff.organization_id)

      const res = await sendWA({
        type: 'template',
        template: {
          name: TEMPLATE_PERIODIC_FALLBACK,
          language: { code: 'es_MX' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: fechaLabel }, { type: 'text', text: menu }] },
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'INVENTARIO_OK_PERIODIC' }] },
          ],
        },
      })
      const data = await res.json()
      results.push({ phone: staff.phone, ok: res.ok, via: 'template', data })
    } catch (e) {
      results.push({ phone: staff.phone, error: (e as Error).message })
    }
  }

  return new Response(JSON.stringify({ ok: true, type, sent: results.length, results }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
