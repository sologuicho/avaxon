// ── Parseo de la salida del agente, compartido entre canales ───────────────
// El agente (gpt-4o-mini con el system_prompt de bot_configs) responde en
// JSON: {"text": "...", "buttons": ["..."], "notify_owner": true|false}.
// webhook-wa ya parsea esto para WhatsApp (ver su paso "12. Parsear
// respuesta JSON del bot"); esta es la misma lógica, channel-agnostic, para
// que webhook-ig/webhook-fb no tengan que duplicarla ni mandar el JSON
// crudo si no la usan.

export interface ParsedAgentReply {
  text: string
  buttons: string[]
  notifyOwner: boolean
}

// Limpieza de markdown que ninguno de los canales (WhatsApp/Instagram/
// Messenger) renderiza -- mismas reglas que usa webhook-wa.
function cleanMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '$2')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/~~([^~\n]+)~~/g, '~$1~')
    .replace(/^#{1,6}\s+/gm, '')
}

// El modelo a veces envuelve el JSON en un bloque de código markdown
// (```json {...} ``` o ``` {...} ```) en vez de mandar el objeto pelón --
// se quita la cerca antes de intentar JSON.parse.
function stripCodeFence(raw: string): string {
  const match = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1] : raw
}

// Si el JSON no se puede parsear, el string crudo se trata como el texto --
// nunca se manda el JSON tal cual al cliente.
export function parseAgentReply(rawReply: string): ParsedAgentReply {
  let parsed: { text?: string; buttons?: unknown; notify_owner?: boolean }
  try {
    parsed = JSON.parse(stripCodeFence(rawReply))
  } catch {
    parsed = { text: rawReply }
  }

  const text = cleanMarkdown(typeof parsed.text === 'string' && parsed.text ? parsed.text : rawReply)
  const buttons = Array.isArray(parsed.buttons)
    ? parsed.buttons.filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
    : []
  const notifyOwner = parsed.notify_owner === true

  return { text, buttons, notifyOwner }
}
