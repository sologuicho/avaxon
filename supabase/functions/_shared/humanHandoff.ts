import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendEmail } from './email.ts'

// ── Bandeja de atención humana ──────────────────────────────────────────────
// Marca una conversación como "necesita humano" y avisa al dueño del negocio
// (correo de Configuración → Preferencias, y por WhatsApp si tiene una
// plantilla aprobada configurada para esto). Solo notifica la PRIMERA vez
// que se marca — mensajes repetidos de la misma espera no vuelven a avisar
// ni mueven needs_human_at (eso es lo que mide "hace cuánto espera").
export async function flagNeedsHuman(
  sb: ReturnType<typeof createClient>,
  conversationId: string,
  organizationId: string,
  reason: string,
): Promise<void> {
  try {
    const { data: updated, error } = await sb
      .from('conversations')
      .update({ needs_human: true, needs_human_at: new Date().toISOString(), needs_human_reason: reason })
      .eq('id', conversationId)
      .eq('needs_human', false)
      .select('id')
      .maybeSingle()

    if (error) { console.error('flagNeedsHuman: error actualizando conversación:', error); return }
    if (!updated) return // ya estaba marcada — no se vuelve a notificar

    await notifyOwnerNeedsHuman(sb, organizationId, conversationId, reason)
  } catch (e) {
    console.error('flagNeedsHuman: error inesperado:', e)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

async function notifyOwnerNeedsHuman(
  sb: ReturnType<typeof createClient>,
  organizationId: string,
  conversationId: string,
  reason: string,
): Promise<void> {
  const { data: conv } = await sb
    .from('conversations')
    .select('contacts(name, phone)')
    .eq('id', conversationId)
    .maybeSingle()
  const contactName  = (conv?.contacts as any)?.name || (conv?.contacts as any)?.phone || 'Un cliente'
  const contactPhone = (conv?.contacts as any)?.phone || ''

  const { data: org } = await sb.from('organizations').select('name').eq('id', organizationId).maybeSingle()
  const orgName = org?.name || 'tu negocio'

  // ── Correo (mismo criterio que notifyAppointment: notification_email de
  // organization_profile, si no, el correo del profile con role='owner') ──
  try {
    const { data: profile } = await sb
      .from('organization_profile')
      .select('notification_email')
      .eq('organization_id', organizationId)
      .maybeSingle()
    let notifyEmail: string | null = profile?.notification_email || null

    if (!notifyEmail) {
      const { data: owner } = await sb
        .from('profiles')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('role', 'owner')
        .limit(1)
        .maybeSingle()
      if (owner?.id) {
        const { data: ownerUser } = await sb.auth.admin.getUserById(owner.id)
        notifyEmail = ownerUser?.user?.email || null
      }
    }

    if (notifyEmail) {
      const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:32px 16px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:#f97316;padding:20px 24px">
      <span style="color:#fff;font-size:17px;font-weight:700">Avaxon</span>
    </div>
    <div style="padding:24px">
      <h2 style="margin:0 0 16px;font-size:18px;color:#0f172a">🔔 Un cliente necesita atención humana</h2>
      <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#64748b;width:120px">Negocio</td><td style="padding:6px 0;font-weight:600">${escapeHtml(orgName)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Contacto</td><td style="padding:6px 0;font-weight:600">${escapeHtml(contactName)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">WhatsApp</td><td style="padding:6px 0">${escapeHtml(contactPhone)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Motivo</td><td style="padding:6px 0">${escapeHtml(reason)}</td></tr>
      </table>
      <div style="margin-top:24px">
        <a href="https://avaxon.lat/dashboard/" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px">Ver conversación</a>
      </div>
    </div>
  </div>
</div>`.trim()

      const result = await sendEmail({ to: notifyEmail, subject: `🔔 ${contactName} necesita atención humana`, html })
      if (!result.ok) console.error('notifyOwnerNeedsHuman: Resend no pudo enviar:', result.error)
    } else {
      console.warn(`notifyOwnerNeedsHuman: sin correo de notificaciones para org ${organizationId}`)
    }
  } catch (e) {
    console.error('notifyOwnerNeedsHuman: error enviando correo:', e)
  }

  // ── WhatsApp con plantilla aprobada, solo si el negocio la configuró ──────
  // Convención: integrations(provider='whatsapp').config.handoff_template_name
  // apunta al nombre de una fila APPROVED en message_templates. Sin esto
  // configurado, se omite — el correo de arriba siempre se intenta de todos
  // modos.
  try {
    const { data: waInteg } = await sb
      .from('integrations')
      .select('config')
      .eq('organization_id', organizationId)
      .eq('provider', 'whatsapp')
      .maybeSingle()
    const templateName = (waInteg?.config as any)?.handoff_template_name
    if (!templateName) return

    const { data: tpl } = await sb
      .from('message_templates')
      .select('name, language')
      .eq('organization_id', organizationId)
      .eq('name', templateName)
      .eq('status', 'APPROVED')
      .maybeSingle()
    if (!tpl) return

    const { data: profileWa } = await sb
      .from('organization_profile')
      .select('whatsapp')
      .eq('organization_id', organizationId)
      .maybeSingle()
    const ownerWaPhone = (profileWa?.whatsapp || '').replace(/\D/g, '')
    if (!ownerWaPhone) return

    const { data: pn } = await sb
      .from('phone_numbers')
      .select('phone_number_id, whatsapp_accounts(access_token)')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .maybeSingle()
    if (!pn?.phone_number_id) return
    const token = (pn.whatsapp_accounts as any)?.access_token ?? Deno.env.get('WA_ACCESS_TOKEN')

    const waRes = await fetch(`https://graph.facebook.com/v20.0/${pn.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   ownerWaPhone,
        type: 'template',
        template: { name: tpl.name, language: { code: tpl.language || 'es_MX' }, components: [] },
      }),
    })
    if (!waRes.ok) {
      const errData = await waRes.json().catch(() => ({}))
      console.error('notifyOwnerNeedsHuman: Meta rechazó la plantilla:', JSON.stringify(errData))
    }
  } catch (e) {
    console.error('notifyOwnerNeedsHuman: error enviando WhatsApp:', e)
  }
}
