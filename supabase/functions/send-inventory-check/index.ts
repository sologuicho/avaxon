import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getLocalTimeParts, timeToMinutes } from '../_shared/timezone.ts'

// Cron: envía plantillas de inventario al staff de cada org.
// ?type=morning  → plantilla matutina con menú actual (horario fijo en UTC, legacy)
// ?type=periodic → check-in de medio día (horario fijo en UTC, legacy)
// ?type=shift    → horarios por org, definidos en bot_configs.inventory_config.shift_schedule,
//                  evaluados en hora LOCAL de cada org (no se desalinea con el cambio de horario)
//
// Los crons se configuran en Supabase con:
//   select cron.schedule('inventory-morning',  '0 13 * * *', $$select net.http_post(url, '{"type":"morning"}',  'application/json')$$);
//   select cron.schedule('inventory-periodic', '0 19 * * *', $$select net.http_post(url, '{"type":"periodic"}', 'application/json')$$);
//   select cron.schedule('inventory-shift',    '*/30 * * * *', $$select net.http_post(url, '{"type":"shift"}', 'application/json')$$);
// (UTC: 13:00 = 7am CST, 19:00 = 1pm CST. inventory-shift corre cada 30 min
//  todo el año; los minutos :00/:30 no se mueven con el DST, solo la hora.)
//
// morning/periodic (legacy) IGNORAN cualquier org que ya tenga shift_schedule
// configurado, para no mandar doble a quienes ya migraron al horario por turnos.

const GRAPH = 'https://graph.facebook.com/v22.0'

// Nombres de plantilla en Meta (deben estar aprobadas)
// menu_diario_check (sin "_v3") quedó aprobada como MARKETING y hardcodea
// "Narciso" en el saludo — ya no se usa aquí, pero no se borra de Meta por
// si hace falta revertir.
//
// menu_diario_check_v3 e inventario_check_v3 (las dos de abajo, antes de
// este cambio) quedaron en PENDING_DELETION el 18/oct y Meta las borró
// automáticamente 7 días después (confirmado con una llamada directa a la
// Graph API: "Object does not exist") -- no fue algo que el equipo borrara.
// Reemplazadas por v1 con nombre nuevo (Meta no deja reusar el nombre de
// una plantilla recién borrada) y mismo contenido/variables. Verificado
// APPROVED como UTILITY en Meta antes de desplegar este cambio.
const TEMPLATE_MORNING            = 'aviso_menu_matutino_v1'
// Respaldo del check de mediodía cuando la ventana de 24h está cerrada; si
// está abierta se manda un mensaje interactivo normal, sin gastar plantilla.
const TEMPLATE_PERIODIC_FALLBACK = 'revision_inventario_v1'
const WINDOW_MS = 24 * 60 * 60 * 1000

// Tolerancia del cron de turnos: si un slot ya pasó pero no se ha mandado
// hoy, se manda igual mientras siga dentro de esta ventana desde la hora
// programada -- así un atraso del cron no hace que se salte el envío, pero
// tampoco resucita un slot de hace muchas horas si se despliega a medio día.
const SHIFT_GRACE_MINUTES = 60

type Recipient = { phone: string; name: string }

// Hasta ahora el resultado de cada envío (éxito o error de Meta) solo se
// regresaba en el body HTTP de la Edge Function -- nadie lo lee porque la
// dispara pg_cron, no una persona. Si un envío fallaba (bloqueo, plantilla
// rechazada, rate limit, etc.) no quedaba ningún rastro consultable. Esto
// lo persiste en bot_tool_logs sin tocar horario/intervalo/lógica de envío.
async function logInventorySend(
  sb: ReturnType<typeof createClient>,
  organizationId: string,
  slot: string,
  entry: Record<string, unknown>,
): Promise<void> {
  // Nunca debe tronar el envío real por un problema de logging -- todo
  // este cuerpo va envuelto en try/catch, incluido el JSON.stringify.
  try {
    await sb.from('bot_tool_logs').insert({
      organization_id: organizationId,
      tool_name: 'inventory_check_send',
      result: JSON.stringify({ slot, ...entry }),
    })
  } catch (e) {
    console.error('logInventorySend:', e)
  }
}

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

async function resolveNotifyNumber(sb: ReturnType<typeof createClient>, organizationId: string, phone: string): Promise<string | null> {
  const { data } = await sb
    .from('org_staff')
    .select('notify_via_phone_number_id')
    .eq('organization_id', organizationId)
    .eq('phone', phone)
    .maybeSingle()
  return (data as any)?.notify_via_phone_number_id ?? null
}

async function getAccessToken(sb: ReturnType<typeof createClient>, phoneNumberId: string): Promise<string | null> {
  const { data } = await sb
    .from('phone_numbers')
    .select('whatsapp_accounts(access_token)')
    .eq('phone_number_id', phoneNumberId)
    .single()
  return (data?.whatsapp_accounts as any)?.access_token ?? null
}

