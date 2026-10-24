import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Captura de leads desde el formulario público de la landing (avaxon.lat) ──
// Público, sin auth (visitantes anónimos). Debe desplegarse con JWT
// verification desactivado, igual que webhook-wa.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const AVAXON_ORG_ID = 'e30d23e7-b512-44c8-a0bf-23f102300198'

// Mapea el nombre del plan de la landing al plan_id interno
const PLAN_MAP: Record<string, string> = {
  'Arranque': 'arranque',
  'Mostrador': 'mostrador',
  'Sucursal':  'sucursal',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: { name?: string; phone?: string; business?: string; plan?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const name     = (body.name     ?? '').trim().slice(0, 120) || null
  const phone    = (body.phone    ?? '').replace(/\D/g, '')
  const business = (body.business ?? '').trim().slice(0, 200) || null
  const planId   = PLAN_MAP[body.plan ?? ''] ?? 'mostrador'

  if (phone.length < 10) return json({ error: 'Número de WhatsApp inválido' }, 422)

  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // 1. Guardar/actualizar contacto en el CRM de Avaxon
  // ignoreDuplicates: si el contacto ya existe (por ejemplo, ya escribió por
  // WhatsApp), no se pisa su status/tags actuales.
  const { error: contactErr } = await sb.from('contacts').upsert(
    {
      organization_id: AVAXON_ORG_ID,
      phone,
      name,
      status: 'new',
      tags: ['landing_page'],
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,phone', ignoreDuplicates: true }
  )

  if (contactErr) console.error('landing-lead: contactErr', contactErr.message)

  // 2. Crear solicitud de onboarding para que aparezca en el panel de admin.
  // Si el mismo número ya tiene una solicitud pendiente no se duplica.
  const { data: existing } = await sb
    .from('onboarding_requests')
    .select('id, status')
    .eq('phone_number', phone)
    .neq('status', 'activated')
    .maybeSingle()

  if (!existing) {
    const { error: reqErr } = await sb.from('onboarding_requests').insert({
      business_name: business || name || phone,
      contact_name:  name,
      phone_number:  phone,
      plan_id:       planId,
      source:        'landing',
      status:        'pending',
    })
    if (reqErr) console.error('landing-lead: reqErr', reqErr.message)
  }

  return json({ ok: true })
})
