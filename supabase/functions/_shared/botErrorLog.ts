import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendEmail } from './email.ts'

// ── Registro del bot (panel admin → Super Admin) ────────────────────────────
// Punto único de escritura para bot_error_logs — mensajes rechazados por
// Meta, fallas de Google Calendar, links de pago fallidos, errores del
// modelo y edge functions con error 500. Nunca lanza: una falla al loguear
// un error no debe tumbar el flujo que la llamó.
//
// type: 'meta_rejected' | 'calendar_failed' | 'payment_link_failed'
//     | 'model_error' | 'edge_function_500'

export type BotErrorType =
  | 'meta_rejected'
  | 'calendar_failed'
  | 'payment_link_failed'
  | 'model_error'
  | 'edge_function_500'

export async function logBotError(
  sb: ReturnType<typeof createClient>,
  params: {
    organization_id?: string | null
    conversation_id?: string | null
    type: BotErrorType
    error_code?: string | null
    detail: string
    source: string // ej. 'webhook-wa:send_reply', 'send-broadcast'
  },
): Promise<void> {
  try {
    await sb.from('bot_error_logs').insert({
      organization_id: params.organization_id ?? null,
      conversation_id: params.conversation_id ?? null,
      type:             params.type,
      error_code:       params.error_code ?? null,
      detail:           params.detail.slice(0, 2000),
      source:           params.source,
    })
    if (params.organization_id) {
      await maybeAlertHighErrorRate(sb, params.organization_id)
    }
  } catch (e) {
    console.error('logBotError: error inesperado:', e)
  }
}

const ALERT_EMAIL     = 'hectorgarcia@avaxon.lat' // fijo a propósito — aviso al operador, no config por org
const ALERT_THRESHOLD = 5 // "más de 5" → dispara justo al llegar al 6to en la hora

// Se dispara UNA vez por racha: solo cuando el conteo de la última hora
// cruza el umbral por primera vez (count === threshold + 1), no en cada
// error adicional después — si no, serían decenas de correos seguidos.
async function maybeAlertHighErrorRate(
  sb: ReturnType<typeof createClient>,
  organizationId: string,
): Promise<void> {
  try {
    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count, error } = await sb
      .from('bot_error_logs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .gte('created_at', sinceIso)

    if (error || (count ?? 0) !== ALERT_THRESHOLD + 1) return

    const { data: org } = await sb.from('organizations').select('name').eq('id', organizationId).maybeSingle()
    const orgName = org?.name || organizationId

    const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:32px 16px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:#ef4444;padding:20px 24px">
      <span style="color:#fff;font-size:17px;font-weight:700">Avaxon — Alerta</span>
    </div>
    <div style="padding:24px">
      <h2 style="margin:0 0 16px;font-size:18px;color:#0f172a">⚠️ ${escapeHtml(orgName)} tiene más de ${ALERT_THRESHOLD} errores del bot en la última hora</h2>
      <p style="font-size:14px;color:#334155;line-height:1.6">Revisa "Registro del bot" en el panel admin para ver el detalle de cada error.</p>
      <div style="margin-top:20px">
        <a href="https://avaxon.lat/admin/" style="display:inline-block;background:#ef4444;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px">Ver panel admin</a>
      </div>
    </div>
  </div>
</div>`.trim()

    const result = await sendEmail({
      to: ALERT_EMAIL,
      subject: `⚠️ ${orgName}: más de ${ALERT_THRESHOLD} errores del bot en 1 hora`,
      html,
    })
    if (!result.ok) console.error('maybeAlertHighErrorRate: Resend no pudo enviar:', result.error)
  } catch (e) {
    console.error('maybeAlertHighErrorRate: error inesperado:', e)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
