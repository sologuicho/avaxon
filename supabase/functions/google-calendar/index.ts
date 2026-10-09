import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getGoogleAccessToken } from '../_shared/google.ts'

// ── Sincroniza una cita de `appointments` con Google Calendar ───────────────
// El dashboard llama aquí tras crear/editar/eliminar una cita. Usa
// getGoogleAccessToken (refresca el token si ya expiró) y opera sobre el
// calendario primario de la cuenta de Google conectada para la org, en la
// zona horaria configurada en organizations.timezone (default
// America/Matamoros si la columna viene vacía).
//
// action:
//   create  — crea el evento y guarda el id en appointments.google_event_id
//   update  — actualiza el evento existente (la cita ya se editó localmente
//             antes de llamar aquí); si no hay google_event_id, no hace nada
//   delete  — borra el evento existente; si no hay google_event_id, no hace
//             nada. 404/410 (el evento ya no existe en Google) se ignora.
//
// Si la org no tiene Google Calendar conectado, o la cita no tiene
// google_event_id (para update/delete), responde ok con skipped:true — no es
// un error, es una integración opcional / nada que sincronizar.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const DEFAULT_TIMEZONE = 'America/Matamoros'
const DEFAULT_DURATION_MIN = 60

interface Body {
  organization_id?: string
  appointment_id?: string
  action?: 'create' | 'update' | 'delete'
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
  if (!body.appointment_id) return json({ error: 'appointment_id requerido' }, 422)

  const action = body.action ?? 'create'

  const { data: appt, error: apptErr } = await adminClient
    .from('appointments')
    .select('id, title, notes, scheduled_at, duration_minutes, google_event_id')
    .eq('id', body.appointment_id)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (apptErr || !appt) return json({ error: 'Cita no encontrada' }, 404)

  // delete/update sin evento vinculado: nada que hacer en Google.
  if ((action === 'delete' || action === 'update') && !appt.google_event_id) {
    return json({ ok: true, skipped: true })
  }

  const accessToken = await getGoogleAccessToken(adminClient, organizationId)
  if (!accessToken) {
    return json({ ok: true, skipped: true, error: 'Google Calendar no está conectado para esta organización' })
  }

  // ── delete ─────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const delRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${appt.google_event_id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    )
    // 404/410 = ya no existe en Google — se trata como éxito (idempotente).
    if (!delRes.ok && delRes.status !== 404 && delRes.status !== 410) {
      let msg = `Google Calendar respondió ${delRes.status}`
      try { const errData = await delRes.json(); msg = errData.error?.message || msg } catch { /* sin cuerpo */ }
      console.error('Error eliminando evento de Google Calendar:', msg)
      return json({ ok: false, error: msg }, 502)
    }
    return json({ ok: true })
  }

  const { data: org } = await adminClient
    .from('organizations')
    .select('timezone')
    .eq('id', organizationId)
    .maybeSingle()
  const timeZone = org?.timezone || DEFAULT_TIMEZONE

  const startDate = new Date(appt.scheduled_at)
  const durationMin = appt.duration_minutes ?? DEFAULT_DURATION_MIN
  const endDate = new Date(startDate.getTime() + durationMin * 60 * 1000)

  const eventBody = {
    summary: appt.title,
    description: appt.notes || undefined,
    start: { dateTime: startDate.toISOString(), timeZone },
    end:   { dateTime: endDate.toISOString(), timeZone },
  }

  // ── update ─────────────────────────────────────────────────────────────
  if (action === 'update') {
    const patchRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${appt.google_event_id}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody),
      },
    )
    if (patchRes.status === 404 || patchRes.status === 410) {
      // El evento ya no existe en Google — limpia la referencia muerta para
      // no seguir intentando contra un id que nunca va a funcionar.
      await adminClient.from('appointments')
        .update({ google_event_id: null, updated_at: new Date().toISOString() })
        .eq('id', appt.id)
      return json({ ok: true, skipped: true, error: 'El evento ya no existía en Google Calendar' })
    }
    const patchData = await patchRes.json()
    if (!patchRes.ok) {
      console.error('Error actualizando evento en Google Calendar:', JSON.stringify(patchData))
      return json({ ok: false, error: patchData.error?.message || `Google Calendar respondió ${patchRes.status}` }, 502)
    }
    return json({ ok: true, event_id: patchData.id, html_link: patchData.htmlLink })
  }

  // ── create ─────────────────────────────────────────────────────────────
  const postRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(eventBody),
  })

  const postData = await postRes.json()
  if (!postRes.ok) {
    console.error('Error creando evento en Google Calendar:', JSON.stringify(postData))
    return json({ ok: false, error: postData.error?.message || `Google Calendar respondió ${postRes.status}` }, 502)
  }

  await adminClient.from('appointments')
    .update({ google_event_id: postData.id, updated_at: new Date().toISOString() })
    .eq('id', appt.id)

  return json({ ok: true, event_id: postData.id, html_link: postData.htmlLink })
})
