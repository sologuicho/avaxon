import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Broadcast a múltiples contactos ─────────────────────────────────────────
// Envía un mensaje de texto libre a todos los contactos de la org que coincidan
// con el filtro. Solo funciona dentro de la ventana de 24h de WhatsApp (i.e. el
// contacto debe haber escrito antes) — esto es una limitación de la API de Meta.

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

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN     = Deno.env.get('WA_ACCESS_TOKEN')!

  const callerSb = createClient(SUPABASE_URL, SERVICE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user } } = await callerSb.auth.getUser()
  if (!user) return json({ error: 'Unauthorized' }, 401)

  const adminSb = createClient(SUPABASE_URL, SERVICE_KEY)

  const { data: profile } = await adminSb
    .from('profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()

  let body: {
    message?:           string
    template_name?:     string
    template_language?: string
    filter:             'all' | 'new' | 'qualified' | 'active_24h'
    org_id?:            string
    preview?:           boolean
  }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  let orgId = profile?.organization_id
  if (profile?.role === 'super_admin' && body.org_id) orgId = body.org_id
  if (!orgId) return json({ error: 'No se encontró organización' }, 404)

  const { message, template_name, template_language = 'es_MX', filter = 'all', preview = false } = body
  const isTemplate = !!template_name?.trim()
  if (!preview && !isTemplate && !message?.trim()) return json({ error: 'message o template_name es requerido' }, 422)

  // Obtener contactos según filtro
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  let contactQuery = adminSb
    .from('contacts')
    .select('id, phone, name')
    .eq('organization_id', orgId)
    .not('phone', 'is', null)

  if (filter === 'new')        contactQuery = contactQuery.eq('status', 'new')
  if (filter === 'qualified')  contactQuery = contactQuery.eq('status', 'qualified')
  if (filter === 'active_24h') contactQuery = contactQuery.gte('last_seen_at', since24h)

  const { data: contacts } = await contactQuery
  const total = (contacts ?? []).length

  // En modo preview solo devolvemos el conteo
  if (preview) return json({ total })

  // Obtener número de WhatsApp de la org
  const { data: pn } = await adminSb
    .from('phone_numbers')
    .select('phone_number_id, whatsapp_accounts(access_token)')
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .maybeSingle()

  if (!pn?.phone_number_id) return json({ error: 'No hay número de WhatsApp activo' }, 422)

  const phoneNumberId = pn.phone_number_id
  const token         = (pn.whatsapp_accounts as any)?.access_token ?? WA_TOKEN

  let sent = 0
  let failed = 0

  for (const contact of (contacts ?? [])) {
    if (!contact.phone) { failed++; continue }

    const waPayload = isTemplate
      ? {
          messaging_product: 'whatsapp',
          to:   contact.phone,
          type: 'template',
          template: {
            name:     template_name!.trim(),
            language: { code: template_language },
            components: [],
          },
        }
      : {
          messaging_product: 'whatsapp',
          to:   contact.phone,
          type: 'text',
          text: { body: message!.trim() },
        }

    const waRes = await fetch(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(waPayload),
      },
    )

    if (waRes.ok) {
      sent++
    } else {
      failed++
      const err = await waRes.text()
      console.error(`Broadcast falló para ${contact.phone}:`, err)
    }

    // Pausa breve para no saturar la API de Meta
    await new Promise(r => setTimeout(r, 120))
  }

  return json({ ok: true, sent, failed, total })
})
