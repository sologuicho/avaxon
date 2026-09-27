import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

// ── Notificación de solicitud de onboarding ─────────────────────────────────
// onboarding.html ya guarda la solicitud directo en la tabla
// onboarding_requests (INSERT con el anon key). Esta función solo se encarga
// de avisar por WhatsApp al número del equipo (REPORT_PHONE) en cuanto llega
// una solicitud nueva, para no depender de que alguien abra el dashboard.
//
// A propósito NO recibe ni reenvía el access_token del cliente — ese dato
// sensible ya quedó guardado en la tabla; no hace falta mandarlo también por
// WhatsApp.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const WA_TOKEN          = Deno.env.get('WA_ACCESS_TOKEN')!
  const WA_PHONE_NUMBER_ID = Deno.env.get('WA_PHONE_NUMBER_ID')!
  const REPORT_PHONE       = Deno.env.get('REPORT_PHONE')

  if (!REPORT_PHONE) {
    console.error('REPORT_PHONE no está configurado — no se puede notificar')
    return json({ error: 'REPORT_PHONE not set' }, 500)
  }

  let body: {
    business_name?: string
    phone_number?: string
    contact_name?: string
    contact_phone?: string
    phone_number_id?: string
    waba_id?: string
  }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const business = body.business_name?.trim() || '(sin nombre)'
  const phone    = body.phone_number?.trim() || '(sin número)'
  const contact  = body.contact_name?.trim() || null
  const contactPhone = body.contact_phone?.trim() || null
  const pnid     = body.phone_number_id?.trim() || '—'
  const waba     = body.waba_id?.trim() || '—'

  const lines = [
    '🆕 Nueva solicitud de onboarding',
    `Negocio: ${business}`,
    `WhatsApp a conectar: ${phone}`,
  ]
  if (contact) lines.push(`Contacto: ${contact}${contactPhone ? ' · ' + contactPhone : ''}`)
  lines.push(`Phone Number ID: ${pnid}`, `WABA ID: ${waba}`)
  lines.push('', 'Revisa el panel admin para activar el número.')

  const waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: REPORT_PHONE,
      type: 'text',
      text: { body: lines.join('\n') },
    }),
  })

  const waData = await waRes.json()
  if (!waRes.ok) {
    console.error('Error mandando notificación de onboarding:', waData)
    return json({ error: waData }, 502)
  }

  return json({ ok: true })
})
