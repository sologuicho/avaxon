import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Zapier → Avaxon (acciones entrantes) ─────────────────────────────────────
// Autenticado con la API key por organización (header X-Avaxon-Key), generada
// al conectar Zapier desde el dashboard. Solo se guarda el hash SHA-256 en
// integrations.credentials.api_key_hash — la clave en claro nunca se persiste.
// Sin JWT de Supabase: se despliega con --no-verify-jwt.
//
// Acciones soportadas:
//   send_whatsapp_message  { to, message }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-avaxon-key',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const apiKey = req.headers.get('X-Avaxon-Key')
  if (!apiKey) return json({ error: 'Missing X-Avaxon-Key header' }, 401)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN = Deno.env.get('WA_ACCESS_TOKEN')!
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const keyHash = await sha256Hex(apiKey)
  const { data: integ } = await sb
    .from('integrations')
    .select('organization_id')
    .eq('provider', 'zapier')
    .eq('status', 'connected')
    .eq('credentials->>api_key_hash', keyHash)
    .maybeSingle()

  if (!integ?.organization_id) return json({ error: 'Invalid API key' }, 401)
  const organizationId = integ.organization_id as string

  let body: { action?: string; to?: string; message?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  if (body.action === 'send_whatsapp_message') {
    const to = body.to?.trim()
    const message = body.message?.trim()
    if (!to || !message) return json({ error: 'to y message son requeridos' }, 422)

    const { data: pn } = await sb
      .from('phone_numbers')
      .select('id, phone_number_id, whatsapp_accounts(access_token)')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()

    if (!pn?.phone_number_id) return json({ error: 'La organización no tiene un número de WhatsApp activo' }, 422)

    const clientToken = (pn.whatsapp_accounts as any)?.access_token ?? WA_TOKEN
    const toDigits = to.replace(/\D/g, '')

    const waRes = await fetch(`https://graph.facebook.com/v20.0/${pn.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toDigits,
        type: 'text',
        text: { body: message },
      }),
    })
    const waData = await waRes.json()
    if (!waRes.ok) {
      return json({ error: `WhatsApp API error: ${waData.error?.message ?? JSON.stringify(waData)}` }, 502)
    }

    const { data: contactRow } = await sb
      .from('contacts')
      .upsert(
        { organization_id: organizationId, phone: toDigits, last_seen_at: new Date().toISOString() },
        { onConflict: 'organization_id,phone' },
      )
      .select('id')
      .single()

    let conversationId: string | null = null
    if (contactRow) {
      const { data: existingConv } = await sb
        .from('conversations')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('contact_id', contactRow.id)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (existingConv) {
        conversationId = existingConv.id
        await sb.from('conversations')
          .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', conversationId)
      } else {
        const { data: newConv } = await sb
          .from('conversations')
          .insert({
            organization_id: organizationId,
            contact_id:      contactRow.id,
            phone_number_id: pn.id,
            status:          'open',
            last_message_at: new Date().toISOString(),
          })
          .select('id')
          .single()
        conversationId = newConv?.id ?? null
      }

      if (conversationId) {
        await sb.from('messages').insert({
          conversation_id: conversationId,
          organization_id: organizationId,
          direction:       'outbound',
          content:         message,
          media_type:      'text',
          wa_message_id:   waData.messages?.[0]?.id ?? null,
          processed_at:    new Date().toISOString(),
        })
      }
    }

    return json({ ok: true, wa_message_id: waData.messages?.[0]?.id ?? null, conversation_id: conversationId })
  }

  return json({ error: `Acción no soportada: ${body.action}` }, 422)
})
