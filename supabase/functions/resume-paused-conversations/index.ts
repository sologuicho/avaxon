import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { logBotError } from '../_shared/botErrorLog.ts'

// ── Retoma el bot si nadie del equipo atendió a tiempo ──────────────────────
// Corre cada 15 min (pg_cron). Busca conversaciones marcadas needs_human que
// llevan más del tiempo configurado por la org (organization_profile.
// human_handoff_timeout_hours, 2h por defecto) sin que nadie las retome —
// el bot contesta un mensaje de disculpa y sigue atendiendo, pero la
// conversación SIGUE marcada needs_human para que el equipo la vea cuando
// pueda (eso lo quita únicamente "Marcar como atendida").
//
// No toca conversaciones donde bot_resumed_at ya tiene valor (ya se retomó)
// ni las que needs_human=false (nunca se marcaron o ya se atendieron).

const DEFAULT_TIMEOUT_HOURS = 2

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
  const WA_TOKEN     = Deno.env.get('WA_ACCESS_TOKEN')!
  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  const { data: pending } = await sb
    .from('conversations')
    .select('id, organization_id, needs_human_at, contacts(phone), phone_numbers(phone_number_id, whatsapp_accounts(access_token))')
    .eq('needs_human', true)
    .is('bot_resumed_at', null)
    .not('needs_human_at', 'is', null)

  if (!pending || pending.length === 0) {
    return json({ ok: true, checked: 0, resumed: 0 })
  }

  // Timeouts configurados por org, en un solo query.
  const orgIds = [...new Set(pending.map(c => c.organization_id))]
  const { data: profiles } = await sb
    .from('organization_profile')
    .select('organization_id, human_handoff_timeout_hours')
    .in('organization_id', orgIds)
  const timeoutByOrg: Record<string, number> = {}
  ;(profiles ?? []).forEach(p => {
    timeoutByOrg[p.organization_id] = p.human_handoff_timeout_hours || DEFAULT_TIMEOUT_HOURS
  })

  const now = Date.now()
  let resumed = 0

  for (const conv of pending) {
    const timeoutHours = timeoutByOrg[conv.organization_id] ?? DEFAULT_TIMEOUT_HOURS
    const elapsedHours = (now - new Date(conv.needs_human_at as string).getTime()) / 3_600_000
    if (elapsedHours < timeoutHours) continue

    const toPhone     = (conv.contacts as any)?.phone
    const phoneNumberId = (conv.phone_numbers as any)?.phone_number_id
    const token       = (conv.phone_numbers as any)?.whatsapp_accounts?.access_token ?? WA_TOKEN
    if (!toPhone || !phoneNumberId) continue

    const resumeText = 'Perdón por la espera — el equipo no está disponible ahorita. ¿Te ayudo yo mientras? 🙂'

    try {
      const waRes = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone, type: 'text', text: { body: resumeText } }),
      })
      if (!waRes.ok) {
        const errData = await waRes.json().catch(() => ({}))
        console.error(`resume-paused-conversations: Meta rechazó envío a conv ${conv.id}:`, JSON.stringify(errData))
        await logBotError(sb, {
          organization_id: conv.organization_id, conversation_id: conv.id,
          type: 'meta_rejected', error_code: String(errData?.error?.code ?? waRes.status),
          detail: `Meta rechazó el mensaje de retoma automática: ${JSON.stringify(errData)}`,
          source: 'resume-paused-conversations',
        })
        continue
      }
      const waData = await waRes.json()

      await sb.from('messages').insert({
        conversation_id: conv.id,
        organization_id: conv.organization_id,
        direction:       'outbound',
        content:         resumeText,
        media_type:      'text',
        wa_message_id:   waData.messages?.[0]?.id ?? null,
        processed_at:    new Date().toISOString(),
      })

      // needs_human sigue true a propósito — solo "Marcar como atendida" lo quita.
      await sb.from('conversations')
        .update({ bot_resumed_at: new Date().toISOString(), last_message_at: new Date().toISOString() })
        .eq('id', conv.id)

      resumed++
    } catch (e) {
      console.error(`resume-paused-conversations: error en conv ${conv.id}:`, e)
      await logBotError(sb, {
        organization_id: conv.organization_id, conversation_id: conv.id,
        type: 'edge_function_500', detail: `Error inesperado reanudando la conversación: ${(e as Error).message}`,
        source: 'resume-paused-conversations',
      })
    }
  }

  return json({ ok: true, checked: pending.length, resumed })
})
