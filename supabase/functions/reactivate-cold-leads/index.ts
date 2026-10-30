import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Reactiva leads fríos ─────────────────────────────────────────────────────
// Busca conversaciones abiertas donde el negocio escribió último hace 24–48h
// y el cliente nunca contestó, y manda UN mensaje de seguimiento redactado por
// GPT-4o según el historial. Pensado para correr cada pocas horas vía cron
// (ver supabase/config.toml).
//
// La ventana de 24–48h (sobre conversations.last_message_at) es lo que evita
// mandar el mismo seguimiento dos veces sin necesitar una columna nueva: en
// cuanto se manda el seguimiento, last_message_at se actualiza a "ahora" y la
// conversación sale de la ventana. El chequeo de "los últimos 2 mensajes ya
// son outbound" evita seguir insistiendo si el cliente tampoco contesta al
// seguimiento.
//
// GUARDAS (ver bug de oct 2026: se mandaba el JSON crudo del modelo como
// mensaje — {"text":...,"buttons":[...],"notify_owner":...} — porque el
// system_prompt de cada org obliga a GPT a responder en ese formato JSON,
// pero este archivo lo trataba como texto plano sin parsear):
//   1. Siempre se parsea la respuesta del modelo y solo se manda/guarda el
//      campo `text` (los `buttons`, si hay, como botones interactivos reales).
//   2. No se manda nada fuera de la ventana de 24h de WhatsApp (medida desde
//      el último mensaje ENTRANTE real, no desde last_message_at) salvo que
//      la org tenga configurada una plantilla aprobada para esto
//      (integrations.config.reengagement_template_name) — hoy ninguna org la
//      tiene, así que esos casos simplemente se omiten.
//   3. No se manda nada entre las 22:00 y las 08:00 hora de la org.
//   4. Si Meta rechaza el envío, se guarda en `messages` con status:'failed'
//      (nunca como si se hubiera entregado), y no se actualiza last_message_at.
//
// Multi-tenant: opera sobre todas las orgs con bot_configs.enabled = true,
// usando el access_token propio de cada cliente.

