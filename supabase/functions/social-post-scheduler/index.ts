import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { publishToTarget } from '../_shared/socialPublish.ts'

// ── Publicaciones en redes — cron de publicaciones programadas ─────────────
// Cola unificada para Facebook e Instagram (decisión del plan: no se usa
// el scheduled_publish_time nativo de Facebook, todo pasa por este mismo
// cron) -- un solo mecanismo de reintentos/expiración para las dos redes.
//
// Hace poll de social_post_targets con status 'programado' (su hora ya
// llegó) o 'en_cola' (reintento automático o manual, por el botón
// "Reintentar" que solo resetea la fila a en_cola/next_attempt_at=now()).
//
// Disparo: cron cada 1-2 min, mismo patrón que send-reminders
// (verify_jwt=false en supabase/config.toml, Supabase llama la función
// directo). NO está desplegada ni tiene cron activo en producción todavía
// -- este archivo + la entrada de config.toml existen en el repo para
// revisión.

const corsHeaders = { 'Access-Control-Allow-Origin': '*' }
const MAX_AUTO_RETRIES = 3
const BACKOFF_MINUTES = 5 // backoff lineal simple: intento N espera N*5 min

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const nowIso = new Date().toISOString()

  const { data: due, error } = await adminClient
    .from('social_post_targets')
    .select('id, status, attempt_count, error_code')
    .in('status', ['programado', 'en_cola'])
    .or(`scheduled_at.lte.${nowIso},next_attempt_at.lte.${nowIso}`)
    .limit(100)

  if (error) {
    console.error('social-post-scheduler: error consultando targets debidos:', error)
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders })
  }

  const results: { id: string; outcome: string }[] = []

  for (const row of due ?? []) {
    try {
      await publishToTarget(adminClient, row.id)
    } catch (e) {
      console.error('social-post-scheduler: publishToTarget lanzó excepción para', row.id, e)
    }

    const { data: refreshed } = await adminClient
      .from('social_post_targets')
      .select('status, attempt_count, error_code')
      .eq('id', row.id)
      .single()

    if (!refreshed) { results.push({ id: row.id, outcome: 'no_encontrado' }); continue }

    if (refreshed.status === 'publicado') {
      results.push({ id: row.id, outcome: 'publicado' })
      continue
    }

    // Fallido: decide si se reintenta solo o se deja terminal. Los errores
    // de token/permiso no se auto-reintentan -- no se van a resolver solos,
    // necesitan que alguien reconecte la cuenta.
    const isTokenOrPermError = ['account_not_connected', '190', '102', '463', '467', '200', '10'].includes(refreshed.error_code ?? '')
    const canRetry = !isTokenOrPermError && refreshed.attempt_count < MAX_AUTO_RETRIES

    if (canRetry) {
      await adminClient.from('social_post_targets').update({
        status: 'en_cola',
        next_attempt_at: new Date(Date.now() + refreshed.attempt_count * BACKOFF_MINUTES * 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', row.id)
      results.push({ id: row.id, outcome: 'reintento_programado' })
    } else {
      // Ya quedó en 'fallido' por publishToTarget -- se deja terminal,
      // requiere el botón "Reintentar" manual del Historial.
      results.push({ id: row.id, outcome: 'fallido_terminal' })
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: results.length, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
