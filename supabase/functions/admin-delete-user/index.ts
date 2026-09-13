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
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const adminClient      = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const { data: callerProfile } = await adminClient
    .from('profiles').select('role').eq('id', user.id).single()
  if (callerProfile?.role !== 'super_admin') return json({ error: 'Forbidden' }, 403)

  let body: { user_id: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  if (!body.user_id) return json({ error: 'user_id requerido' }, 422)

  // Evitar que el super_admin se elimine a sí mismo
  if (body.user_id === user.id) {
    return json({ error: 'No puedes eliminarte a ti mismo' }, 400)
  }

  // Verificar que el target no es otro super_admin
  const { data: targetProfile } = await adminClient
    .from('profiles').select('role').eq('id', body.user_id).single()
  if (targetProfile?.role === 'super_admin') {
    return json({ error: 'No se puede eliminar a otro super_admin' }, 400)
  }

  // Eliminar primero el profile (por si no hay CASCADE)
  await adminClient.from('profiles').delete().eq('id', body.user_id)

  // Eliminar de auth.users
  const { error: deleteErr } = await adminClient.auth.admin.deleteUser(body.user_id)
  if (deleteErr) return json({ error: deleteErr.message }, 500)

  return json({ ok: true })
})
