// Envío de mensajes de texto a Instagram y Messenger vía la Send API de
// Meta (mismo endpoint/estructura para los dos canales, solo cambia el
// token de la Página). Compartido entre los webhooks (respuesta automática
// del bot) y send-message (respuesta manual desde el dashboard) -- antes
// estaba duplicado en webhook-ig/index.ts y webhook-fb/index.ts.

const QUICK_REPLY_MAX = 13;
const QUICK_REPLY_TITLE_MAX = 20;

export function truncateLabel(label: string, maxLen: number): string {
  const trimmed = label.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const cut = trimmed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

export type SocialSendResult = { ok: true } | { ok: false; error: string };

async function sendViaMetaMessages(
  pageAccessToken: string,
  recipientId: string,
  text: string,
  buttons: string[],
  logPrefix: string,
): Promise<SocialSendResult> {
  const quickReplyTitles = buttons
    .map((b) => truncateLabel(b, QUICK_REPLY_TITLE_MAX))
    .filter((b) => b.length > 0)
    .slice(0, QUICK_REPLY_MAX);

  const message: Record<string, unknown> = {
    text: quickReplyTitles.length === 0 && buttons.length > 0
      ? `${text}\n\n${buttons.map((b) => `• ${b.trim()}`).join('\n')}`
      : text,
  };
  if (quickReplyTitles.length > 0) {
    message.quick_replies = quickReplyTitles.map((title, i) => ({ content_type: 'text', title, payload: `btn_${i}` }));
  }

  const res = await fetch('https://graph.facebook.com/v21.0/me/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pageAccessToken}` },
    body: JSON.stringify({ recipient: { id: recipientId }, message }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    console.error(`${logPrefix}: Meta rechazó el envío del mensaje:`, JSON.stringify(errData));
    return { ok: false, error: errData?.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

// Manda solo texto al cliente -- nunca el JSON crudo del agente. Si hay
// botones, los convierte a quick replies (máx. 13, título de máx. 20
// caracteres); si ninguno sobrevive el truncado/filtro pero sí había
// botones, se agregan como texto en vez de perderlos en silencio.
export function sendIgMessage(pageAccessToken: string, recipientId: string, text: string, buttons: string[] = []): Promise<SocialSendResult> {
  return sendViaMetaMessages(pageAccessToken, recipientId, text, buttons, 'webhook-ig');
}

export function sendFbMessage(pageAccessToken: string, recipientId: string, text: string, buttons: string[] = []): Promise<SocialSendResult> {
  return sendViaMetaMessages(pageAccessToken, recipientId, text, buttons, 'webhook-fb');
}
