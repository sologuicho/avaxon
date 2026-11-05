// ── Boilerplate compartido de las Edge Functions social-ads-* ──────────────
// Mismo patrón que social-oauth-callback: JWT del caller -> adminClient
// (service-role) resuelve organization_id/role desde profiles -> revalida
// module_enabled('promocion_publicaciones') a mano (defensa en profundidad,
// RLS ya lo exige pero un 403 con mensaje claro es mejor que un error
// genérico de Postgres).
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { decryptField } from './crypto.ts'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

export interface AdsCallerContext {
  adminClient: SupabaseClient
  userId: string
  organizationId: string
  role: string
}

// Regresa { error: Response } si algo falla (ya listo para "return" directo),
// o { ctx } con el contexto resuelto y el módulo ya validado.
export async function resolveAdsCaller(req: Request): Promise<{ ctx: AdsCallerContext } | { error: Response }> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return { error: json({ error: 'Missing Authorization header' }, 401) }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return { error: json({ error: 'Unauthorized' }, 401) }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient.from('profiles').select('role, organization_id').eq('id', user.id).single()

  if (!profile?.organization_id || !['admin', 'super_admin'].includes(profile.role ?? '')) {
    return { error: json({ error: 'Forbidden' }, 403) }
  }
  const organizationId = profile.organization_id

  const { data: moduleRow } = await adminClient
    .from('business_modules').select('enabled')
    .eq('organization_id', organizationId).eq('module_key', 'promocion_publicaciones')
    .maybeSingle()
  if (!moduleRow?.enabled) {
    return { error: json({ error: 'El módulo de Promocionar publicaciones no está activo para esta organización' }, 403) }
  }

  return { ctx: { adminClient, userId: user.id, organizationId, role: profile.role } }
}

// Trae una promoción y valida que sea de la org del caller -- patrón
// repetido en activate/action, centralizado aquí.
export async function getOwnedPromotion(adminClient: SupabaseClient, organizationId: string, promotionId: string) {
  const { data: promo } = await adminClient.from('social_promotions').select('*').eq('id', promotionId).maybeSingle()
  if (!promo || promo.organization_id !== organizationId) return null
  return promo
}

// Trae la conexión de cuenta publicitaria de la org con el token ya
// descifrado -- nunca regresa el valor cifrado tal cual a quien llame esto
// si lo va a loguear por error; el caller debe usar accessToken solo para
// llamar a Meta, nunca para responder al navegador.
export async function getAdConnection(adminClient: SupabaseClient, organizationId: string) {
  const { data: conn } = await adminClient
    .from('social_ad_connections').select('*').eq('organization_id', organizationId).maybeSingle()
  if (!conn) return null
  const accessToken = await decryptField(conn.access_token)
  return { ...conn, accessToken }
}
