import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN          = Deno.env.get('WA_ACCESS_TOKEN')!

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: { conversation_id: string; message: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { conversation_id, message } = body
  if (!conversation_id?.trim() || !message?.trim()) {
    return json({ error: 'conversation_id y message son requeridos' }, 422)
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Get conversation → contact phone + org phone_number_id
  const { data: conv, error: convErr } = await adminClient
    .from('conversations')
    .select('id, organization_id, contact_id, phone_number_id, contacts(phone), phone_numbers(phone_number_id)')
    .eq('id', conversation_id)
    .single()

  if (convErr || !conv) return json({ error: 'Conversación no encontrada' }, 404)

  const toPhone      = (conv.contacts as any)?.phone
  const metaPhoneId  = (conv.phone_numbers as any)?.phone_number_id ?? conv.phone_number_id

  if (!toPhone)     return json({ error: 'El contacto no tiene número de teléfono' }, 422)
  if (!metaPhoneId) return json({ error: 'No hay Phone Number ID configurado para esta org' }, 422)

  // Send via WhatsApp Cloud API
  const waRes = await fetch(
    `https://graph.facebook.com/v20.0/${metaPhoneId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone.replace(/\D/g, ''), // digits only
        type: 'text',
        text: { body: message.trim() },
      }),
    }
  )

  const waData = await waRes.json()
  if (!waRes.ok) {
    return json({ error: `WhatsApp API error: ${waData.error?.message ?? JSON.stringify(waData)}` }, 502)
  }

  const waMessageId = waData.messages?.[0]?.id ?? null

  // Store message in DB
  const { error: insertErr } = await adminClient.from('messages').insert({
    conversation_id,
    organization_id: conv.organization_id,
    direction:       'outbound',
    content:         message.trim(),
    media_type:      'text',
  })

  if (insertErr) {
    return json({ error: `Mensaje enviado pero falló el registro: ${insertErr.message}` }, 500)
  }

  // Update conversation last_message_at
  await adminClient.from('conversations')
    .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', conversation_id)

  return json({ ok: true, wa_message_id: waMessageId })
})
