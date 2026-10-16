import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendEmail } from '../_shared/email.ts'

// ── Recibe solicitudes de nuevas herramientas, las registra en BD y notifica
// al equipo de Avaxon por correo y WhatsApp ──────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

function generateReqId(): string {
  const now = new Date()
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .toUpperCase()
    .padStart(4, '0')
  return `REQ-${yyyymm}-${hex}`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  )
}

function buildEmailHtml(opts: {
  reqId: string
  toolName: string
  description: string
  useCaso: string
  requestedBy: string
  organizationId: string
}): string {
  const ACCENT = '#6366f1'
  return `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:32px 16px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:${ACCENT};padding:20px 24px">
      <span style="color:#fff;font-size:17px;font-weight:700">Avaxon</span>
      <span style="color:#c7d2fe;font-size:13px;margin-left:8px">Solicitud de herramienta</span>
    </div>
    <div style="padding:24px">
      <h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">Nueva herramienta solicitada</h2>
      <p style="margin:0 0 20px;font-size:13px;color:#64748b">ID de requisición: <strong>${escapeHtml(opts.reqId)}</strong></p>
      <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse">
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:8px 0;color:#64748b;width:130px;vertical-align:top">Herramienta</td>
          <td style="padding:8px 0;font-weight:600">${escapeHtml(opts.toolName)}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:8px 0;color:#64748b;vertical-align:top">Descripción</td>
          <td style="padding:8px 0">${escapeHtml(opts.description)}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:8px 0;color:#64748b;vertical-align:top">Caso de uso</td>
          <td style="padding:8px 0">${escapeHtml(opts.useCaso)}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:8px 0;color:#64748b;vertical-align:top">Solicitado por</td>
          <td style="padding:8px 0;font-size:12px;color:#475569">${escapeHtml(opts.requestedBy)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#64748b;vertical-align:top">Organización</td>
          <td style="padding:8px 0;font-size:12px;color:#475569">${escapeHtml(opts.organizationId)}</td>
        </tr>
      </table>
      <div style="margin-top:20px;padding:12px 16px;background:#f1f5f9;border-radius:8px;font-size:13px;color:#475569">
        Estado actual: <strong style="color:${ACCENT}">Pendiente</strong>
      </div>
    </div>
  </div>
</div>`.trim()
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
  const NOTIFY_PHONE = '9563285800'

  // Verify authentication
  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  // Parse body
  let body: { tool_name?: string; description?: string; use_case?: string; organization_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  if (!body.tool_name) return json({ error: 'tool_name requerido' }, 422)
  if (!body.description) return json({ error: 'description requerido' }, 422)
  if (!body.use_case) return json({ error: 'use_case requerido' }, 422)
  if (!body.organization_id) return json({ error: 'organization_id requerido' }, 422)

  const reqId = generateReqId()
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Insert row in tool_requisitions
  const { data: inserted, error: insertErr } = await adminClient
    .from('tool_requisitions')
    .insert({
      req_id: reqId,
      organization_id: body.organization_id,
      requested_by: user.id,
      tool_name: body.tool_name,
      description: body.description,
      use_case: body.use_case,
      status: 'pending',
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    console.error('Error insertando tool_requisition:', insertErr)
    return json({ error: 'No se pudo registrar la solicitud' }, 500)
  }

  // Send email via Resend to both Avaxon team members
  const emailSubject = `[${reqId}] Nueva herramienta solicitada: ${body.tool_name}`
  const emailHtml = buildEmailHtml({
    reqId,
    toolName: body.tool_name,
    description: body.description,
    useCaso: body.use_case,
    requestedBy: user.email ?? user.id,
    organizationId: body.organization_id,
  })

  const emailResult = await sendEmail({
    to: ['luisescobedo@avaxon.lat', 'hectorgarcia@avaxon.lat'],
    subject: emailSubject,
    html: emailHtml,
    from: 'Avaxon <notificaciones@avaxon.lat>',
  })

  if (!emailResult.ok) {
    console.error('Error enviando email de requisición:', emailResult.error)
    // Non-fatal: continue with WhatsApp notification
  }

  // Send WhatsApp notification
  const waText =
    `🔧 *Nueva solicitud de herramienta — ${reqId}*\n\n` +
    `*Herramienta:* ${body.tool_name}\n` +
    `*Descripción:* ${body.description}\n` +
    `*Caso de uso:* ${body.use_case}\n` +
    `*Solicitado por:* ${user.email ?? user.id}\n` +
    `*Org ID:* ${body.organization_id}\n` +
    `*Estado:* Pendiente`

  const waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: NOTIFY_PHONE,
      type: 'text',
      text: { body: waText },
    }),
  })

  if (!waRes.ok) {
    const errBody = await waRes.text()
    console.error('Error enviando WhatsApp de requisición:', errBody)
    // Non-fatal: the row is already inserted
  }

  return json({ ok: true, req_id: reqId, id: inserted.id })
})
