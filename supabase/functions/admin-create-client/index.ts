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

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Client con el JWT del caller para verificar identidad
  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })

  // Verificar que el caller sea super_admin
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

  // Parsear body
  let body: Record<string, string>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { org_name, industry, plan_id, trial_ends_at, admin_name, admin_email } = body

  if (!org_name?.trim() || !admin_name?.trim() || !admin_email?.trim()) {
    return json({ error: 'org_name, admin_name y admin_email son requeridos' }, 422)
  }

  // 1. Crear organización
  const { data: org, error: orgErr } = await adminClient
    .from('organizations')
    .insert({
      name: org_name.trim(),
      industry: industry?.trim() || null,
      plan_id: plan_id || 'starter',
      status: 'active',
      trial_ends_at: trial_ends_at || null,
    })
    .select('id, name')
    .single()

  if (orgErr || !org) {
    return json({ error: `Error al crear organización: ${orgErr?.message}` }, 500)
  }

  // 2. Invitar al usuario admin (Supabase envía el email automáticamente)
  const { data: inviteData, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(
    admin_email.trim(),
    {
      data: { full_name: admin_name.trim() },
      redirectTo: 'https://avaxon.lat/dashboard/',
    }
  )

  if (inviteErr || !inviteData?.user) {
    // Revertir: borrar la org si falló la invitación
    await adminClient.from('organizations').delete().eq('id', org.id)
    return json({ error: `Error al invitar usuario: ${inviteErr?.message}` }, 500)
  }

  const newUser = inviteData.user

  // 3. Crear perfil del nuevo admin
  const { error: profileErr } = await adminClient.from('profiles').insert({
    id: newUser.id,
    role: 'admin',
    organization_id: org.id,
    full_name: admin_name.trim(),
  })

  if (profileErr) {
    return json({ error: `Org e invitación creadas pero falló el perfil: ${profileErr.message}` }, 500)
  }

  // 4. Registrar en invitations
  await adminClient.from('invitations').insert({
    email: admin_email.trim(),
    organization_id: org.id,
    role: 'admin',
    invited_by: user.id,
  })

  return json({ ok: true, org_id: org.id, user_id: newUser.id, org_name: org.name })
})
