import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Reactiva leads fríos ─────────────────────────────────────────────────────
// Busca conversaciones abiertas donde el negocio escribió último hace 24–48h
// y el cliente nunca contestó, y manda UN mensaje de seguimiento redactado por
// GPT-4o según el historial. Pensado para correr cada pocas horas vía cron
// (ver supabase/config.toml).
//
// La ventana de 24–48h es lo que evita mandar el mismo seguimiento dos veces
// sin necesitar una columna nueva en la base de datos: en cuanto se manda el
// seguimiento, last_message_at se actualiza a "ahora" y la conversación sale
// de la ventana. El chequeo de "los últimos 2 mensajes ya son outbound" evita
// seguir insistiendo si el cliente tampoco contesta al seguimiento.

const AVAXON_ORG_ID = 'e30d23e7-b512-44c8-a0bf-23f102300198'

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN      = Deno.env.get('WA_ACCESS_TOKEN')!
  const OPENAI_KEY    = Deno.env.get('OPENAI_API_KEY')!

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  const now         = Date.now()
  const windowStart = new Date(now - 48 * 60 * 60 * 1000).toISOString()
  const windowEnd   = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  const { data: convs } = await sb
    .from('conversations')
    .select('id, organization_id, contacts(phone), phone_numbers(phone_number_id)')
    .eq('organization_id', AVAXON_ORG_ID)
    .eq('status', 'open')
    .gte('last_message_at', windowStart)
    .lt('last_message_at', windowEnd)

  if (!convs || convs.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0, sent: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let sent = 0

  for (const conv of convs) {
    const { data: lastTwo } = await sb
      .from('messages')
      .select('direction')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(2)

    if (!lastTwo || lastTwo.length === 0 || lastTwo[0].direction !== 'outbound') continue // el cliente ya contestó
    if (lastTwo.length === 2 && lastTwo[1].direction === 'outbound') continue // ya se mandó un seguimiento antes; no insistir más

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

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Eres el agente de WhatsApp de Avaxon. El cliente dejó de responder hace un día. Escribe UN mensaje breve, cálido y natural (máximo 2 líneas) para retomar la conversación, basado en el contexto. No suenes a plantilla ni repitas literalmente lo último que dijiste.',
          },
          ...chatHistory,
        ],
        max_tokens: 120,
        temperature: 0.8,
      }),
    })

    const aiData   = await aiRes.json()
    const followUp = aiData.choices?.[0]?.message?.content?.trim()
    if (!followUp) continue

    const toPhone     = (conv.contacts as any)?.phone
    const metaPhoneId = (conv.phone_numbers as any)?.phone_number_id
    if (!toPhone || !metaPhoneId) continue

    const waRes = await fetch(`https://graph.facebook.com/v20.0/${metaPhoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   toPhone,
        type: 'text',
        text: { body: followUp },
      }),
    })

    if (!waRes.ok) continue
    const waData = await waRes.json()

    await sb.from('messages').insert({
      conversation_id: conv.id,
      organization_id: conv.organization_id,
      direction:       'outbound',
      content:         followUp,
      media_type:      'text',
      wa_message_id:   waData.messages?.[0]?.id ?? null,
    })

    await sb.from('conversations')
      .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', conv.id)

    sent++
  }

  return new Response(JSON.stringify({ ok: true, processed: convs.length, sent }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
