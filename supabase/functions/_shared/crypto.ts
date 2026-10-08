// ── Cifrado de credenciales en reposo ───────────────────────────────────────
// AES-GCM con una clave simétrica de 32 bytes guardada en el secret
// INTEGRATIONS_ENCRYPTION_KEY (base64). Solo corre server-side — la clave
// nunca se expone al cliente. Formato almacenado: "encv1:<base64 iv+cipher>".

const PREFIX = 'encv1:'

async function getKey(): Promise<CryptoKey> {
  const b64 = Deno.env.get('INTEGRATIONS_ENCRYPTION_KEY')
  if (!b64) throw new Error('INTEGRATIONS_ENCRYPTION_KEY no configurado')
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function b64encode(bytes: Uint8Array): string {
  let bin = ''
  bytes.forEach(b => { bin += String.fromCharCode(b) })
  return btoa(bin)
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}

export async function encryptField(plaintext: string): Promise<string> {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  const combined = new Uint8Array(iv.length + ctBuf.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ctBuf), iv.length)
  return PREFIX + b64encode(combined)
}

export async function decryptField(stored: string): Promise<string> {
  if (!stored.startsWith(PREFIX)) throw new Error('Valor no cifrado con el formato esperado')
  const combined = b64decode(stored.slice(PREFIX.length))
  const iv = combined.slice(0, 12)
  const ct = combined.slice(12)
  const key = await getKey()
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(ptBuf)
}

// Cifra cada valor string de un objeto credentials, salvo api_key_hash (ya es
// un hash SHA-256 de una sola vía — cifrarlo no suma protección).
export async function encryptCredentials(
  credentials: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (!credentials) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(credentials)) {
    if (k === 'api_key_hash' || typeof v !== 'string') { out[k] = v; continue }
    out[k] = await encryptField(v)
  }
  return out
}
