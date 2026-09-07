import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  // Validar secret
  const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET')
  if (!WEBHOOK_SECRET || body.secret !== WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders })
  }

  const {
    phone_number_id,
    organization_id: orgIdParam,
    contact_phone,
    contact_name,
    direction,
    content,
    wa_message_id,
    media_url,
    media_type,
  } = body

  if (!contact_phone || !direction || !content) {
    return new Response(
      JSON.stringify({ error: 'Faltan campos: contact_phone, direction, content' }),
      { status: 400, headers: corsHeaders }
    )
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // 1. Resolver organization_id
  let organization_id = orgIdParam

  if (!organization_id && phone_number_id) {
    const { data: pn } = await sb
      .from('phone_numbers')
      .select('organization_id')
      .eq('phone_number_id', phone_number_id)
      .single()
    organization_id = pn?.organization_id
  }

  if (!organization_id) {
    return new Response(
      JSON.stringify({ error: 'No se encontró la organización. Pasa organization_id o phone_number_id válido.' }),
      { status: 404, headers: corsHeaders }
    )
  }

  // 2. Upsert contacto
  const { data: contact, error: contactErr } = await sb
    .from('contacts')
    .upsert(
      {
        organization_id,
        phone: contact_phone,
        name: contact_name ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,phone' }
    )
    .select('id')
    .single()

  if (contactErr) {
    return new Response(
      JSON.stringify({ error: 'Error al guardar contacto', detail: contactErr.message }),
      { status: 500, headers: corsHeaders }
    )
  }

  // 3. Obtener o crear conversación abierta
  let conversation_id: string

  const { data: existingConv } = await sb
    .from('conversations')
    .select('id')
    .eq('organization_id', organization_id)
    .eq('contact_id', contact.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingConv) {
    conversation_id = existingConv.id
    await sb
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversation_id)
  } else {
    const { data: newConv, error: convErr } = await sb
      .from('conversations')
      .insert({
        organization_id,
        contact_id: contact.id,
        status: 'open',
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (convErr) {
      return new Response(
        JSON.stringify({ error: 'Error al crear conversación', detail: convErr.message }),
        { status: 500, headers: corsHeaders }
      )
    }
    conversation_id = newConv.id
  }

  // 4. Insertar mensaje (ignorar duplicados por wa_message_id)
  const { error: msgErr } = await sb.from('messages').insert({
    conversation_id,
    organization_id,
    direction,
    content,
    wa_message_id: wa_message_id ?? null,
    media_url: media_url ?? null,
    media_type: media_type ?? null,
    status: direction === 'inbound' ? 'delivered' : 'sent',
  })

  if (msgErr && !msgErr.message.includes('duplicate')) {
    return new Response(
      JSON.stringify({ error: 'Error al guardar mensaje', detail: msgErr.message }),
      { status: 500, headers: corsHeaders }
    )
  }

  return new Response(
    JSON.stringify({ ok: true, conversation_id, contact_id: contact.id }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
