import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

// One-time fix: re-subscribe a WABA to the Avaxon app using the system token.
// POST with { "waba_id": "..." }
// Uses WA_ACCESS_TOKEN (system user token) which has partner access to all client WABAs.

const GRAPH = 'https://graph.facebook.com/v22.0'

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const WA_TOKEN = Deno.env.get('WA_ACCESS_TOKEN')
  if (!WA_TOKEN) return new Response(JSON.stringify({ error: 'WA_ACCESS_TOKEN not set' }), { status: 500 })

  let body: { waba_id?: string }
  try { body = await req.json() } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }) }

  const waba_id = body.waba_id
  if (!waba_id) return new Response(JSON.stringify({ error: 'waba_id required' }), { status: 422 })

  // Check current subscriptions
  const getRes = await fetch(`${GRAPH}/${waba_id}/subscribed_apps`, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  })
  const getData = await getRes.json()

  // Subscribe Avaxon app to this WABA using system token
  const subRes = await fetch(`${GRAPH}/${waba_id}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  })
  const subData = await subRes.json()

  return new Response(JSON.stringify({
    current_subscriptions: getData,
    subscribe_result: subData,
    status: subRes.ok ? 'ok' : 'error',
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
})
