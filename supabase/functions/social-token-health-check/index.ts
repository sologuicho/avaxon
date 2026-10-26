import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Publicaciones en redes — chequeo proactivo de tokens ────────────────────
// Sin esto, "Token expirado" solo se detecta cuando un intento real de
// publicar falla (reactivo) -- el banner de "El acceso a Instagram expiró"
// del Calendario necesita saberlo ANTES de que se intente publicar algo,
// por eso este cron corre una vez al día y valida cada access_token activo
// contra /debug_token de Meta.
//
// Disparo: cron diario (verify_jwt=false en supabase/config.toml). NO está
// desplegada ni tiene cron activo en producción todavía -- este archivo +
// la entrada de config.toml existen en el repo para revisión.

const GRAPH = 'https://graph.facebook.com/v22.0'
const corsHeaders = { 'Access-Control-Allow-Origin': '*' }

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const META_APP_ID      = Deno.env.get('META_APP_ID')
  const META_APP_SECRET  = Deno.env.get('META_APP_SECRET')

  if (!META_APP_ID || !META_APP_SECRET) {
    console.error('social-token-health-check: faltan META_APP_ID/META_APP_SECRET')
    return new Response(JSON.stringify({ ok: false, error: 'META_APP_ID/META_APP_SECRET no configurados' }), { status: 500, headers: corsHeaders })
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const appToken = `${META_APP_ID}|${META_APP_SECRET}`

  const { data: accounts, error } = await adminClient
    .from('social_accounts')
    .select('id, access_token, status')
    .eq('status', 'connected') // solo valida las que hoy se ven sanas -- una ya marcada token_expired/error espera a que el usuario reconecte

  if (error) {
    console.error('social-token-health-check: error listando cuentas:', error)
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders })
  }

  const results: { id: string; outcome: string }[] = []

  for (const acc of accounts ?? []) {
    try {
      const res = await fetch(`${GRAPH}/debug_token?input_token=${acc.access_token}&access_token=${appToken}`)
      const data = await res.json()
      const info = data?.data

      const isValid = !!info?.is_valid
      // expires_at === 0 significa que no vence (típico de tokens de Page
      // de larga duración) -- no es un indicador de expiración.
      const expiresAt = typeof info?.expires_at === 'number' ? info.expires_at : 0
      const isExpired = expiresAt > 0 && expiresAt * 1000 < Date.now()

      if (!res.ok || !isValid || isExpired) {
        await adminClient.from('social_accounts').update({
          status: 'token_expired',
          last_error_code: 'debug_token_invalid',
          last_error_message: 'El chequeo diario de tokens detectó que el acceso ya no es válido. Reconecta la cuenta.',
          updated_at: new Date().toISOString(),
        }).eq('id', acc.id)
        results.push({ id: acc.id, outcome: 'marcada_token_expired' })
      } else {
        results.push({ id: acc.id, outcome: 'ok' })
      }
    } catch (e) {
      console.error('social-token-health-check: error validando cuenta', acc.id, e)
      results.push({ id: acc.id, outcome: 'error_de_red_no_se_tocó' })
    }
  }

  return new Response(JSON.stringify({ ok: true, checked: results.length, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
