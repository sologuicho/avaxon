import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getGoogleAccessToken } from '../_shared/google.ts'

// ── Crea el evento en Google Calendar para una cita de `appointments` ───────
// El dashboard llama aquí justo después de insertar la cita (saveQuickApt).
// Usa getGoogleAccessToken (refresca el token si ya expiró) y crea el evento
// en el calendario primario de la cuenta de Google conectada para la org, en
// America/Matamoros. Guarda el event id en appointments.google_event_id.
//
// Si la org no tiene Google Calendar conectado, responde ok con skipped:true
// (no es un error — es una integración opcional).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const TIMEZONE = 'America/Matamoros'
const DEFAULT_DURATION_MIN = 60

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

  let body: { organization_id?: string; appointment_id?: string }
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
  if (!body.appointment_id) return json({ error: 'appointment_id requerido' }, 422)

  const { data: appt, error: apptErr } = await adminClient
    .from('appointments')
    .select('id, title, notes, scheduled_at, duration_minutes')
    .eq('id', body.appointment_id)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (apptErr || !appt) return json({ error: 'Cita no encontrada' }, 404)

  const accessToken = await getGoogleAccessToken(adminClient, organizationId)
  if (!accessToken) {
    return json({ ok: false, skipped: true, error: 'Google Calendar no está conectado para esta organización' })
  }

  const startDate = new Date(appt.scheduled_at)
  const durationMin = appt.duration_minutes ?? DEFAULT_DURATION_MIN
  const endDate = new Date(startDate.getTime() + durationMin * 60 * 1000)

  const gRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: appt.title,
      description: appt.notes || undefined,
      start: { dateTime: startDate.toISOString(), timeZone: TIMEZONE },
      end:   { dateTime: endDate.toISOString(), timeZone: TIMEZONE },
    }),
  })

  const gData = await gRes.json()
  if (!gRes.ok) {
    console.error('Error creando evento en Google Calendar:', JSON.stringify(gData))
    return json({ ok: false, error: gData.error?.message || `Google Calendar respondió ${gRes.status}` }, 502)
  }

  await adminClient.from('appointments')
    .update({ google_event_id: gData.id, updated_at: new Date().toISOString() })
    .eq('id', appt.id)

  return json({ ok: true, event_id: gData.id, html_link: gData.htmlLink })
})
