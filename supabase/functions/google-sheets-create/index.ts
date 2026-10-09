import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getGoogleAccessToken } from '../_shared/google.ts'

// ── Crea automáticamente la hoja "Avaxon - Leads" ───────────────────────────
// El scope OAuth pedido es drive.file, que SOLO da acceso a archivos que esta
// app creó (o que el usuario eligió vía el picker de Drive) — nunca a una
// hoja existente pegada por ID a mano (de ahí el "Requested entity was not
// found" al exportar contra un ID pegado manualmente). Crear la hoja aquí,
// vía la Sheets API con el mismo token, SÍ cae dentro del scope: la app es
// quien la crea, así que conserva acceso para futuras exportaciones.
//
// Guarda el spreadsheet_id resultante en integrations.google_sheets.config.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const SHEET_TITLE = 'Avaxon - Leads'
const HEADERS = ['Fecha', 'Nombre', 'Teléfono', 'Mensaje', 'Estado']

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

  let body: { organization_id?: string }
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

  const accessToken = await getGoogleAccessToken(adminClient, organizationId)
  if (!accessToken) {
    return json({ ok: false, skipped: true, error: 'Google no está conectado para esta organización' })
  }

  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title: SHEET_TITLE },
      sheets: [{ properties: { title: 'Leads' } }],
    }),
  })
  const createData = await createRes.json()
  if (!createRes.ok) {
    console.error('Error creando spreadsheet:', JSON.stringify(createData))
    return json({ ok: false, error: createData.error?.message || `Google Sheets respondió ${createRes.status}` }, 502)
  }

  const spreadsheetId = createData.spreadsheetId as string
  const spreadsheetUrl = createData.spreadsheetUrl as string

  const headerRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:E1?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [HEADERS] }),
    },
  )
  if (!headerRes.ok) {
    const headerData = await headerRes.json().catch(() => ({}))
    console.error('Hoja creada pero no se pudieron escribir encabezados:', JSON.stringify(headerData))
    // La hoja sí se creó — seguimos y guardamos igual, los encabezados no son críticos.
  }

  const { data: existing } = await adminClient
    .from('integrations')
    .select('config')
    .eq('organization_id', organizationId)
    .eq('provider', 'google_sheets')
    .maybeSingle()

  const newConfig = { ...((existing?.config as Record<string, unknown>) ?? {}), spreadsheet_id: spreadsheetId }
  const { error: updErr } = await adminClient
    .from('integrations')
    .update({ config: newConfig, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('provider', 'google_sheets')

  if (updErr) return json({ ok: false, error: 'Hoja creada pero no se pudo guardar: ' + updErr.message }, 500)

  return json({ ok: true, spreadsheet_id: spreadsheetId, url: spreadsheetUrl })
})
