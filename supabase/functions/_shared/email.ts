// ── Cliente mínimo de la API de Resend (sin SDK) ────────────────────────────

const DEFAULT_FROM = 'Avaxon <citas@avaxon.lat>'

export async function sendEmail(opts: {
  to: string | string[]
  subject: string
  html: string
  from?: string
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY no configurado' }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: opts.from || DEFAULT_FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data?.message || `Resend error ${res.status}: ${JSON.stringify(data)}` }
    }
    return { ok: true, id: data?.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