async function sendMorningTemplate(
  sb: ReturnType<typeof createClient>,
  organizationId: string,
  recipient: Recipient,
): Promise<Record<string, unknown>> {
  const notifyId = await resolveNotifyNumber(sb, organizationId, recipient.phone)
  if (!notifyId) return { phone: recipient.phone, ok: false, error: 'no notify_via_phone_number_id' }
  const accessToken = await getAccessToken(sb, notifyId)
  if (!accessToken) return { phone: recipient.phone, ok: false, error: 'no access_token' }

  const saludo = recipient.name ? `Buenos días, ${recipient.name} 👋` : 'Buenos días 👋'
  const menu = await getDailyMenu(sb, organizationId)
  const res = await fetch(`${GRAPH}/${notifyId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: recipient.phone, type: 'template',
      template: {
        name: TEMPLATE_MORNING,
        language: { code: 'es_MX' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: sanitizeForTemplate(saludo) }, { type: 'text', text: menu }] },
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'INVENTARIO_OK_MORNING' }] },
        ],
      },
    }),
  })
  const data = await res.json().catch(() => ({}))
  return { phone: recipient.phone, ok: res.ok, data }
}

async function sendMiddayCheck(
  sb: ReturnType<typeof createClient>,
  organizationId: string,
  recipient: Recipient,
): Promise<Record<string, unknown>> {
  const notifyId = await resolveNotifyNumber(sb, organizationId, recipient.phone)
  if (!notifyId) return { phone: recipient.phone, ok: false, error: 'no notify_via_phone_number_id' }
  const accessToken = await getAccessToken(sb, notifyId)
  if (!accessToken) return { phone: recipient.phone, ok: false, error: 'no access_token' }

  const sendWA = (body: Record<string, unknown>) =>
    fetch(`${GRAPH}/${notifyId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient.phone, ...body }),
    })

  const windowOpen = await isWindowOpen(sb, organizationId, recipient.phone)
  if (windowOpen) {
    const res = await sendWA({
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Revisión de inventario: ¿hay cambios en lo disponible?' },
        action: { buttons: [{ type: 'reply', reply: { id: 'inv_ok_periodic', title: 'Sin cambios' } }] },
      },
    })
    const data = await res.json().catch(() => ({}))
    return { phone: recipient.phone, ok: res.ok, via: 'interactive', data }
  }

  const { data: orgRow } = await sb.from('organizations').select('timezone').eq('id', organizationId).maybeSingle()
  const timezone = (orgRow as any)?.timezone || 'America/Matamoros'
  const fechaLabel = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', timeZone: timezone })
  const menu = await getDailyMenu(sb, organizationId)

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
  const data = await res.json().catch(() => ({}))
  return { phone: recipient.phone, ok: res.ok, via: 'template', data }
}

// due si el slot ya llegó/pasó y sigue dentro de SHIFT_GRACE_MINUTES, y aún
// no se mandó hoy.
function isSlotDue(nowMinutes: number, slotTime: string, alreadySent: boolean): boolean {
  if (alreadySent) return false
  const slotMinutes = timeToMinutes(slotTime)
  return nowMinutes >= slotMinutes && nowMinutes < slotMinutes + SHIFT_GRACE_MINUTES
}

async function handleShift(sb: ReturnType<typeof createClient>) {
  const { data: rows } = await sb.from('bot_configs').select('organization_id, inventory_config')
  const results: any[] = []

  for (const row of rows ?? []) {
    const invCfg = (row as any).inventory_config as Record<string, any> | null
    const shiftSchedule = invCfg?.shift_schedule
    if (!shiftSchedule) continue

    const tz = shiftSchedule.timezone || 'America/Matamoros'
    const { dateStr, weekday, minutesOfDay } = getLocalTimeParts(tz)
    const dayCfg = weekday === 'sat' ? shiftSchedule.saturday
      : weekday === 'sun' ? shiftSchedule.sunday
      : shiftSchedule.weekday
    if (!dayCfg) continue

    let shiftSent = invCfg?.shift_sent as { date: string; morning: boolean; midday: boolean } | undefined
    if (!shiftSent || shiftSent.date !== dateStr) shiftSent = { date: dateStr, morning: false, midday: false }
    let shiftToday = invCfg?.shift_today as { date: string; chef_phone: string; chef_name: string } | null ?? null
    if (!shiftToday || shiftToday.date !== dateStr) shiftToday = null

    let touched = false

    if (dayCfg.morning && isSlotDue(minutesOfDay, dayCfg.morning.time, shiftSent.morning)) {
      for (const recipient of (dayCfg.morning.recipients as Recipient[]) ?? []) {
        const sendResult = await sendMorningTemplate(sb, row.organization_id, recipient)
        await logInventorySend(sb, row.organization_id, 'shift-morning', sendResult)
        results.push({ organization_id: row.organization_id, slot: 'morning', ...sendResult })
      }
      shiftSent = { ...shiftSent, morning: true }
      touched = true
    }

    if (dayCfg.midday && isSlotDue(minutesOfDay, dayCfg.midday.time, shiftSent.midday)) {
      let recipients: Recipient[]
      if (dayCfg.midday.recipients === 'chef_of_day') {
        if (shiftToday) {
          recipients = [{ phone: shiftToday.chef_phone, name: shiftToday.chef_name }]
        } else {
          // Nadie reclamó el turno de hoy -- se manda a todas las
          // candidatas de la mañana como respaldo, por si alguna sí está
          // trabajando y simplemente no contestó el check matutino.
          recipients = (dayCfg.morning?.recipients as Recipient[]) ?? []
          await sb.from('bot_tool_logs').insert({
            organization_id: row.organization_id,
            tool_name: 'shift_sin_reclamar',
            result: `Nadie reclamó el turno de hoy (${dateStr}); check de mediodía mandado a todas las candidatas como respaldo.`,
          }).catch(() => {})
        }
      } else {
        recipients = (dayCfg.midday.recipients as Recipient[]) ?? []
      }
      for (const recipient of recipients) {
        const sendResult = await sendMiddayCheck(sb, row.organization_id, recipient)
        await logInventorySend(sb, row.organization_id, 'shift-midday', sendResult)
        results.push({ organization_id: row.organization_id, slot: 'midday', ...sendResult })
      }
      shiftSent = { ...shiftSent, midday: true }
      touched = true
    }

    if (touched) {
      await sb.from('bot_configs').update({
        inventory_config: { ...invCfg, shift_sent: shiftSent },
        updated_at: new Date().toISOString(),
      }).eq('organization_id', row.organization_id)
    }
  }

  return results
}

