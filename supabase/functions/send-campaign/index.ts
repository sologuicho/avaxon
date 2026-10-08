import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN      = Deno.env.get('WA_ACCESS_TOKEN')!

  const callerSb = createClient(SUPABASE_URL, SERVICE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user } } = await callerSb.auth.getUser()
  if (!user) return json({ error: 'Unauthorized' }, 401)

  const adminSb = createClient(SUPABASE_URL, SERVICE_KEY)

  let body: { campaign_id: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { campaign_id } = body
  if (!campaign_id) return json({ error: 'campaign_id requerido' }, 422)

  // Fetch campaign
  const { data: camp, error: campErr } = await adminSb
    .from('campaigns')
    .select('*')
    .eq('id', campaign_id)
    .single()

  if (campErr || !camp) return json({ error: 'Campaña no encontrada' }, 404)
  if (camp.status === 'running') return json({ error: 'La campaña ya está en curso' }, 409)
  if (camp.status === 'completed') return json({ error: 'La campaña ya está completada' }, 409)

  const orgId = camp.organization_id

  // Get active phone number
  const { data: pn } = await adminSb
    .from('phone_numbers')
    .select('phone_number_id, whatsapp_accounts(access_token)')
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .maybeSingle()

  if (!pn?.phone_number_id) return json({ error: 'No hay número de WhatsApp activo' }, 422)

  const phoneNumberId = pn.phone_number_id
  const token         = (pn.whatsapp_accounts as any)?.access_token ?? WA_TOKEN

  // Mark campaign as running
  await adminSb.from('campaigns').update({ status: 'running', launched_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', campaign_id)

  // Resolve contacts: if CSV campaign, use campaign_contacts; otherwise fetch from contacts table
  let contacts: { id?: string; phone: string; name?: string }[] = []

  if (camp.source_type === 'csv') {
    // Read pre-inserted campaign_contacts
    const { data: cc } = await adminSb
      .from('campaign_contacts')
      .select('id, phone, name')
      .eq('campaign_id', campaign_id)
      .eq('status', 'pending')
    contacts = cc ?? []
  } else {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    let q = adminSb.from('contacts').select('id, phone, name').eq('organization_id', orgId).not('phone', 'is', null)
    if (camp.source_type === 'new')        q = q.eq('status', 'new')
    if (camp.source_type === 'qualified')  q = q.eq('status', 'qualified')
    if (camp.source_type === 'active_24h') q = q.gte('last_seen_at', since24h)
    const { data: cts } = await q
    contacts = cts ?? []

    // Insert campaign_contacts for tracking
    if (contacts.length > 0) {
      const rows = contacts.map(c => ({
        campaign_id:     campaign_id,
        organization_id: orgId,
        phone:           c.phone,
        name:            c.name ?? null,
        status:          'pending',
      }))
      for (let i = 0; i < rows.length; i += 200) {
        await adminSb.from('campaign_contacts').insert(rows.slice(i, i + 200))
      }
    }
  }

  // Update total_contacts
  await adminSb.from('campaigns').update({ total_contacts: contacts.length }).eq('id', campaign_id)

  // Resolve template name if needed
  let templateName: string | null = null
  let templateLang = 'es_MX'
  if (camp.message_type === 'template' && camp.template_id) {
    const { data: tpl } = await adminSb
      .from('message_templates')
      .select('name, language')
      .eq('id', camp.template_id)
      .single()
    templateName = tpl?.name ?? null
    templateLang = tpl?.language ?? 'es_MX'
  }

  // Re-fetch campaign_contacts ids for status updates
  let ccIds: Record<string, string> = {}
  if (camp.source_type !== 'csv') {
    const { data: ccRows } = await adminSb
      .from('campaign_contacts')
      .select('id, phone')
      .eq('campaign_id', campaign_id)
    for (const r of (ccRows ?? [])) ccIds[r.phone] = r.id
  } else {
    for (const c of contacts) if (c.id) ccIds[c.phone] = c.id as string
  }

  let sent = 0, failed = 0

  for (const contact of contacts) {
    if (!contact.phone) { failed++; continue }

    const waPayload = camp.message_type === 'template' && templateName
      ? {
          messaging_product: 'whatsapp',
          to:   contact.phone,
          type: 'template',
          template: {
            name:       templateName,
            language:   { code: templateLang },
            components: [],
          },
        }
      : {
          messaging_product: 'whatsapp',
          to:   contact.phone,
          type: 'text',
          text: { body: camp.message_body ?? '' },
        }

    const waRes = await fetch(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(waPayload),
      },
    )

    const ccId = ccIds[contact.phone]
    if (waRes.ok) {
      sent++
      if (ccId) await adminSb.from('campaign_contacts').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', ccId)
    } else {
      failed++
      const errTxt = await waRes.text()
      console.error(`send-campaign: fallo para ${contact.phone}:`, errTxt)
      if (ccId) await adminSb.from('campaign_contacts').update({ status: 'failed', error_msg: errTxt.slice(0, 500) }).eq('id', ccId)
    }

    // Check if campaign was paused/cancelled externally
    if ((sent + failed) % 20 === 0) {
      const { data: check } = await adminSb.from('campaigns').select('status').eq('id', campaign_id).single()
      if (check?.status === 'paused' || check?.status === 'cancelled') break
    }

    await new Promise(r => setTimeout(r, 100))
  }

  const finalStatus = sent + failed >= contacts.length ? 'completed' : 'paused'
  await adminSb.from('campaigns').update({
    status:          finalStatus,
    sent_count:      sent,
    failed_count:    failed,
    completed_at:    finalStatus === 'completed' ? new Date().toISOString() : null,
    updated_at:      new Date().toISOString(),
  }).eq('id', campaign_id)

  return json({ ok: true, sent, failed, total: contacts.length })
})
