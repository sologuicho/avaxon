import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Traza de llamadas a herramientas del bot (agendar_cita, consultar_
// disponibilidad, cancelar_o_reagendar_cita, crear_link_pago) ──────────────
// Tabla bot_tool_logs, con borrado automático a los 30 días (ver cron
// cleanup-tool-logs). Nunca lanza: una falla al loguear no debe tumbar el
// flujo que la llamó. Si la tabla todavía no existe, falla en silencio
// (solo console.error) en vez de romper el envío del mensaje.
export async function logToolTrace(
  sb: ReturnType<typeof createClient>,
  params: {
    organization_id?: string | null
    conversation_id?: string | null
    tool_name: string
    args?: Record<string, unknown> | null
    result?: string | null
  },
): Promise<void> {
  try {
    const argsForLog = params.args ? { ...params.args } : null
    if (argsForLog && 'nombre' in argsForLog) {
      argsForLog.nombre = argsForLog.nombre ? '[provisto]' : '[vacío]'
    }
    const { error } = await sb.from('bot_tool_logs').insert({
      organization_id: params.organization_id ?? null,
      conversation_id: params.conversation_id ?? null,
      tool_name:        params.tool_name,
      args:             argsForLog,
      result:           params.result ? params.result.slice(0, 2000) : null,
    })
    if (error) console.error('logToolTrace: error insertando (¿falta la tabla bot_tool_logs?):', error.message)
  } catch (e) {
    console.error('logToolTrace: error inesperado:', e)
  }
}