Deno.serve(async (req: Request) => {
  const type = new URL(req.url).searchParams.get('type') ?? 'morning'

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  if (type === 'shift') {
    const results = await handleShift(sb)
    return new Response(JSON.stringify({ ok: true, type, sent: results.length, results }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── morning / periodic (legacy, horario fijo en UTC) ────────────────────
  // Orgs que ya tienen shift_schedule configurado se ignoran aquí -- las
  // maneja por completo el tipo "shift" de arriba, para no mandar doble.
  const { data: shiftRows } = await sb.from('bot_configs').select('organization_id, inventory_config')
  const shiftOrgIds = new Set(
    (shiftRows ?? [])
      .filter((r: any) => r.inventory_config?.shift_schedule)
      .map((r: any) => r.organization_id),
  )

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
    if (shiftOrgIds.has(staff.organization_id)) continue
    try {
      const { data: pnRow } = await sb
        .from('phone_numbers')
        .select('whatsapp_accounts(access_token)')
        .eq('phone_number_id', staff.notify_via_phone_number_id)
        .single()

      const accessToken = (pnRow?.whatsapp_accounts as any)?.access_token
      if (!accessToken) { results.push({ ok: false, error: 'no access_token' }); continue }

      const sendWA = (body: Record<string, unknown>) =>
        fetch(`${GRAPH}/${staff.notify_via_phone_number_id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: staff.phone, ...body }),
        })

      if (type === 'morning') {
        const saludo = staff.name ? `Buenos días, ${staff.name} 👋` : 'Buenos días 👋'
        const menu = await getDailyMenu(sb, staff.organization_id)
        const res = await sendWA({
          type: 'template',
          template: {
            name: TEMPLATE_MORNING,
            language: { code: 'es_MX' },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: sanitizeForTemplate(saludo) }, { type: 'text', text: menu }] },
              { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'INVENTARIO_OK_MORNING' }] },
            ],
          },
        })
        const data = await res.json()
        await logInventorySend(sb, staff.organization_id, 'morning', { phone: staff.phone, ok: res.ok, data })
        results.push({ phone: staff.phone, ok: res.ok, data })
        continue
      }

      // ── periodic (mediodía) ──────────────────────────────────────────────
      const windowOpen = await isWindowOpen(sb, staff.organization_id, staff.phone)

      if (windowOpen) {
        const res = await sendWA({
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: 'Revisión de inventario: ¿hay cambios en lo disponible?' },
            action: { buttons: [{ type: 'reply', reply: { id: 'inv_ok_periodic', title: 'Sin cambios' } }] },
          },
        })
        const data = await res.json()
        await logInventorySend(sb, staff.organization_id, 'periodic', { phone: staff.phone, ok: res.ok, via: 'interactive', data })
        results.push({ phone: staff.phone, ok: res.ok, via: 'interactive', data })
        continue
      }

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
      await logInventorySend(sb, staff.organization_id, 'periodic', { phone: staff.phone, ok: res.ok, via: 'template', data })
      results.push({ phone: staff.phone, ok: res.ok, via: 'template', data })
    } catch (e) {
      await logInventorySend(sb, staff.organization_id, type, { phone: staff.phone, ok: false, error: (e as Error).message })
      results.push({ phone: staff.phone, error: (e as Error).message })
    }
  }

  return new Response(JSON.stringify({ ok: true, type, sent: results.length, results }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
