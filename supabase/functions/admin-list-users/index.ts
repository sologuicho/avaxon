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

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const adminClient      = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Verificar que el caller es super_admin
  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const { data: callerProfile } = await adminClient
    .from('profiles').select('role').eq('id', user.id).single()
  if (callerProfile?.role !== 'super_admin') return json({ error: 'Forbidden' }, 403)

  // Obtener todos los usuarios de auth con paginación
  const { data: authData, error: authListErr } = await adminClient.auth.admin.listUsers({
    page: 1, perPage: 1000,
  })
  if (authListErr) return json({ error: authListErr.message }, 500)

  // Obtener profiles con org data
  const { data: profiles } = await adminClient
    .from('profiles')
    .select('id, role, full_name, organization_id, organizations(id, name, status, plan_id, created_at)')

  // Obtener número de tenant por org (orden por created_at)
  const { data: orgsOrdered } = await adminClient
    .from('organizations')
    .select('id')
    .order('created_at', { ascending: true })

  const orgNumberMap: Record<string, number> = {}
  orgsOrdered?.forEach((o, i) => { orgNumberMap[o.id] = i + 1 })

  const profileMap: Record<string, typeof profiles extends (infer T)[] | null ? T : never> = {}
  profiles?.forEach(p => { profileMap[p.id] = p })

  const users = authData.users.map(u => {
    const profile = profileMap[u.id]
    const org = (profile as any)?.organizations ?? null
    return {
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in: u.last_sign_in_at,
      full_name: profile?.full_name ?? null,
      role: profile?.role ?? null,
      organization_id: profile?.organization_id ?? null,
      org_name: org?.name ?? null,
      org_status: org?.status ?? null,
      org_plan: org?.plan_id ?? null,
      org_created_at: org?.created_at ?? null,
      tenant_number: profile?.organization_id ? (orgNumberMap[profile.organization_id] ?? null) : null,
    }
  })

  // Ordenar: super_admin primero, luego por created_at
  users.sort((a, b) => {
    if (a.role === 'super_admin' && b.role !== 'super_admin') return -1
    if (b.role === 'super_admin' && a.role !== 'super_admin') return 1
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  })

  return json({ users })
})
