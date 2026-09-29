import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })

const DEFAULT_PROMPT = (name: string) =>
  `Eres el asistente virtual de ${name}. Responde siempre en español, de forma amable y profesional.\n\nResponde ÚNICAMENTE en formato JSON con esta estructura:\n{"text": "tu respuesta aquí", "buttons": [], "notify_owner": false}\n\nSolo pon notify_owner en true cuando el cliente quiera agendar una cita o hablar con alguien del equipo.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Verify caller is super_admin
  const callerSb = createClient(SUPABASE_URL, SERVICE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user } } = await callerSb.auth.getUser()
  if (!user) return json({ error: 'Unauthorized' }, 401)

  const adminSb = createClient(SUPABASE_URL, SERVICE_KEY)

  const { data: callerProfile } = await adminSb
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (callerProfile?.role !== 'super_admin') return json({ error: 'Forbidden' }, 403)

  let body: { request_id: string; client_email: string; plan_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { request_id, client_email, plan_id = 'pro' } = body
  if (!request_id || !client_email) return json({ error: 'request_id y client_email son requeridos' }, 422)

  // Get onboarding request
  const { data: onbReq, error: onbErr } = await adminSb
    .from('onboarding_requests')
    .select('*')
    .eq('id', request_id)
    .single()

  if (onbErr || !onbReq) return json({ error: 'Solicitud no encontrada' }, 404)
  if (onbReq.status === 'activated') return json({ error: 'Esta solicitud ya fue activada' }, 409)

  // ── 1. Crear organización ──────────────────────────────────────────────
  const { data: org, error: orgErr } = await adminSb
    .from('organizations')
    .insert({ name: onbReq.business_name, status: 'active', plan_id })
    .select('id')
    .single()

  if (orgErr || !org) return json({ error: 'Error al crear organización: ' + orgErr?.message }, 500)

  // ── 2. WhatsApp account + phone number ────────────────────────────────
  const { data: wa, error: waErr } = await adminSb
    .from('whatsapp_accounts')
    .insert({
      organization_id: org.id,
      waba_id:         onbReq.waba_id,
      business_name:   onbReq.business_name,
      access_token:    onbReq.access_token,
      status:          'active',
    })
    .select('id')
    .single()

  if (waErr || !wa) return json({ error: 'Error al crear cuenta WA: ' + waErr?.message }, 500)

  await adminSb.from('phone_numbers').insert({
    organization_id:      org.id,
    whatsapp_account_id:  wa.id,
    phone_number_id:      onbReq.phone_number_id,
    display_phone_number: onbReq.phone_number,
    verified_name:        onbReq.business_name,
    status:               'active',
  })

  // ── 3. Bot config ────────────────────────────────────────────────────
  await adminSb.from('bot_configs').insert({
    organization_id: org.id,
    enabled:         true,
    system_prompt:   DEFAULT_PROMPT(onbReq.business_name),
  })

  // ── 4. Integrations (todas desconectadas por default) ─────────────────
  await adminSb.from('integrations').insert(
    ['google_calendar', 'google_sheets', 'stripe', 'zapier'].map(provider => ({
      organization_id: org.id,
      provider,
      status: 'disconnected',
    }))
  )

  // ── 5. Subscription (trial 14 días) ──────────────────────────────────
  const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
  await adminSb.from('subscriptions').insert({
    organization_id:      org.id,
    plan_id,
    status:               'trialing',
    current_period_start: new Date().toISOString(),
    current_period_end:   trialEnd,
  })

  // ── 6. Crear usuario + invitar por email ─────────────────────────────
  const { data: newUser, error: userErr } = await adminSb.auth.admin.inviteUserByEmail(client_email, {
    data: { organization_id: org.id },
  })

  if (userErr || !newUser?.user) {
    console.error('Error invitando usuario:', userErr?.message)
    // No abortamos — el admin puede crear el usuario después manualmente
  } else {
    await adminSb.from('profiles').insert({
      id:              newUser.user.id,
      organization_id: org.id,
      role:            'owner',
      full_name:       onbReq.contact_name ?? null,
    })
  }

  // ── 7. Marcar solicitud como activada ─────────────────────────────────
  await adminSb.from('onboarding_requests')
    .update({ status: 'activated' })
    .eq('id', request_id)

  return json({
    ok:     true,
    org_id: org.id,
    user_invited: !userErr,
  })
})
