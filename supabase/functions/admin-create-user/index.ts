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

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: callerProfile } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (callerProfile?.role !== 'super_admin') {
    return json({ error: 'Forbidden: super_admin required' }, 403)
  }

  let body: Record<string, string>
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { full_name, email, role, organization_id } = body

  if (!full_name?.trim() || !email?.trim() || !role?.trim()) {
    return json({ error: 'full_name, email y role son requeridos' }, 422)
  }

  const validRoles = ['super_admin', 'admin', 'agent']
  if (!validRoles.includes(role)) {
    return json({ error: `Rol inválido. Debe ser uno de: ${validRoles.join(', ')}` }, 422)
  }

  const { data: inviteData, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(
    email.trim(),
    {
      data: { full_name: full_name.trim() },
      redirectTo: 'https://avaxon.lat/dashboard/',
    }
  )

  if (inviteErr || !inviteData?.user) {
    return json({ error: `Error al invitar: ${inviteErr?.message}` }, 500)
  }

  const newUser = inviteData.user

  const { error: profileErr } = await adminClient.from('profiles').insert({
    id: newUser.id,
    role: role.trim(),
    organization_id: organization_id?.trim() || null,
    full_name: full_name.trim(),
  })

  if (profileErr) {
    return json({ error: `Usuario creado pero falló el perfil: ${profileErr.message}` }, 500)
  }

  return json({ ok: true, user_id: newUser.id, email: newUser.email, role })
})
