import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Métricas públicas para el panel de la landing (avaxon.lat) ──
// Devuelve solo conteos agregados de los últimos 7 días (nunca datos
// crudos de contactos/conversaciones). Público, sin auth — debe
// desplegarse con JWT verification desactivado, igual que webhook-wa.

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)

  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [convRes, leadsRes, citasRes] = await Promise.all([
    sb.from('conversations').select('id', { count: 'exact', head: true })
      .eq('organization_id', AVAXON_ORG_ID).gte('last_message_at', since),
    sb.from('contacts').select('id', { count: 'exact', head: true })
      .eq('organization_id', AVAXON_ORG_ID).eq('status', 'qualified').gte('created_at', since),
    sb.from('appointments').select('id', { count: 'exact', head: true })
      .eq('organization_id', AVAXON_ORG_ID).gte('created_at', since),
  ])

  return json({
    conv:  convRes.count  ?? 0,
    leads: leadsRes.count ?? 0,
    citas: citasRes.count ?? 0,
  })
})
