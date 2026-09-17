import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── WhatsApp Embedded Signup (Meta) ─────────────────────────────────────────
// El cliente conecta su propio número de WhatsApp Business desde su panel,
// vía el popup oficial de Meta. El frontend (dashboard) manda aquí el código
// de autorización + el waba_id/phone_number_id que Meta entrega por
// postMessage; esta función:
//   1. Intercambia el código por un token (confirma que Meta compartió el
//      WABA del cliente con el Business de Avaxon)
//   2. Registra el número en la app de Avaxon
//   3. Suscribe la app al WABA para recibir sus webhooks
//   4. Guarda el número en la BD, ligado a la organización del usuario que
//      inició sesión (nunca a un organization_id que mande el cliente)
//   5. Crea un bot_config por defecto si la org aún no tiene uno
//
// Requiere los secrets META_APP_ID y META_APP_SECRET (del Meta App Dashboard,
// no confundir con WA_ACCESS_TOKEN que es el System User Token de Avaxon).

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
    console.error('META_APP_ID / META_APP_SECRET no configurados')
    return json({ error: 'Embedded Signup no está configurado todavía (falta META_APP_ID/META_APP_SECRET)' }, 500)
  }

  // Cliente con el JWT del caller, para saber quién es
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

  let body: { code?: string; waba_id?: string; phone_number_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { code, waba_id, phone_number_id } = body
  if (!code || !waba_id || !phone_number_id) {
    return json({ error: 'code, waba_id y phone_number_id son requeridos' }, 422)
  }

  // ── 1. Intercambiar el código de autorización por un token ─────────────────
  const tokenRes = await fetch(
    `https://graph.facebook.com/v20.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}`
  )
  const tokenData = await tokenRes.json()
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error('Fallo el intercambio de código con Meta:', tokenData)
    return json({ error: `Meta no aceptó el código de autorización: ${tokenData.error?.message ?? JSON.stringify(tokenData)}` }, 502)
  }

  // ── 2. Registrar el número en la app de Avaxon ──────────────────────────────
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const registerRes = await fetch(`https://graph.facebook.com/v20.0/${phone_number_id}/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  })
  if (!registerRes.ok) {
    const registerData = await registerRes.json()
    console.error('No se pudo registrar el número (puede que ya estuviera registrado):', registerData)
  }

  // ── 3. Suscribir la app al WABA para recibir sus webhooks ──────────────────
  const subRes = await fetch(`https://graph.facebook.com/v20.0/${waba_id}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  })
  if (!subRes.ok) {
    console.error('No se pudo suscribir la app al WABA:', await subRes.json())
  }

  // ── 4. Traer datos del número para guardarlos ───────────────────────────────
  const phoneInfoRes = await fetch(
    `https://graph.facebook.com/v20.0/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating`,
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  )
  const phoneInfo = phoneInfoRes.ok ? await phoneInfoRes.json() : {}

  // ── 5. Guardar en BD, ligado a la organización del usuario que hizo login ──
  const { error: pnErr } = await adminClient
    .from('phone_numbers')
    .upsert(
      {
        organization_id: profile.organization_id,
        phone_number_id,
        display_phone_number: phoneInfo.display_phone_number ?? null,
        verified_name: phoneInfo.verified_name ?? null,
        quality_rating: phoneInfo.quality_rating ?? null,
        status: 'connected',
      },
      { onConflict: 'phone_number_id' }
    )

  if (pnErr) return json({ error: `Error guardando phone_numbers: ${pnErr.message}` }, 500)

  // ── 6. Crear un bot_config por defecto si la org aún no tiene uno ──────────
  const { data: existingBot } = await adminClient
    .from('bot_configs')
    .select('id')
    .eq('organization_id', profile.organization_id)
    .maybeSingle()

  if (!existingBot) {
    await adminClient.from('bot_configs').insert({
      organization_id: profile.organization_id,
      enabled: false, // el cliente lo activa cuando personalice su prompt
      system_prompt: 'Eres el asistente de WhatsApp de este negocio. Responde de forma breve y profesional. Personaliza este mensaje desde tu panel.',
    })
  }

  return json({ ok: true, phone_number_id, waba_id })
})
