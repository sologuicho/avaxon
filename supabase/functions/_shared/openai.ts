// Helper compartido para llamar a OpenAI chat/completions.
//
// Antes de esto, 3 Edge Functions (webhook-wa, reactivate-cold-leads,
// test-bot) repetían el mismo fetch crudo a api.openai.com -- esto solo
// junta ese patrón en un solo lugar para que el módulo de Publicaciones
// no agregue una 4ta copia. No cambia nada de las 3 funciones existentes.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionOptions {
  temperature?: number
  maxTokens?: number
  jsonResponse?: boolean
}

export async function chatCompletion(
  openaiKey: string,
  messages: ChatMessage[],
  opts: ChatCompletionOptions = {},
): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 400,
      ...(opts.jsonResponse ? { response_format: { type: 'json_object' } } : {}),
      messages,
    }),
  })
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(`OpenAI error: ${errData?.error?.message ?? res.statusText}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}
