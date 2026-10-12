import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { notifyAppointment } from '../_shared/appointmentEmail.ts'

// ── Dispara el correo de notificación de citas desde el dashboard ──────────
// (el bot de WhatsApp llama notifyAppointment() directo, sin pasar por acá,
// porque ya corre en el mismo runtime). Si el envío falla no debe afectar
// el agendado — el dashboard ya guardó la cita antes de llamar esto.

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

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: { appointment_id?: string; event?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const appointmentId = body.appointment_id
  const event = body.event
  if (!appointmentId || !['created', 'rescheduled', 'cancelled'].includes(event || '')) {
    return json({ error: 'appointment_id y event (created|rescheduled|cancelled) son requeridos' }, 422)
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  await notifyAppointment(adminClient, appointmentId, event as any, 'dashboard')

  return json({ ok: true })
})
