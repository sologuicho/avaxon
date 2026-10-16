import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Permite a un super_admin actualizar el estado de una requisición de
// herramienta ────────────────────────────────────────────────────────────────

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

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Verify authentication
  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  // Verify super_admin role
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (profile?.role !== 'super_admin') {
    return json({ error: 'Forbidden: super_admin role required' }, 403)
  }

  // Parse body
  let body: { requisition_id?: string; status?: string; notes?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  if (!body.requisition_id) return json({ error: 'requisition_id requerido' }, 422)
  if (!body.status) return json({ error: 'status requerido' }, 422)

  const validStatuses = ['pending', 'approved', 'rejected', 'in_progress', 'done']
  if (!validStatuses.includes(body.status)) {
    return json({ error: `status inválido. Valores permitidos: ${validStatuses.join(', ')}` }, 422)
  }

  // Build update payload
  const updatePayload: Record<string, unknown> = {
    status: body.status,
    updated_at: new Date().toISOString(),
  }
  if (body.notes !== undefined) {
    updatePayload.notes = body.notes
  }

  const { error: updateErr } = await adminClient
    .from('tool_requisitions')
    .update(updatePayload)
    .eq('id', body.requisition_id)

  if (updateErr) {
    console.error('Error actualizando tool_requisition:', updateErr)
    return json({ error: 'No se pudo actualizar la requisición' }, 500)
  }

  return json({ ok: true })
})
