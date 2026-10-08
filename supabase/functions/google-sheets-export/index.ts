import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getGoogleAccessToken } from '../_shared/google.ts'

// ── Exporta filas a la hoja de cálculo de Google Sheets conectada ───────────
// Usa getGoogleAccessToken (misma cuenta/grant que Google Calendar). Requiere
// integrations.google_sheets.config.spreadsheet_id configurado.
//
// Limitación conocida de scope: el OAuth se pidió con drive.file, que solo
// da acceso a archivos creados por esta app o elegidos por el usuario vía el
// selector de Drive — NO a cualquier hoja existente pegada por ID a mano. Si
// la hoja configurada es una hoja ya existente del usuario, este POST puede
// fallar con 403 PERMISSION_DENIED; eso no es un bug de este código, es el
// scope actual. Ampliar a https://www.googleapis.com/auth/spreadsheets
// (y reconectar) lo resolvería.

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

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: { organization_id?: string; rows?: unknown[][] }
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

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return json({ error: 'rows es requerido (array de arrays)' }, 422)
  }
  if (body.rows.length > 500) {
    return json({ error: 'Máximo 500 filas por envío' }, 422)
  }

  const { data: integ } = await adminClient
    .from('integrations')
    .select('config, status')
    .eq('organization_id', organizationId)
    .eq('provider', 'google_sheets')
    .maybeSingle()

  const spreadsheetId = (integ?.config as { spreadsheet_id?: string } | null)?.spreadsheet_id
  if (integ?.status !== 'connected' || !spreadsheetId) {
    return json({ ok: false, skipped: true, error: 'Google Sheets no está conectado o no tiene hoja configurada' })
  }

  const accessToken = await getGoogleAccessToken(adminClient, organizationId)
  if (!accessToken) {
    return json({ ok: false, skipped: true, error: 'Google no está conectado para esta organización' })
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`

  const gRes = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: body.rows }),
  })

  const gData = await gRes.json()
  if (!gRes.ok) {
    console.error('Error exportando a Google Sheets:', JSON.stringify(gData))
    return json({
      ok: false,
      error: gData.error?.message || `Google Sheets respondió ${gRes.status}`,
      status_code: gData.error?.status,
    }, 502)
  }

  return json({ ok: true, updates: gData.updates })
})
