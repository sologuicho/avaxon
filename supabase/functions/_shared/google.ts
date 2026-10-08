// ── Google OAuth: state firmado (HMAC) + refresco de access_token ──────────
// Usado por google-oauth-start, google-oauth-callback, y cualquier función
// que necesite llamar a la API de Google (Calendar/Sheets) a nombre de una org.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  arr.forEach(b => { bin += String.fromCharCode(b) })
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

// payload.org firmado con OAUTH_STATE_SECRET — evita que alguien pueda
// forjar un `state` para conectar Google en la organización de otro.
export async function signState(organizationId: string, secret: string): Promise<string> {
  const payload = JSON.stringify({ org: organizationId, ts: Date.now() })
  const payloadB64 = b64url(new TextEncoder().encode(payload))
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  return `${payloadB64}.${b64url(sig)}`
}

export async function verifyState(
  state: string,
  secret: string,
  maxAgeMs = 10 * 60 * 1000,
): Promise<{ org: string } | null> {
  const [payloadB64, sigB64] = (state || '').split('.')
  if (!payloadB64 || !sigB64) return null

  const key = await hmacKey(secret)
  const valid = await crypto.subtle.verify(
    'HMAC', key, b64urlToBytes(sigB64), new TextEncoder().encode(payloadB64),
  )
  if (!valid) return null

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)))
    if (!payload.org || typeof payload.ts !== 'number') return null
    if (Date.now() - payload.ts > maxAgeMs) return null
    return { org: payload.org }
  } catch {
    return null
  }
}

type GoogleCredentials = {
  access_token?: string
  refresh_token?: string | null
  expires_at?: string
}

// Devuelve un access_token válido para la org, refrescándolo con Google si ya
// expiró. Lee/escribe la fila google_calendar de `integrations` (Calendar y
// Sheets comparten el mismo grant, por eso basta una fila como fuente).
export async function getGoogleAccessToken(
  sb: ReturnType<typeof createClient>,
  organizationId: string,
): Promise<string | null> {
  const { data: integ } = await sb
    .from('integrations')
    .select('credentials')
    .eq('organization_id', organizationId)
    .eq('provider', 'google_calendar')
    .maybeSingle()

  const creds = (integ?.credentials ?? null) as GoogleCredentials | null
  if (!creds?.access_token) return null

  const expiresAtMs = creds.expires_at ? new Date(creds.expires_at).getTime() : 0
  const stillValid = expiresAtMs - 60_000 > Date.now() // 60s de margen
  if (stillValid) return creds.access_token

  if (!creds.refresh_token) return null

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  if (!clientId || !clientSecret) return null

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  if (!tokenRes.ok) return null

  const tokenData = await tokenRes.json()
  if (!tokenData.access_token) return null

  const newCreds: GoogleCredentials = {
    access_token: tokenData.access_token,
    refresh_token: creds.refresh_token, // Google no siempre reenvía uno nuevo al refrescar
    expires_at: new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString(),
  }

  await sb.from('integrations')
    .update({ credentials: newCreds, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .in('provider', ['google_calendar', 'google_sheets'])

  return newCreds.access_token
}
