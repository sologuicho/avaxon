import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── WhatsApp Embedded Signup (Meta) ─────────────────────────────────────────
// Recibe code + waba_id + phone_number_id del frontend tras el popup de Meta.
//   1. Intercambia el code por el token del cliente
//   2. Suscribe la app al WABA del cliente (con token del cliente)
//   3. Registra el número en la app (con token del cliente)
//   4. Guarda whatsapp_accounts (waba_id, access_token, expires_at)
//   5. Guarda phone_numbers con whatsapp_account_id → el webhook usa esto
//      para mandar mensajes con el token correcto por cliente
//   6. Crea bot_config por defecto si la org no tiene uno
//
// Secrets requeridos: META_APP_ID, META_APP_SECRET, WA_ACCESS_TOKEN

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
  const WA_TOKEN         = Deno.env.get('WA_ACCESS_TOKEN')!

  if (!META_APP_ID || !META_APP_SECRET) {
    console.error('META_APP_ID / META_APP_SECRET no configurados en secrets')
    return json({ error: 'Embedded Signup no está configurado (falta META_APP_ID/META_APP_SECRET en Supabase secrets)' }, 500)
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

  let body: { code?: string; waba_id?: string; phone_number_id?: string; flow_type?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { code, waba_id, phone_number_id, flow_type } = body
  if (!code || !waba_id || !phone_number_id) {
    return json({ error: 'code, waba_id y phone_number_id son requeridos' }, 422)
  }

  const warnings: string[] = []

  // ── 1. Intercambiar code por token del cliente ─────────────────────────────
  const tokenRes = await fetch(
    `${GRAPH}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}`
  )
  const tokenData = await tokenRes.json()
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error('Fallo el intercambio de código:', tokenData)
    return json({ error: `Meta no aceptó el código: ${tokenData.error?.message ?? JSON.stringify(tokenData)}` }, 502)
  }

  const clientToken = tokenData.access_token as string
  const expiresIn   = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : null
  const expiresAt   = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null

  // ── 2. Suscribir la app al WABA del cliente ────────────────────────────────
  const subRes = await fetch(`${GRAPH}/${waba_id}/subscribed_apps`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${clientToken}` },
  })
  if (!subRes.ok) {
    const subData = await subRes.json()
    const msg = subData.error?.message ?? JSON.stringify(subData)
    console.error('subscribed_apps falló:', subData)
    warnings.push(`subscribed_apps: ${msg}`)
  }

  // ── 3. Registrar el número (con token del cliente) ─────────────────────────
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const registerRes = await fetch(`${GRAPH}/${phone_number_id}/register`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ messaging_product: 'whatsapp', pin }),
  })
  if (!registerRes.ok) {
    const regData = await registerRes.json()
    const errCode = regData.error?.code
    const msg     = regData.error?.message ?? JSON.stringify(regData)
    // Código 100038 = número ya registrado — no es un error fatal
    if (errCode === 100038 || msg.toLowerCase().includes('already registered')) {
      console.warn('Número ya registrado, continuando:', regData)
      warnings.push('register (no-fatal): número ya estaba registrado en la API')
    } else {
      console.error('register falló:', regData)
      warnings.push(`register: ${msg}`)
    }
  }

  // ── 4. Traer datos del número ──────────────────────────────────────────────
  const phoneInfoRes = await fetch(
    `${GRAPH}/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating`,
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  )
  const phoneInfo = phoneInfoRes.ok ? await phoneInfoRes.json() : {}

  // ── 5. Upsert whatsapp_accounts ────────────────────────────────────────────
  const { data: waAccount, error: waErr } = await adminClient
    .from('whatsapp_accounts')
    .upsert(
      {
        organization_id: orgId,
        waba_id,
        access_token:    clientToken,
        expires_at:      expiresAt,
        status:          'active',
      },
      { onConflict: 'organization_id,waba_id' }
    )
    .select('id')
    .single()

  if (waErr || !waAccount) {
    console.error('Error guardando whatsapp_accounts:', waErr)
    return json({ error: `Error guardando cuenta de WhatsApp: ${waErr?.message}` }, 500)
  }

  // ── 6. Upsert phone_numbers con whatsapp_account_id ───────────────────────
  //    El webhook resuelve el token del cliente por:
  //    phone_numbers.phone_number_id → whatsapp_account_id → whatsapp_accounts.access_token
  const { error: pnErr } = await adminClient
    .from('phone_numbers')
    .upsert(
      {
        organization_id:      orgId,
        whatsapp_account_id:  waAccount.id,
        phone_number_id,
        display_phone_number: phoneInfo.display_phone_number ?? null,
        verified_name:        phoneInfo.verified_name ?? null,
        quality_rating:       phoneInfo.quality_rating ?? null,
        status:               'connected',
        registration_pin:     pin,
      },
      { onConflict: 'phone_number_id' }
    )

  if (pnErr) {
    console.error('Error guardando phone_numbers:', pnErr)
    return json({ error: `Error guardando número: ${pnErr.message}` }, 500)
  }

  // ── 7. Bot config por defecto si la org no tiene uno ──────────────────────
  const { data: existingBot } = await adminClient
    .from('bot_configs')
    .select('id')
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!existingBot) {
    await adminClient.from('bot_configs').insert({
      organization_id: orgId,
      enabled:         false,
      system_prompt:   'Eres el asistente de WhatsApp de este negocio. Responde de forma breve y profesional. Personaliza este mensaje desde tu panel.',
    })
  }

  return json({
    ok:           true,
    phone_number_id,
    waba_id,
    display_phone: phoneInfo.display_phone_number ?? null,
    expires_at:   expiresAt,
    flow_type:    flow_type ?? null,
    warnings:     warnings.length > 0 ? warnings : undefined,
  })
})
