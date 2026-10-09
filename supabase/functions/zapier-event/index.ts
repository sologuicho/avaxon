import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendZapierEvent } from '../_shared/zapier.ts'

// ── Puente dashboard → Zapier ─────────────────────────────────────────────────
// El dashboard dispara eventos (cita agendada, conversación cerrada, prueba)
// que ocurren client-side; esta función los reenvía al webhook de Zapier de la
// org usando el helper compartido, para que el secret del webhook nunca viaje
// al navegador. Requiere JWT del usuario logueado.

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

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: { event?: string; organization_id?: string; payload?: Record<string, unknown> }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  if (!body.event) return json({ error: 'event es requerido' }, 422)

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient
    .from('profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .maybeSingle()

  const targetOrgId = body.organization_id || profile?.organization_id
  if (!targetOrgId) return json({ error: 'organization_id requerido' }, 422)
  if (profile?.role !== 'super_admin' && targetOrgId !== profile?.organization_id) {
    return json({ error: 'No autorizado para esta organización' }, 403)
  }

  const result = await sendZapierEvent(adminClient, targetOrgId, body.event, body.payload ?? {})
  return json(result)
})
