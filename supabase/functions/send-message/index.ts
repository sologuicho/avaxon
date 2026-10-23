import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { logBotError } from '../_shared/botErrorLog.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const WA_TOKEN          = Deno.env.get('WA_ACCESS_TOKEN')!

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: { conversation_id: string; message?: string; payment_id?: string; template_id?: string; fallback_template_name?: string; template_vars?: Record<string, string> }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { conversation_id, message, payment_id, template_id, fallback_template_name, template_vars } = body
  if (!conversation_id?.trim() || (!message?.trim() && !payment_id?.trim() && !template_id?.trim())) {
    return json({ error: 'conversation_id y (message, payment_id o template_id) son requeridos' }, 422)
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  try {
    return await handleSend(adminClient, { conversation_id, message, payment_id, template_id, fallback_template_name, template_vars }, user, WA_TOKEN)
  } catch (e) {
    console.error('send-message: excepción no controlada:', e)
    await logBotError(adminClient, {
      type: 'edge_function_500',
      detail: `send-message: excepción no controlada: ${(e as Error)?.message ?? e}`,
      source: 'send-message',
    })
    return json({ error: 'Error inesperado enviando el mensaje' }, 500)
  }
})

async function handleSend(
  adminClient: ReturnType<typeof createClient>,
  { conversation_id, message, payment_id, template_id, fallback_template_name, template_vars }: { conversation_id: string; message?: string; payment_id?: string; template_id?: string; fallback_template_name?: string; template_vars?: Record<string, string> },
  user: { id: string },
  WA_TOKEN: string,
): Promise<Response> {
  // Get conversation → contact phone + org phone_number_id + per-client token
  const { data: conv, error: convErr } = await adminClient
    .from('conversations')
    .select('id, organization_id, contact_id, phone_number_id, needs_human, contacts(name, phone), phone_numbers(phone_number_id, whatsapp_accounts(access_token))')
    .eq('id', conversation_id)
    .single()

  if (convErr || !conv) return json({ error: 'Conversación no encontrada' }, 404)

  const toPhone      = (conv.contacts as any)?.phone
  const metaPhoneId  = (conv.phone_numbers as any)?.phone_number_id ?? conv.phone_number_id
  const clientToken  = (conv.phone_numbers as any)?.whatsapp_accounts?.access_token ?? WA_TOKEN

  if (!toPhone)     return json({ error: 'El contacto no tiene número de teléfono' }, 422)
  if (!metaPhoneId) return json({ error: 'No hay Phone Number ID configurado para esta org' }, 422)

  const toDigits = toPhone.replace(/\D/g, '')
  const sendWA = (payload: Record<string, unknown>) =>
    fetch(`https://graph.facebook.com/v20.0/${metaPhoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toDigits, ...payload }),
    })

  let waRes: Response
  let waData: any
  let savedContent: string

  if (payment_id) {
    // ── Link de pago: botón CTA URL (link corto, no el de Stripe pegado) ────
    const { data: payment } = await adminClient
      .from('payments')
      .select('id, organization_id, concept, amount, currency')
      .eq('id', payment_id)
      .maybeSingle()

    if (!payment || payment.organization_id !== conv.organization_id) {
      return json({ error: 'Payment no encontrado para esta organización' }, 404)
    }

    const amountFmt  = Number(payment.amount).toLocaleString('es-MX', { minimumFractionDigits: 2 })
    const currency   = (payment.currency || 'mxn').toUpperCase()
    const shortUrl   = `https://avaxon.lat/p/${payment.id}`
    const bodyText   = `Aquí tienes tu link de pago por *${payment.concept}* ($${amountFmt} ${currency}):`
    const displayText = `Pagar $${amountFmt}`.slice(0, 20) // límite de WhatsApp para display_text

    waRes = await sendWA({
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: bodyText },
        action: {
          name: 'cta_url',
          parameters: { display_text: displayText, url: shortUrl },
        },
      },
    })
    waData = await waRes.json()
    savedContent = `${bodyText}\n${shortUrl}\n[Botones: ${displayText}]`

    // Fuera de la ventana de 24h (131026) → reintentar con plantilla aprobada
    if (!waRes.ok && waData?.error?.code === 131026) {
      const { data: integ } = await adminClient
        .from('integrations')
        .select('config')
        .eq('organization_id', conv.organization_id)
        .eq('provider', 'whatsapp')
        .maybeSingle()

      const templateName = (integ?.config as any)?.payment_link_template_name
      if (!templateName) {
        await logBotError(adminClient, {
          organization_id: conv.organization_id, conversation_id,
          type: 'payment_link_failed', error_code: '131026',
          detail: 'Contacto fuera de la ventana de 24h y sin plantilla de link de pago configurada (integrations.config.payment_link_template_name)',
          source: 'send-message',
        })
        return json({ error: 'El contacto está fuera de la ventana de 24h y no hay plantilla de link de pago configurada (integrations.config.payment_link_template_name)' }, 422)
      }

      waRes = await sendWA({
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'es_MX' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: payment.concept }, { type: 'text', text: amountFmt }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: payment.id }] },
          ],
        },
      })
      waData = await waRes.json()
      savedContent = `[Plantilla ${templateName}] ${bodyText}\n${shortUrl}`
    }
  } else if (template_id) {
    // ── Plantilla aprobada (ventana de 24h cerrada) ──────────────────────────
    const { data: tpl } = await adminClient
      .from('message_templates')
      .select('id, organization_id, name, language, status, components')
      .eq('id', template_id)
      .maybeSingle()

    if (!tpl || tpl.organization_id !== conv.organization_id) {
      return json({ error: 'Plantilla no encontrada para esta organización' }, 404)
    }
    if (tpl.status !== 'APPROVED') {
      return json({ error: 'Esta plantilla no está aprobada por Meta todavía' }, 422)
    }

    const bodyComp  = (tpl.components || []).find((c: any) => c.type === 'BODY')
    const varNames: string[] = bodyComp?.variables || []

    // Solo sabemos rellenar nombre/negocio con datos reales del contacto —
    // una plantilla con variables de datos específicos (cita, pago…) nunca
    // se manda desde aquí con un valor inventado; eso lo hace el flujo que
    // sí tiene esos datos (send-reminders, send-message con payment_id).
    const KNOWN_VARS = new Set(['nombre', 'negocio'])
    if (!varNames.every(v => KNOWN_VARS.has(v))) {
      return json({ error: 'Esta plantilla usa datos específicos que no se pueden llenar desde aquí' }, 422)
    }

    const { data: org } = await adminClient.from('organizations').select('name').eq('id', conv.organization_id).maybeSingle()
    const contactName = (conv.contacts as any)?.name || (conv.contacts as any)?.phone || 'cliente'
    const resolveVar = (v: string) => (v === 'nombre' ? contactName : v === 'negocio' ? (org?.name || 'nuestro negocio') : v)

    const filledText = varNames.reduce(
      (text, v) => text.split(`[${v}]`).join(resolveVar(v)),
      bodyComp?.text || tpl.name,
    )

    waRes = await sendWA({
      type: 'template',
      template: {
        name: tpl.name,
        language: { code: tpl.language || 'es_MX' },
        components: varNames.length
          ? [{ type: 'body', parameters: varNames.map(v => ({ type: 'text', text: resolveVar(v) })) }]
          : [],
      },
    })
    waData = await waRes.json()
    savedContent = `[Plantilla ${tpl.name}] ${filledText}`
  } else {
    waRes = await sendWA({ type: 'text', text: { body: message!.trim() } })
    waData = await waRes.json()
    savedContent = message!.trim()

    // Fuera de la ventana de 24h (131026) → reintentar con la plantilla de
    // respaldo que mandó el caller, si la hay (ej. aviso de cita cancelada
    // cuando ya no se puede mandar texto libre).
    if (!waRes.ok && waData?.error?.code === 131026 && fallback_template_name) {
      const { data: tpl } = await adminClient
        .from('message_templates')
        .select('name, language, components')
        .eq('organization_id', conv.organization_id)
        .eq('name', fallback_template_name)
        .eq('status', 'APPROVED')
        .maybeSingle()

      const bodyComp  = (tpl?.components || []).find((c: any) => c.type === 'BODY')
      const varNames: string[] = bodyComp?.variables || []
      const KNOWN_VARS = new Set(['nombre', 'negocio'])
      // Variables que el caller ya sabe rellenar con datos reales (ej. servicio/
      // fecha/hora de una cita) tienen prioridad sobre las conocidas genéricas.
      const explicitVars = template_vars || {}

      if (tpl && varNames.every(v => KNOWN_VARS.has(v) || v in explicitVars)) {
        const { data: org } = await adminClient.from('organizations').select('name').eq('id', conv.organization_id).maybeSingle()
        const contactName = (conv.contacts as any)?.name || (conv.contacts as any)?.phone || 'cliente'
        const resolveVar = (v: string) =>
          v in explicitVars ? explicitVars[v] : v === 'nombre' ? contactName : v === 'negocio' ? (org?.name || 'nuestro negocio') : v

        waRes = await sendWA({
          type: 'template',
          template: {
            name: tpl.name,
            language: { code: tpl.language || 'es_MX' },
            components: varNames.length
              ? [{ type: 'body', parameters: varNames.map(v => ({ type: 'text', text: resolveVar(v) })) }]
              : [],
          },
        })
        waData = await waRes.json()
        savedContent = `[Plantilla ${tpl.name}] ${message!.trim()}`
      }
    }
  }

  if (!waRes.ok) {
    await logBotError(adminClient, {
      organization_id: conv.organization_id, conversation_id,
      type: payment_id ? 'payment_link_failed' : 'meta_rejected',
      error_code: String(waData?.error?.code ?? waRes.status),
      detail: `WhatsApp API error: ${waData.error?.message ?? JSON.stringify(waData)}`,
      source: 'send-message',
    })
    return json({
      error: `WhatsApp API error: ${waData.error?.message ?? JSON.stringify(waData)}`,
      error_code: waData?.error?.code ?? null,
    }, 502)
  }

  const waMessageId = waData.messages?.[0]?.id ?? null

  // Store message in DB — sent_by queda para mostrar en el panel quién del
  // equipo lo mandó (nunca lo pone el bot, que inserta sus mensajes desde
  // webhook-wa sin pasar por este endpoint).
  const { error: insertErr } = await adminClient.from('messages').insert({
    conversation_id,
    organization_id: conv.organization_id,
    direction:       'outbound',
    content:         savedContent,
    media_type:      'text',
    sent_by:         user.id,
  })

  if (insertErr) {
    return json({ error: `Mensaje enviado pero falló el registro: ${insertErr.message}` }, 500)
  }

  // Pausa al bot en esta conversación mientras el equipo responde a mano
  // (configurable por org, 30 min por defecto) — y si estaba marcada
  // needs_human, esta respuesta manual YA es la atención humana que se
  // esperaba: se quita la marca (así resume-paused-conversations deja de
  // contarla) y queda un rastro de que se resolvió sola, sin que nadie
  // tuviera que darle a "Marcar como atendida".
  const [{ data: orgProfile }, { data: bcPause }] = await Promise.all([
    adminClient.from('organization_profile').select('manual_reply_pause_minutes').eq('organization_id', conv.organization_id).maybeSingle(),
    adminClient.from('bot_configs').select('features').eq('organization_id', conv.organization_id).eq('enabled', true).maybeSingle(),
  ])
  const featurePauseHours = (bcPause?.features as any)?.human_pause_hours
  const pauseMinutes = featurePauseHours != null
    ? Math.round(Number(featurePauseHours) * 60)
    : (orgProfile?.manual_reply_pause_minutes ?? 30)

  // manual_reply_pause_minutes = 0 → pausa hasta medianoche en la zona horaria
  // de la org (útil para restaurantes: el equipo responde y el bot descansa el resto del día).
  let pauseUntil: string
  if (pauseMinutes === 0) {
    const { data: orgRow } = await adminClient
      .from('organizations')
      .select('timezone')
      .eq('id', conv.organization_id)
      .maybeSingle()
    const tz = orgRow?.timezone || 'America/Matamoros'
    const timeStr = new Date().toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const [h, m, s] = timeStr.split(':').map(Number)
    const minsElapsed = h * 60 + m + (s > 0 ? 1 : 0)
    const minsUntilMidnight = Math.max(1, 24 * 60 - minsElapsed)
    pauseUntil = new Date(Date.now() + minsUntilMidnight * 60_000).toISOString()
  } else {
    pauseUntil = new Date(Date.now() + pauseMinutes * 60_000).toISOString()
  }

  const convUpdate: Record<string, unknown> = {
    last_message_at:   new Date().toISOString(),
    updated_at:         new Date().toISOString(),
    human_pause_until: pauseUntil,
  }
  if (conv.needs_human) {
    convUpdate.needs_human = false
    convUpdate.bot_resumed_at = null
    convUpdate.needs_human_reason = 'Atendida por el equipo'
  }
  await adminClient.from('conversations').update(convUpdate).eq('id', conversation_id)

  return json({ ok: true, wa_message_id: waMessageId })
}
