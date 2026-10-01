import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: {
    business_name?: string
    contact_name?: string
    phone_number?: string
    contact_phone?: string
    email?: string
    phone_number_id?: string
    waba_id?: string
  }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const WA_TOKEN      = Deno.env.get('WA_ACCESS_TOKEN')!
  const WA_PHONE_ID   = '1348271025028457'
  const NOTIFY_TO     = '19563285800'

  const lines = [
    `*Nueva solicitud de onboarding* 🚀`,
    ``,
    `*Negocio:* ${body.business_name ?? '—'}`,
    `*Contacto:* ${body.contact_name ?? '—'}`,
    `*Tel. de contacto:* ${body.contact_phone ?? '—'}`,
    `*Email:* ${body.email ?? '—'}`,
    `*Número WA:* ${body.phone_number ?? '—'}`,
    `*WABA ID:* ${body.waba_id ?? '—'}`,
    `*Phone Number ID:* ${body.phone_number_id ?? '—'}`,
  ]

  const waRes = await fetch(
    `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: NOTIFY_TO,
        type: 'text',
        text: { body: lines.join('\n') },
      }),
    }
  )

  const waData = await waRes.json()
  if (!waRes.ok) {
    return json({ error: `WA error: ${waData.error?.message ?? JSON.stringify(waData)}` }, 502)
  }

  return json({ ok: true, wa_message_id: waData.messages?.[0]?.id ?? null })
})
