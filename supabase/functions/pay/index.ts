import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Link corto de pago ───────────────────────────────────────────────────────
// avaxon.lat/p/<payment_id> (vía 404.html) y esta función (?id=<payment_id>)
// redirigen al checkout_url real guardado en `payments`. Público, sin JWT —
// lo abre el navegador del cliente desde WhatsApp.

const FALLBACK_URL = 'https://avaxon.lat/?pago=no_encontrado'

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } })
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return redirect(FALLBACK_URL)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: payment } = await sb
    .from('payments')
    .select('checkout_url')
    .eq('id', id)
    .maybeSingle()

  if (!payment?.checkout_url) return redirect(FALLBACK_URL)
  return redirect(payment.checkout_url)
})
