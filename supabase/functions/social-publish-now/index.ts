import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { publishToTarget } from '../_shared/socialPublish.ts'

// ── Publicaciones en redes — "Publicar ahora" ───────────────────────────────
// Recibe uno o más social_post_targets.id (un post puede tener varios
// targets, uno por red) y los publica de inmediato, en vez de esperar al
// cron de programados. Usado por el botón "Publicar ahora" del Editor.
//
// NO está desplegada a producción todavía -- este archivo existe en el
// repo para revisión.

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

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient.from('profiles').select('organization_id, role').eq('id', user.id).maybeSingle()
  if (!profile?.organization_id) return json({ error: 'Perfil sin organización' }, 403)

  let body: { target_ids?: string[] }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const targetIds = body.target_ids ?? []
  if (!targetIds.length) return json({ error: 'target_ids requerido (al menos 1)' }, 422)

  // Valida que TODOS los targets sean de la org del caller (o caller sea
  // super_admin) antes de publicar ninguno -- nunca confía en que el
  // cliente mande solo ids de su propia org.
  const { data: targets } = await adminClient
    .from('social_post_targets')
    .select('id, organization_id, status')
    .in('id', targetIds)

  if (!targets?.length) return json({ error: 'No se encontraron esos targets' }, 404)

  const notOwned = targets.filter((t) => profile.role !== 'super_admin' && t.organization_id !== profile.organization_id)
  if (notOwned.length) return json({ error: 'No autorizado para alguno de estos targets' }, 403)

  const alreadyPublished = targets.filter((t) => t.status === 'publicado')
  const toPublish = targets.filter((t) => t.status !== 'publicado')

  const results: { id: string; ok: boolean }[] = []
  for (const t of toPublish) {
    try {
      await publishToTarget(adminClient, t.id)
      const { data: refreshed } = await adminClient.from('social_post_targets').select('status').eq('id', t.id).single()
      results.push({ id: t.id, ok: refreshed?.status === 'publicado' })
    } catch (e) {
      console.error('social-publish-now: error publicando target', t.id, e)
      results.push({ id: t.id, ok: false })
    }
  }

  return json({
    ok: true,
    results,
    skipped_already_published: alreadyPublished.map((t) => t.id),
  })
})
