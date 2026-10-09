import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encryptCredentials } from '../_shared/crypto.ts'

// ── Guardado centralizado de integrations ────────────────────────────────────
// El cliente ya no tiene INSERT/UPDATE sobre integrations (ver RLS) ni SELECT
// sobre credentials — todo guardado/desconexión pasa por aquí. Resuelve el
// organization_id en el servidor (valida que el usuario tenga permiso sobre
// esa org, no confía en lo que mande el cliente más allá de esa validación),
// cifra credenciales sensibles antes de persistirlas, y hace el upsert con
// service role.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const ZAPIER_URL_RE = /^https:\/\/hooks\.zapier\.com\//

interface Body {
  organization_id?: string
  provider?: string
  providers?: string[]
  action?: 'connect' | 'disconnect' | 'update_config'
  config?: Record<string, unknown>
  credentials?: Record<string, unknown>
}

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

  let body: Body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient
    .from('profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .maybeSingle()

  const organizationId = body.organization_id
  if (!organizationId) return json({ error: 'organization_id requerido' }, 422)
  if (profile?.role !== 'super_admin' && organizationId !== profile?.organization_id) {
    return json({ error: 'No autorizado para esta organización' }, 403)
  }

  const providers = body.providers?.length ? body.providers : (body.provider ? [body.provider] : [])
  if (!providers.length) return json({ error: 'provider es requerido' }, 422)

  const now = new Date().toISOString()

  if (body.action === 'disconnect') {
    const rows = providers.map(provider => ({
      organization_id: organizationId,
      provider,
      status: 'disconnected',
      credentials: null,
      config: null,
      connected_at: null,
      updated_at: now,
    }))
    const { error } = await adminClient.from('integrations').upsert(rows, { onConflict: 'organization_id,provider' })
    if (error) return json({ error: error.message }, 500)
    return json({ ok: true })
  }

  if (body.action === 'update_config') {
    const provider = providers[0]
    const { data: existing } = await adminClient
      .from('integrations')
      .select('config')
      .eq('organization_id', organizationId)
      .eq('provider', provider)
      .maybeSingle()
    const mergedConfig = { ...((existing?.config as Record<string, unknown>) ?? {}), ...(body.config ?? {}) }
    const { error } = await adminClient
      .from('integrations')
      .update({ config: mergedConfig, updated_at: now })
      .eq('organization_id', organizationId)
      .eq('provider', provider)
    if (error) return json({ error: error.message }, 500)
    return json({ ok: true, config: mergedConfig })
  }

  if (body.action === 'connect') {
    const provider = providers[0]

    if (provider === 'zapier') {
      const webhookUrl = (body.config?.webhook_url as string | undefined)?.trim()
      if (!webhookUrl || !ZAPIER_URL_RE.test(webhookUrl)) {
        return json({ error: 'URL de Zapier inválida (debe empezar con https://hooks.zapier.com/)' }, 422)
      }

      const { data: existing } = await adminClient
        .from('integrations')
        .select('credentials')
        .eq('organization_id', organizationId)
        .eq('provider', 'zapier')
        .maybeSingle()

      let apiKeyPlain: string | null = null
      let credentials = (existing?.credentials as Record<string, unknown> | null) ?? null
      if (!credentials?.api_key_hash) {
        apiKeyPlain = 'avx_' + Array.from(crypto.getRandomValues(new Uint8Array(24)))
          .map(b => b.toString(16).padStart(2, '0')).join('')
        const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKeyPlain))
        const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')
        credentials = { api_key_hash: hashHex }
      }

      const { error } = await adminClient.from('integrations').upsert({
        organization_id: organizationId,
        provider: 'zapier',
        status: 'connected',
        credentials,
        config: { webhook_url: webhookUrl },
        connected_at: now,
        updated_at: now,
      }, { onConflict: 'organization_id,provider' })
      if (error) return json({ error: error.message }, 500)

      return json({ ok: true, api_key: apiKeyPlain })
    }

    if (provider === 'stripe') {
      const publishableKey = (body.credentials?.publishable_key as string | undefined)?.trim()
      const secretKey = (body.credentials?.secret_key as string | undefined)?.trim()
      if (!publishableKey || !secretKey) return json({ error: 'Ingresa ambas claves de Stripe' }, 422)

      const credentials = await encryptCredentials({ publishable_key: publishableKey, secret_key: secretKey })

      const { error } = await adminClient.from('integrations').upsert({
        organization_id: organizationId,
        provider: 'stripe',
        status: 'connected',
        credentials,
        config: body.config ?? {},
        connected_at: now,
        updated_at: now,
      }, { onConflict: 'organization_id,provider' })
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true })
    }

    return json({ error: `provider no soportado para connect: ${provider}` }, 422)
  }

  return json({ error: 'action inválida' }, 422)
})
