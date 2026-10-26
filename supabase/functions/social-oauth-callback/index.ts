import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Publicaciones en redes — OAuth de Facebook/Instagram ────────────────────
// Recibe el access token corto del popup de FB.login() del frontend
// (launchSocialPublishSignup(), scopes de publicación: pages_manage_posts,
// pages_read_engagement, pages_show_list, pages_manage_metadata,
// instagram_business_basic, instagram_business_content_publish).
//
//   1. Cambia el token corto por uno de larga duración (fb_exchange_token)
//   2. GET /me/accounts -> la primera Page que administra el usuario
//   3. Upsert social_accounts (platform='facebook_page')
//   4. GET /{page_id}?fields=instagram_business_account -> si existe,
//      upsert también la fila de Instagram (platform='instagram_business'),
//      reutilizando el token de la Page (así es como funciona la API: IG
//      Business siempre se publica con el token de la Page vinculada, no
//      hay un token de Instagram por separado).
//
// "Conectar Instagram" en el dashboard llama esta MISMA función -- no hay
// un OAuth de Instagram independiente, la cuenta de IG se descubre a
// través de la Page vinculada a nivel de Meta.
//
// El token nunca se regresa al navegador -- solo se usa aquí dentro para
// hablar con graph.facebook.com y se guarda en la base vía el cliente de
// service-role.
//
// Secrets requeridos: META_APP_ID, META_APP_SECRET
//
// NO está desplegada a producción todavía (fase 2 del plan) -- este
// archivo existe en el repo para revisión, no se ha corrido
// `supabase functions deploy` para esta función.

const GRAPH = 'https://graph.facebook.com/v22.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const META_APP_ID      = Deno.env.get('META_APP_ID')
  const META_APP_SECRET  = Deno.env.get('META_APP_SECRET')

  if (!META_APP_ID || !META_APP_SECRET) {
    console.error('META_APP_ID / META_APP_SECRET no configurados en secrets')
    return json({ error: 'Conexión de redes no está configurada (falta META_APP_ID/META_APP_SECRET)' }, 500)
  }

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: profile } = await adminClient
    .from('profiles')
    .select('role, organization_id')
    .eq('id', user.id)
    .single()

  if (!profile?.organization_id || !['admin', 'super_admin'].includes(profile.role ?? '')) {
    return json({ error: 'Forbidden' }, 403)
  }
  const orgId = profile.organization_id

  // Defensa en profundidad: aunque RLS ya lo exige, se revalida aquí para
  // dar un error claro en vez de un 403 genérico de Postgres.
  const { data: moduleRow } = await adminClient
    .from('business_modules')
    .select('enabled')
    .eq('organization_id', orgId)
    .eq('module_key', 'publicaciones_redes')
    .maybeSingle()
  if (!moduleRow?.enabled) {
    return json({ error: 'El módulo de Publicaciones en redes no está activo para esta organización' }, 403)
  }

  let body: { access_token?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const shortToken = body.access_token
  if (!shortToken) return json({ error: 'access_token es requerido' }, 422)

  // ── 1. Cambiar el token corto por uno de larga duración ───────────────────
  const exchangeRes = await fetch(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortToken}`,
  )
  const exchangeData = await exchangeRes.json()
  if (!exchangeRes.ok || !exchangeData.access_token) {
    console.error('Fallo el intercambio de token:', exchangeData)
    return json({ error: `Meta no aceptó el token: ${exchangeData.error?.message ?? JSON.stringify(exchangeData)}` }, 502)
  }
  const longToken = exchangeData.access_token as string
  const expiresIn = typeof exchangeData.expires_in === 'number' ? exchangeData.expires_in : null
  const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null

  // ── 2. La(s) Page(s) que administra -- MVP: solo la primera ───────────────
  const pagesRes = await fetch(`${GRAPH}/me/accounts?fields=id,name,picture,access_token&access_token=${longToken}`)
  const pagesData = await pagesRes.json()
  if (!pagesRes.ok || !pagesData.data?.length) {
    return json({ error: 'No se encontró ninguna página de Facebook que administres. Verifica que la cuenta de Meta tenga al menos una Page.' }, 422)
  }
  const page = pagesData.data[0]
  // Cada Page trae su propio access_token (de Page, no de usuario) -- es
  // el que de verdad se usa para publicar.
  const pageToken = page.access_token as string

  const { data: fbAccount, error: fbErr } = await adminClient
    .from('social_accounts')
    .upsert({
      organization_id: orgId,
      platform: 'facebook_page',
      external_id: page.id,
      name: page.name,
      avatar_url: page.picture?.data?.url ?? null,
      access_token: pageToken,
      status: 'connected',
      last_error_code: null,
      last_error_message: null,
      scopes: 'pages_manage_posts,pages_read_engagement,pages_show_list,pages_manage_metadata',
      connected_by: user.id,
      connected_at: new Date().toISOString(),
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,platform' })
    .select('id, name')
    .single()

  if (fbErr || !fbAccount) {
    console.error('Error guardando social_accounts (facebook_page):', fbErr)
    return json({ error: `Error guardando la página de Facebook: ${fbErr?.message}` }, 500)
  }

  // ── 3. Instagram vinculado a esa Page (si existe) ─────────────────────────
  const igCheckRes = await fetch(`${GRAPH}/${page.id}?fields=instagram_business_account{id,username,profile_picture_url}&access_token=${pageToken}`)
  const igCheckData = await igCheckRes.json()
  const igBusiness = igCheckData?.instagram_business_account

  let igAccount: { id: string; name: string } | null = null
  if (igBusiness?.id) {
    const { data: igRow, error: igErr } = await adminClient
      .from('social_accounts')
      .upsert({
        organization_id: orgId,
        platform: 'instagram_business',
        external_id: igBusiness.id,
        name: igBusiness.username ?? 'Instagram',
        username: igBusiness.username ?? null,
        avatar_url: igBusiness.profile_picture_url ?? null,
        facebook_page_id: page.id,
        access_token: pageToken, // IG Business siempre publica con el token de la Page
        status: 'connected',
        last_error_code: null,
        last_error_message: null,
        scopes: 'instagram_business_basic,instagram_business_content_publish',
        connected_by: user.id,
        connected_at: new Date().toISOString(),
        token_expires_at: tokenExpiresAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'organization_id,platform' })
      .select('id, name')
      .single()

    if (igErr) {
      console.error('Error guardando social_accounts (instagram_business):', igErr)
      // No es fatal para la conexión de Facebook -- se reporta como warning.
    } else if (igRow) {
      igAccount = { id: igRow.id, name: igRow.name }
    }
  }

  return json({
    ok: true,
    facebook_page: { id: fbAccount.id, name: fbAccount.name },
    instagram_business: igAccount,
    instagram_linked: !!igBusiness?.id,
  })
})
