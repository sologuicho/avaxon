import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export type ZapierEventResult =
  | { ok: true }
  | { ok: false; skipped: true }
  | { ok: false; status?: number; error: string }

export async function sendZapierEvent(
  sb: ReturnType<typeof createClient>,
  organizationId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<ZapierEventResult> {
  try {
    const { data: integ } = await sb
      .from('integrations')
      .select('config')
      .eq('organization_id', organizationId)
      .eq('provider', 'zapier')
      .eq('status', 'connected')
      .maybeSingle()

    const url = (integ?.config as any)?.webhook_url
    if (!url) return { ok: false, skipped: true }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        organization_id: organizationId,
        data: payload,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      console.error(`sendZapierEvent: webhook respondió ${res.status} (evento "${event}", org ${organizationId})`)
      return { ok: false, status: res.status, error: `Webhook respondió ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    console.error(`sendZapierEvent: error enviando evento "${event}" (org ${organizationId}):`, e)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
