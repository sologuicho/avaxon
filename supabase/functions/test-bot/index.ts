import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const OPENAI_KEY    = Deno.env.get('OPENAI_API_KEY')!

  const callerSb = createClient(SUPABASE_URL, SERVICE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user } } = await callerSb.auth.getUser()
  if (!user) return json({ error: 'Unauthorized' }, 401)

  const adminSb = createClient(SUPABASE_URL, SERVICE_KEY)

  // Obtener org del usuario
  const { data: profile } = await adminSb
    .from('profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()

  let orgId = profile?.organization_id

  // super_admin puede pasar org_id en el body
  let body: { message: string; history?: { role: string; content: string }[]; org_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  if (profile?.role === 'super_admin' && body.org_id) orgId = body.org_id
  if (!orgId) return json({ error: 'No se encontró organización' }, 404)

  const { message, history = [] } = body
  if (!message?.trim()) return json({ error: 'message es requerido' }, 422)

  // Obtener system_prompt de la org
  const { data: bot } = await adminSb
    .from('bot_configs')
    .select('system_prompt, enabled')
    .eq('organization_id', orgId)
    .maybeSingle()

  const systemPrompt = bot?.system_prompt ??
    'Eres un asistente virtual. Responde de forma amable y profesional.'

  // Construir mensajes para GPT
  const messages = [
    { role: 'system', content: systemPrompt + '\n\n[MODO PRUEBA — esto es una simulación desde el panel, no un cliente real]' },
    ...history.slice(-10),
    { role: 'user', content: message },
  ]

  const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:           'gpt-4o',
      response_format: { type: 'json_object' },
      messages,
      max_tokens:  500,
      temperature: 0.7,
    }),
  })

  if (!aiRes.ok) {
    const err = await aiRes.text()
    return json({ error: 'Error de OpenAI: ' + err }, 502)
  }

  const aiData = await aiRes.json()
  const raw    = aiData.choices?.[0]?.message?.content?.trim() ?? ''

  let reply: string
  try {
    const parsed = JSON.parse(raw)
    reply = parsed.text ?? raw
  } catch {
    reply = raw
  }

  return json({ reply })
})
