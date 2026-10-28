import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Cierra conversaciones abiertas cuando el cliente no ha escrito en X horas
// (bot_configs.features.auto_close_hours). Si el valor no está configurado
// para la org, no se cierra nada. Corre cada 30 min (pg_cron).
//
// Guardas: no cierra conversaciones con human_pause_until activo ni con
// current_order_id no nulo (pedido en curso). transfer_pending se añade en Fase 6.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  // Si CRON_SECRET está configurado, solo pg_cron (que manda ese header) puede invocar esta función.
  const CRON_SECRET = Deno.env.get('CRON_SECRET')
  if (CRON_SECRET && req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  const { data: botConfigs } = await sb
    .from('bot_configs')
    .select('organization_id, features')
    .eq('enabled', true)

  const active = (botConfigs ?? []).filter(bc => {
    const hours = Number((bc.features as any)?.auto_close_hours ?? 0)
    return hours > 0
  })

  if (active.length === 0) return json({ ok: true, checked: 0, closed: 0 })

  const now = new Date()
  let checkedCount = 0
  let closedCount  = 0

  for (const bc of active) {
    const autoCloseHours = Number((bc.features as any).auto_close_hours)
    const cutoff = new Date(now.getTime() - autoCloseHours * 3_600_000).toISOString()

    const { data: convs } = await sb
      .from('conversations')
      .select('id')
      .eq('organization_id', bc.organization_id)
      .eq('status', 'open')
      .eq('transfer_pending', false)
      .is('current_order_id', null)
      .or(`human_pause_until.is.null,human_pause_until.lt.${now.toISOString()}`)
      .lt('last_client_message_at', cutoff)
      .not('last_client_message_at', 'is', null)

    checkedCount += convs?.length ?? 0
    if (!convs || convs.length === 0) continue

    const ids = convs.map(c => c.id)
    const { error } = await sb
      .from('conversations')
      .update({ status: 'closed', closed_at: now.toISOString(), updated_at: now.toISOString() })
      .in('id', ids)

    if (error) {
      console.error(`close-inactive-conversations: error cerrando convs org ${bc.organization_id}:`, error)
    } else {
      closedCount += ids.length
      console.log(`close-inactive-conversations: cerradas ${ids.length} conv(s) org ${bc.organization_id}`)
    }
  }

  return json({ ok: true, checked: checkedCount, closed: closedCount })
})