function isQuietHours(date: Date, timeZone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date),
  )
  return hour >= 22 || hour < 8
}

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN      = Deno.env.get('WA_ACCESS_TOKEN')!
  const OPENAI_KEY    = Deno.env.get('OPENAI_API_KEY')!

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  // Solo orgs con bot activo
  const { data: activeBots } = await sb
    .from('bot_configs')
    .select('organization_id, system_prompt')
    .eq('enabled', true)

  const activeOrgIds = (activeBots ?? []).map(b => b.organization_id)
  if (activeOrgIds.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0, sent: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const botPromptMap: Record<string, string> = {}
  ;(activeBots ?? []).forEach(b => { botPromptMap[b.organization_id] = b.system_prompt })

  const now         = Date.now()
  const windowStart = new Date(now - 48 * 60 * 60 * 1000).toISOString()
  const windowEnd   = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  const { data: convs } = await sb
    .from('conversations')
    .select('id, organization_id, contacts(phone), phone_numbers(phone_number_id, whatsapp_accounts(access_token)), organizations(timezone)')
    .in('organization_id', activeOrgIds)
    .eq('status', 'open')
    // Este seguimiento solo existe para WhatsApp (plantilla aprobada /
    // ventana de 24h de WhatsApp) -- sin este filtro, una conversación fría
    // de Instagram/Messenger generaba el mensaje con GPT igual y lo
    // descartaba después al no tener phone/phone_number_id, gastando la
    // llamada a OpenAI para nada.
    .eq('channel', 'whatsapp')
    .gte('last_message_at', windowStart)
    .lt('last_message_at', windowEnd)

  if (!convs || convs.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0, sent: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let sent = 0
  let skippedQuietHours = 0
  let skippedWindowClosed = 0

  for (const conv of convs) {
    const { data: lastTwo } = await sb
      .from('messages')
      .select('direction')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(2)

    if (!lastTwo || lastTwo.length === 0 || lastTwo[0].direction !== 'outbound') continue // el cliente ya contestó
    if (lastTwo.length === 2 && lastTwo[1].direction === 'outbound') continue // ya se mandó un seguimiento antes; no insistir más

    // ── Guarda: horario de atención (nada entre 22:00 y 08:00 hora de la org) ──
    const timezone = (conv.organizations as any)?.timezone || 'America/Matamoros'
    if (isQuietHours(new Date(), timezone)) { skippedQuietHours++; continue }

    // ── Guarda: ventana real de 24h de WhatsApp (desde el último inbound) ──
    const { data: lastInbound } = await sb
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conv.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const hoursSinceInbound = lastInbound
      ? (now - new Date(lastInbound.created_at).getTime()) / 3_600_000
      : Infinity

    if (hoursSinceInbound >= 24) {
      const { data: integ } = await sb
        .from('integrations')
        .select('config')
        .eq('organization_id', conv.organization_id)
        .eq('provider', 'whatsapp')
        .maybeSingle()
      const reengagementTemplate = (integ?.config as any)?.reengagement_template_name
      if (!reengagementTemplate) { skippedWindowClosed++; continue } // sin plantilla aprobada: no se manda nada
      // (Si en el futuro se configura una plantilla de reenganche, aquí se
      // mandaría con esa plantilla en vez del texto libre de abajo — no
      // implementado todavía porque ninguna org tiene una registrada.)
    }

    const { data: history } = await sb
      .from('messages')
      .select('direction, content')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(6)

    const chatHistory = (history ?? []).reverse().map(m => ({
      role:    m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content,
    }))

    const orgSystemPrompt = botPromptMap[conv.organization_id] ??
      'Eres un agente de WhatsApp. El cliente dejó de responder hace un día. Escribe UN mensaje breve y natural (máximo 2 líneas) para retomar la conversación. No suenes a plantilla.'

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: orgSystemPrompt + '\n\nEl cliente dejó de responder hace ~24h. Escribe UN mensaje breve y cálido (máximo 2 líneas) para retomar la conversación basándote en el contexto. No repitas literalmente lo último que dijiste.',
          },
          ...chatHistory,
        ],
        max_tokens: 200,
        temperature: 0.8,
      }),
    })

    const aiData  = await aiRes.json()
    const rawReply = aiData.choices?.[0]?.message?.content?.trim()
    if (!rawReply) continue

    // ── Parsear SIEMPRE la respuesta del modelo — nunca mandar el JSON crudo ──
    let aiParsed: { text?: string; buttons?: string[] }
    try { aiParsed = JSON.parse(rawReply) } catch { aiParsed = { text: rawReply } }
    const followUpText = (aiParsed.text ?? rawReply).trim()
    if (!followUpText) continue
    const buttonLabels = (aiParsed.buttons ?? []).slice(0, 3)

    const toPhone     = (conv.contacts as any)?.phone
    const metaPhoneId = (conv.phone_numbers as any)?.phone_number_id
    const clientToken = (conv.phone_numbers as any)?.whatsapp_accounts?.access_token ?? WA_TOKEN
    if (!toPhone || !metaPhoneId) continue

    const waPayload = buttonLabels.length > 0
      ? {
          messaging_product: 'whatsapp',
          to:   toPhone,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: followUpText },
            action: {
              buttons: buttonLabels.map((label: string, i: number) => ({
                type:  'reply',
                reply: { id: `btn_${i}`, title: label.slice(0, 20) },
              })),
            },
          },
        }
      : {
          messaging_product: 'whatsapp',
          to:   toPhone,
          type: 'text',
          text: { body: followUpText },
        }

    const waRes = await fetch(`https://graph.facebook.com/v20.0/${metaPhoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(waPayload),
    })

    const savedContent = buttonLabels.length > 0
      ? `${followUpText}\n[Botones: ${buttonLabels.join(' | ')}]`
      : followUpText

    if (!waRes.ok) {
      // Meta rechazó el envío — se guarda como fallido, no como enviado, y no
      // se toca last_message_at (la conversación sigue elegible para reintento
      // en la próxima corrida, salvo que ya hayan pasado otras 24h).
      const errData = await waRes.json().catch(() => ({}))
      console.error(`reactivate-cold-leads: Meta rechazó envío a conv ${conv.id}:`, JSON.stringify(errData))
      await sb.from('messages').insert({
        conversation_id: conv.id,
        organization_id: conv.organization_id,
        direction:       'outbound',
        content:         savedContent,
        media_type:      'text',
        status:          'failed',
      })
      continue
    }

    const waData = await waRes.json()

    await sb.from('messages').insert({
      conversation_id: conv.id,
      organization_id: conv.organization_id,
      direction:       'outbound',
      content:         savedContent,
      media_type:      'text',
      wa_message_id:   waData.messages?.[0]?.id ?? null,
    })

    await sb.from('conversations')
      .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', conv.id)

    sent++
  }

  return new Response(JSON.stringify({ ok: true, processed: convs.length, sent, skippedQuietHours, skippedWindowClosed }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
