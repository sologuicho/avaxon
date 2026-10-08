import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { signState } from '../_shared/google.ts'

// ── Inicio del flujo de Google OAuth ─────────────────────────────────────────
// Requiere el JWT del usuario logueado en el dashboard: resuelve su
// organization_id y devuelve un `state` firmado (HMAC) que el frontend añade
// a la URL de consentimiento de Google. Firmar aquí (server-side) es lo que
// evita que el secret HMAC tenga que viajar al navegador.

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
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const OAUTH_STATE_SECRET = Deno.env.get('OAUTH_STATE_SECRET')

  if (!OAUTH_STATE_SECRET) {
    console.error('OAUTH_STATE_SECRET no configurado')
    return json({ error: 'OAuth no configurado' }, 500)
  }

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient
    .from('profiles')
    .select('organization_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile?.organization_id) return json({ error: 'Usuario sin organización' }, 422)

  const state = await signState(profile.organization_id, OAUTH_STATE_SECRET)
  return json({ state })
})
