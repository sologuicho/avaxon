// ── Cliente mínimo de la API de Stripe (sin SDK) ────────────────────────────
// stripeFetch  → v1 endpoints (Checkout Sessions, Payment Intents, etc.)
//                usa application/x-www-form-urlencoded
// stripeV2Fetch → v2 endpoints (/v2/core/accounts, /v2/core/account_links)
//                usa application/json

export const STRIPE_API_VERSION = '2026-09-30.endive'

export class StripeApiError extends Error {
  status: number
  stripeError: unknown
  constructor(message: string, status: number, stripeError: unknown) {
    super(message)
    this.status = status
    this.stripeError = stripeError
  }
}

function toFormUrlEncoded(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue
    const fullKey = prefix ? `${prefix}[${key}]` : key
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          parts.push(toFormUrlEncoded(item as Record<string, unknown>, `${fullKey}[${i}]`))
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(String(item))}`)
        }
      })
    } else if (typeof value === 'object') {
      parts.push(toFormUrlEncoded(value as Record<string, unknown>, fullKey))
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.filter(Boolean).join('&')
}

// ── v1 (form-encoded) ────────────────────────────────────────────────────────
export async function stripeFetch(
  path: string,
  secretKey: string,
  options: { method?: string; body?: Record<string, unknown>; stripeAccount?: string } = {},
): Promise<any> {
  const { method = 'POST', body, stripeAccount } = options
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Stripe-Version': STRIPE_API_VERSION,
  }
  if (stripeAccount) headers['Stripe-Account'] = stripeAccount

  let fetchBody: string | undefined
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    fetchBody = toFormUrlEncoded(body)
  }

  const res = await fetch(`https://api.stripe.com/v1${path}`, { method, headers, body: fetchBody })
  const data = await res.json()
  if (!res.ok) {
    throw new StripeApiError(data.error?.message || `Stripe API error ${res.status}`, res.status, data.error)
  }
  return data
}

// ── v2 (JSON) ────────────────────────────────────────────────────────────────
// Usado para /v2/core/accounts y /v2/core/account_links (Accounts v2).
// El path ya incluye /v2/..., se concatena directo a api.stripe.com.
export async function stripeV2Fetch(
  path: string,
  secretKey: string,
  options: { method?: string; body?: Record<string, unknown>; stripeAccount?: string } = {},
): Promise<any> {
  const { method = 'POST', body, stripeAccount } = options
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Stripe-Version': STRIPE_API_VERSION,
  }
  if (stripeAccount) headers['Stripe-Account'] = stripeAccount

  let fetchBody: string | undefined
  if (body) {
    headers['Content-Type'] = 'application/json'
    fetchBody = JSON.stringify(body)
  }

  const res = await fetch(`https://api.stripe.com${path}`, { method, headers, body: fetchBody })
  const data = await res.json()
  if (!res.ok) {
    throw new StripeApiError(data.error?.message || `Stripe API error ${res.status}`, res.status, data.error)
  }
  return data
}

// ── Webhook signature verification ──────────────────────────────────────────
export async function verifyStripeSignature(
  rawPayload: string,
  sigHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!sigHeader) return false
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=')
    if (k === 't') acc.t = v
    if (k === 'v1') acc.v1 = v
    return acc
  }, {} as { t?: string; v1?: string })

  if (!parts.t || !parts.v1) return false

  const signedPayload = `${parts.t}.${rawPayload}`
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload))
  const expected = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('')

  if (expected.length !== parts.v1.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i)
  if (diff !== 0) return false

  const age = Math.abs(Date.now() / 1000 - Number(parts.t))
  if (age > toleranceSeconds) return false

  return true
}
