import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyState } from '../_shared/google.ts'

// ── Callback de Google OAuth (Calendar + Sheets) ─────────────────────────────
// Google redirige aquí al navegador del usuario (sin JWT de Supabase, por
// eso la función se despliega con --no-verify-jwt). La única autorización
// válida es el `state` firmado por google-oauth-start. Intercambia el code
// por tokens, obtiene el email de la cuenta, y guarda credentials/config en
// las filas google_calendar y google_sheets de esa organización.

const DASHBOARD_URL = 'https://avaxon.lat/dashboard/'
const GOOGLE_REDIRECT_URI = 'https://wprvjhvtnyibiwpeiusc.supabase.co/functions/v1/google-oauth-callback'

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } })
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const googleError = url.searchParams.get('error')

  const OAUTH_STATE_SECRET = Deno.env.get('OAUTH_STATE_SECRET')
  const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')
  const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  if (!OAUTH_STATE_SECRET || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error('Faltan secrets: OAUTH_STATE_SECRET / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET')
    return redirect(`${DASHBOARD_URL}?conexion=google_error`)
  }

  if (googleError || !code || !state) {
    if (googleError) console.error('Google devolvió error:', googleError)
    return redirect(`${DASHBOARD_URL}?conexion=google_error`)
  }

  try {
    const verified = await verifyState(state, OAUTH_STATE_SECRET)
    if (!verified) {
      console.error('state inválido o expirado')
      return redirect(`${DASHBOARD_URL}?conexion=google_error`)
    }
    const organizationId = verified.org

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Google token exchange failed:', tokenData)
      return redirect(`${DASHBOARD_URL}?conexion=google_error`)
    }

    let email: string | null = null
    try {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      })
      const info = await infoRes.json()
      email = info.email ?? null
    } catch (e) {
      console.error('No se pudo obtener el email de Google:', e)
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // Si Google no reenvía refresh_token (ya hubo un consentimiento previo),
    // conserva el que ya teníamos guardado en vez de borrarlo.
    let refreshToken: string | null = tokenData.refresh_token ?? null
    if (!refreshToken) {
      const { data: existing } = await sb
        .from('integrations')
        .select('credentials')
        .eq('organization_id', organizationId)
        .eq('provider', 'google_calendar')
        .maybeSingle()
      refreshToken = (existing?.credentials as { refresh_token?: string } | null)?.refresh_token ?? null
    }

    const credentials = {
      access_token: tokenData.access_token,
      refresh_token: refreshToken,
      expires_at: new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString(),
    }
    const now = new Date().toISOString()

    // Preserva el spreadsheet_id si ya estaba configurado (reconectar no debe borrarlo).
    const { data: existingSheets } = await sb
      .from('integrations')
      .select('config')
      .eq('organization_id', organizationId)
      .eq('provider', 'google_sheets')
      .maybeSingle()
    const sheetsConfig = { ...(existingSheets?.config ?? {}), email }

    const rows = [
      { provider: 'google_calendar', config: { email } },
      { provider: 'google_sheets', config: sheetsConfig },
    ].map(({ provider, config }) => ({
      organization_id: organizationId,
      provider,
      status: 'connected',
      credentials,
      config,
      connected_at: now,
      updated_at: now,
    }))

    const { error: upsertErr } = await sb
      .from('integrations')
      .upsert(rows, { onConflict: 'organization_id,provider' })

    if (upsertErr) {
      console.error('Error guardando integrations:', upsertErr)
      return redirect(`${DASHBOARD_URL}?conexion=google_error`)
    }

    return redirect(`${DASHBOARD_URL}?conexion=google_ok`)
  } catch (e) {
    console.error('google-oauth-callback error:', e)
    return redirect(`${DASHBOARD_URL}?conexion=google_error`)
  }
})
