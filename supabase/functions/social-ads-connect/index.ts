import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { encryptField } from '../_shared/crypto.ts'
import { corsHeaders, json, resolveAdsCaller } from '../_shared/socialAdsAuth.ts'
import { listAdAccounts, translateMetaError } from '../_shared/metaAds.ts'

// ── Conectar cuenta publicitaria de Meta ────────────────────────────────────
// Dos pasos desde el mismo endpoint (igual patrón que social-oauth-callback):
//   1) body { access_token } -> intercambia por token largo, lista las
//      cuentas publicitarias que administra el usuario, regresa la lista
//      SIN guardar nada todavía (el cliente elige una en el dashboard).
//   2) body { access_token, ad_account_id } -> vuelve a listar (nunca confía
//      en datos que el cliente pudo mandar sueltos), valida que esa cuenta
//      esté en la lista, detecta cuenta deshabilitada o sin método de pago,
//      cifra el token y hace upsert en social_ad_connections.
//
// NUNCA usa una cuenta publicitaria de Avaxon como respaldo -- si el
// usuario no tiene ninguna cuenta elegible, se detiene con un mensaje claro.
//
// Secrets requeridos: META_APP_ID, META_APP_SECRET (mismos que
// social-oauth-callback -- es la misma app de Meta, solo se pide el scope
// ads_management/ads_read además de los de publicaciones).
//
// NO está desplegada a producción -- solo existe en el repo para revisión
// (ver docs/promociones-meta.md).

const GRAPH = (version: string) => `https://graph.facebook.com/${version}`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const resolved = await resolveAdsCaller(req)
  if ('error' in resolved) return resolved.error
  const { ctx } = resolved

  const META_APP_ID = Deno.env.get('META_APP_ID')
  const META_APP_SECRET = Deno.env.get('META_APP_SECRET')
  if (!META_APP_ID || !META_APP_SECRET) {
    return json({ error: 'Conexión de cuentas publicitarias no está configurada (falta META_APP_ID/META_APP_SECRET)' }, 500)
  }
  const version = Deno.env.get('META_MARKETING_API_VERSION') || 'v25.0'

  let body: { access_token?: string; ad_account_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const shortToken = body.access_token
  if (!shortToken) return json({ error: 'access_token es requerido' }, 422)

  // ── Intercambiar token corto por uno de larga duración ────────────────────
  const exchangeRes = await fetch(
    `${GRAPH(version)}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortToken}`,
  )
  const exchangeData = await exchangeRes.json()
  if (!exchangeRes.ok || !exchangeData.access_token) {
    return json({ error: translateMetaError(exchangeData) }, 502)
  }
  const longToken = exchangeData.access_token as string
  const expiresIn = typeof exchangeData.expires_in === 'number' ? exchangeData.expires_in : null
  const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null

  // ── Listar cuentas publicitarias que administra ───────────────────────────
  let accounts: Awaited<ReturnType<typeof listAdAccounts>>
  try {
    accounts = await listAdAccounts(longToken)
  } catch (e: any) {
    return json({ error: e.message ?? 'No se pudo consultar las cuentas publicitarias' }, 502)
  }

  if (!accounts.length) {
    return json({ error: 'No se encontró ninguna cuenta publicitaria que administres en Meta. Crea una en Business Manager antes de continuar.' }, 422)
  }

  // ── Paso 1: solo listar, sin guardar nada ─────────────────────────────────
  if (!body.ad_account_id) {
    return json({
      ok: true,
      accounts: accounts.map(a => ({
        id: a.id, name: a.name, currency: a.currency,
        disabled: a.account_status !== 1,
        has_payment_method: !!a.funding_source_details,
      })),
    })
  }

  // ── Paso 2: guardar la cuenta elegida ─────────────────────────────────────
  const chosen = accounts.find(a => a.id === body.ad_account_id)
  if (!chosen) return json({ error: 'Esa cuenta publicitaria ya no aparece entre las que administras. Vuelve a intentar la conexión.' }, 422)

  if (chosen.account_status !== 1) {
    return json({ error: 'Esa cuenta publicitaria está deshabilitada en Meta. Revísala en Business Manager (Configuración del negocio → Cuentas publicitarias) antes de conectarla aquí.' }, 422)
  }
  if (!chosen.funding_source_details) {
    return json({ error: 'Esa cuenta publicitaria no tiene un método de pago configurado. Agrega uno en Meta (Administrador de anuncios → Configuración de facturación) antes de conectarla.' }, 422)
  }

  const encryptedToken = await encryptField(longToken)
  const { data: row, error: upsertErr } = await ctx.adminClient
    .from('social_ad_connections')
    .upsert({
      organization_id: ctx.organizationId,
      ad_account_id: chosen.id,
      ad_account_name: chosen.name,
      currency: chosen.currency,
      access_token: encryptedToken,
      status: 'connected',
      last_error_code: null,
      last_error_message: null,
      scopes: 'ads_management,ads_read',
      connected_by: ctx.userId,
      connected_at: new Date().toISOString(),
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id' })
    .select('id, ad_account_id, ad_account_name, currency, status')
    .single()

  if (upsertErr || !row) {
    console.error('social-ads-connect: error guardando social_ad_connections:', upsertErr)
    return json({ error: `Error guardando la conexión: ${upsertErr?.message}` }, 500)
  }

  return json({ ok: true, connection: row })
})
