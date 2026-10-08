import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Avisa a Avaxon por WhatsApp cuando un cliente crea una solicitud de
// cambio a su agente ─────────────────────────────────────────────────────────
// El cliente ya insertó la fila en agent_change_requests (RLS se lo permite
// para su propia org); esta función solo dispara el aviso al número interno
// de Avaxon (REPORT_PHONE), igual que el aviso de lead_qualified.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const TYPE_LABELS: Record<string, string> = {
  update_info: 'Actualizar información (menú/precios/horarios)',
  change_tone: 'Cambiar cómo responde (tono/estilo)',
  add_faq: 'Agregar preguntas frecuentes',
  other: 'Otro',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN = Deno.env.get('WA_ACCESS_TOKEN')!
  const WA_PHONE_NUMBER_ID = Deno.env.get('WA_PHONE_NUMBER_ID')!
  const REPORT_PHONE = Deno.env.get('REPORT_PHONE')

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: { request_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  if (!body.request_id) return json({ error: 'request_id requerido' }, 422)

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient
    .from('profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .maybeSingle()

  const { data: reqRow } = await adminClient
    .from('agent_change_requests')
    .select('organization_id, type, description, priority, organizations(name)')
    .eq('id', body.request_id)
    .maybeSingle()

  if (!reqRow) return json({ error: 'Solicitud no encontrada' }, 404)
  if (profile?.role !== 'super_admin' && reqRow.organization_id !== profile?.organization_id) {
    return json({ error: 'No autorizado' }, 403)
  }

  if (!REPORT_PHONE) {
    console.error('REPORT_PHONE no configurado')
    return json({ ok: false, skipped: true, error: 'REPORT_PHONE no configurado' })
  }

  const orgName = (reqRow.organizations as { name?: string } | null)?.name ?? 'cliente'
  const typeLabel = TYPE_LABELS[reqRow.type] ?? reqRow.type
  const urgentTag = reqRow.priority === 'urgent' ? ' 🔴 URGENTE' : ''
  const text = `🛠️ *Nueva solicitud de cambio${urgentTag} — ${orgName}*\n\n*Tipo:* ${typeLabel}\n*Descripción:* ${reqRow.description}`

  const waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: REPORT_PHONE,
      type: 'text',
      text: { body: text },
    }),
  })

  if (!waRes.ok) {
    const errBody = await waRes.text()
    console.error('Error notificando solicitud de cambio:', errBody)
    return json({ ok: false, error: 'No se pudo enviar el aviso por WhatsApp' }, 502)
  }

  return json({ ok: true })
})
