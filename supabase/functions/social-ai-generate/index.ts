import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { chatCompletion } from '../_shared/openai.ts'

// ── Publicaciones en redes — "Generar con IA" ───────────────────────────────
// Devuelve SOLO el caption base (sin el CTA final, que se compone distinto
// por red en _shared/socialPublish.ts -- Facebook sí hipervincula URLs en
// el texto de un post, Instagram no). Sin escritura a BD: el usuario edita
// y aprueba antes de "Guardar borrador".
//
// NO está desplegada a producción todavía -- este archivo existe en el
// repo para revisión.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

interface Body {
  organization_id?: string
  tone?: 'Amigable' | 'Profesional' | 'Divertido' | 'Urgente'
  hashtags?: boolean
  cta_whatsapp?: boolean
  instruction?: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const OPENAI_API_KEY   = Deno.env.get('OPENAI_API_KEY')
  if (!OPENAI_API_KEY) return json({ error: 'OPENAI_API_KEY no está configurado' }, 500)

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient.from('profiles').select('organization_id, role').eq('id', user.id).maybeSingle()

  let body: Body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const orgId = body.organization_id || profile?.organization_id
  if (!orgId) return json({ error: 'organization_id requerido' }, 422)
  if (profile?.role !== 'super_admin' && orgId !== profile?.organization_id) {
    return json({ error: 'No autorizado para esta organización' }, 403)
  }

  const { data: moduleRow } = await adminClient
    .from('business_modules')
    .select('enabled')
    .eq('organization_id', orgId)
    .eq('module_key', 'publicaciones_redes')
    .maybeSingle()
  if (!moduleRow?.enabled) {
    return json({ error: 'El módulo de Publicaciones en redes no está activo para esta organización' }, 403)
  }

  const { data: org } = await adminClient.from('organizations').select('name, industry').eq('id', orgId).maybeSingle()

  const tone = body.tone ?? 'Amigable'
  const hashtags = !!body.hashtags
  const ctaWhatsapp = !!body.cta_whatsapp
  const instruction = (body.instruction ?? '').trim()

  const toneGuide: Record<string, string> = {
    Amigable: 'cálido y cercano, como hablándole a un cliente conocido',
    Profesional: 'claro y formal, sin emojis excesivos',
    Divertido: 'ligero, con humor, puede usar 1-2 emojis',
    Urgente: 'con sentido de urgencia/escasez, invita a actuar ya',
  }

  const instructions = [
    `Escribe UN SOLO caption en español para una publicación de redes sociales (se usa igual en Facebook e Instagram, no generes versiones distintas).`,
    `Tono: ${tone} (${toneGuide[tone] ?? toneGuide.Amigable}).`,
    `Máximo 2200 caracteres (límite real de Instagram) -- idealmente mucho más corto, 2-4 líneas.`,
    hashtags
      ? 'Incluye 3-5 hashtags relevantes al final, en español, sin espacios dentro de cada uno.'
      : 'No incluyas ningún hashtag.',
    'NO incluyas ningún link, número de teléfono, ni invitación a escribir por WhatsApp -- eso se agrega aparte, por fuera de tu respuesta.',
    `Negocio: ${org?.name ?? 'el negocio'}${org?.industry ? ` (${org.industry})` : ''}.`,
    instruction ? `Instrucción específica del usuario: ${instruction}` : '',
  ].filter(Boolean).join(' ')

  try {
    const caption = await chatCompletion(
      OPENAI_API_KEY,
      [
        { role: 'system', content: instructions },
        { role: 'user', content: instruction || 'Genera el caption según las instrucciones del sistema.' },
      ],
      { temperature: 0.8, maxTokens: 400 },
    )
    return json({ ok: true, caption: caption.trim(), cta_whatsapp: ctaWhatsapp })
  } catch (e) {
    console.error('social-ai-generate: error llamando a OpenAI:', e)
    return json({ error: 'No se pudo generar el texto. Intenta de nuevo.' }, 502)
  }
})
