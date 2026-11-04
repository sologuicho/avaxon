// Normaliza números de teléfono a la convención que usa Meta/WhatsApp Cloud
// API en esta app: solo dígitos (sin "+"), y para México siempre con el "1"
// después del "52" (ej. 5218998730003) -- ese es el formato que llega en el
// `from`/`to` de los webhooks y el que ya está guardado en `contacts.phone`.
// Sin esta convención consistente, un mismo número puede terminar comparado
// contra representaciones distintas (CSV con 10 dígitos locales, E.164 con o
// sin el "1", etc.) y los matches (eco de Meta Business Inbox, respuesta de
// campaña) fallan en silencio.
export function normalizePhone(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length === 10) return '521' + d                      // local MX -> 521 + 10
  if (d.length === 12 && d.startsWith('52')) return '521' + d.slice(2)  // 52+10 -> 521+10
  return d                                                     // ya correcto (521...) u otro país
}
