import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Plantillas de WhatsApp ↔ Meta ────────────────────────────────────────────
// Antes "Enviar a revisión" solo cambiaba message_templates.status a PENDING
// en nuestra base — nunca llamaba a Meta, así que el estado real (Aprobada /
// Rechazada y por qué) jamás se reflejaba. Este endpoint es el único lugar
// que habla con la API de plantillas de Meta (POST para crear, GET para
// sincronizar estado, DELETE al borrar), para que message_templates.status
// siempre sea lo que Meta diga — nunca algo que el equipo marque a mano.
//
// action: 'submit' (manda una plantilla DRAFT a revisión de Meta)
//       | 'sync'   (jala el estado actual de Meta para las ya enviadas —
//                    botón "Sincronizar con Meta"; complementa al webhook
//                    message_template_status_update, por si Meta no lo manda)
//       | 'delete' (borra en Meta, si ya se había enviado, y en nuestra base)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

const META_API = 'https://graph.facebook.com/v20.0'

function exampleForVar(v: string, orgName: string): string {
  if (v === 'nombre') return 'Juan Pérez'
  if (v === 'negocio') return orgName || 'Mi Negocio'
  if (v === 'servicio') return 'Consulta general'
  if (v === 'fecha') return '16 de octubre'
  if (v === 'hora') return '3:00 p.m.'
  return 'Ejemplo'
}

function cleanReason(reason: unknown): string | null {
  const r = typeof reason === 'string' ? reason.trim() : ''
  return r && r !== 'NONE' ? r : null
}

interface Body {
  action?: 'submit' | 'sync' | 'delete'
  organization_id?: string
  template_id?: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await callerClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  let body: Body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: profile } = await adminClient.from('profiles').select('organization_id, role').eq('id', user.id).maybeSingle()

  const organizationId = body.organization_id || profile?.organization_id
  if (!organizationId) return json({ error: 'organization_id requerido' }, 422)
  if (profile?.role !== 'super_admin' && organizationId !== profile?.organization_id) {
    return json({ error: 'No autorizado para esta organización' }, 403)
  }

  const { data: waAccount } = await adminClient
    .from('whatsapp_accounts')
    .select('waba_id, access_token')
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (!waAccount?.waba_id || !waAccount?.access_token) {
    return json({ error: 'Esta organización no tiene una cuenta de WhatsApp Business conectada' }, 422)
  }

  const metaFetch = (path: string, init: RequestInit = {}) =>
    fetch(`${META_API}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${waAccount.access_token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    })

  // ── Enviar una plantilla DRAFT a revisión de Meta ──────────────────────────
  if (body.action === 'submit') {
    const templateId = body.template_id
    if (!templateId) return json({ error: 'template_id requerido' }, 422)

    const { data: tpl } = await adminClient.from('message_templates').select('*').eq('id', templateId).eq('organization_id', organizationId).maybeSingle()
    if (!tpl) return json({ error: 'Plantilla no encontrada' }, 404)
    if (tpl.meta_template_id) return json({ error: 'Esta plantilla ya se envió a Meta' }, 422)

    const bodyComp = (tpl.components || []).find((c: any) => c.type === 'BODY')
    if (!bodyComp?.text) return json({ error: 'La plantilla no tiene texto en el cuerpo' }, 422)

    const { data: org } = await adminClient.from('organizations').select('name').eq('id', organizationId).maybeSingle()
    const variables: string[] = bodyComp.variables || []

    // Meta exige {{1}}, {{2}}… con ejemplo por variable — no acepta
    // [nombre]/[negocio], que es solo nuestra convención interna para la
    // vista previa en el dashboard.
    let metaText = bodyComp.text as string
    const examples: string[] = []
    variables.forEach((v: string, i: number) => {
      metaText = metaText.split(`[${v}]`).join(`{{${i + 1}}}`)
      examples.push(exampleForVar(v, org?.name || ''))
    })

    const component: Record<string, unknown> = { type: 'BODY', text: metaText }
    if (examples.length) component.example = { body_text: [examples] }

    const language = tpl.language === 'es' ? 'es_MX' : (tpl.language || 'es_MX')

    const metaRes = await metaFetch(`${waAccount.waba_id}/message_templates`, {
      method: 'POST',
      body: JSON.stringify({ name: tpl.name, language, category: tpl.category || 'MARKETING', components: [component] }),
    })
    const metaData = await metaRes.json()
    if (!metaRes.ok) {
      return json({ error: metaData?.error?.error_user_msg || metaData?.error?.message || 'Meta rechazó la plantilla' }, 502)
    }

    const { error: updErr } = await adminClient.from('message_templates').update({
      meta_template_id: String(metaData.id),
      status:           metaData.status || 'PENDING',
      language,
      rejected_reason:  null,
      updated_at:       new Date().toISOString(),
    }).eq('id', templateId)
    if (updErr) return json({ error: updErr.message }, 500)

    return json({ ok: true, meta_template_id: metaData.id, status: metaData.status || 'PENDING' })
  }

  // ── Jalar el estado real de Meta (botón "Sincronizar con Meta") ───────────
  if (body.action === 'sync') {
    const { data: templates } = await adminClient
      .from('message_templates')
      .select('id, meta_template_id')
      .eq('organization_id', organizationId)
      .not('meta_template_id', 'is', null)

    if (!templates || !templates.length) return json({ ok: true, updated: 0, checked: 0 })

    const metaRes = await metaFetch(`${waAccount.waba_id}/message_templates?fields=id,name,status,category,language,rejected_reason&limit=200`)
    const metaData = await metaRes.json()
    if (!metaRes.ok) return json({ error: metaData?.error?.message || 'Error al consultar Meta' }, 502)

    const byMetaId: Record<string, any> = {}
    for (const row of metaData.data || []) byMetaId[String(row.id)] = row

    let updated = 0
    const localMetaIds = new Set(templates.map((t: any) => String(t.meta_template_id)))

    for (const tpl of templates) {
      const metaRow = byMetaId[String(tpl.meta_template_id)]
      if (!metaRow) continue
      const { error } = await adminClient.from('message_templates').update({
        status:           metaRow.status,
        category:         metaRow.category,
        language:         metaRow.language,
        rejected_reason:  cleanReason(metaRow.rejected_reason),
        updated_at:       new Date().toISOString(),
      }).eq('id', tpl.id)
      if (!error) updated++
    }

    // Insert templates that exist in Meta but have no local row
    let inserted = 0
    for (const metaRow of (metaData.data || [])) {
      if (localMetaIds.has(String(metaRow.id))) continue
      const { error } = await adminClient.from('message_templates').insert({
        organization_id:  organizationId,
        name:             metaRow.name,
        meta_template_id: String(metaRow.id),
        status:           metaRow.status,
        category:         metaRow.category || 'UTILITY',
        language:         metaRow.language || 'es_MX',
        rejected_reason:  cleanReason(metaRow.rejected_reason),
        components:       [],
        created_at:       new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      })
      if (!error) inserted++
    }

    return json({ ok: true, updated, inserted, checked: templates.length })
  }

  // ── Borrar (en Meta, si ya se había enviado, y localmente) ────────────────
  if (body.action === 'delete') {
    const templateId = body.template_id
    if (!templateId) return json({ error: 'template_id requerido' }, 422)
    const { data: tpl } = await adminClient.from('message_templates').select('id, name, meta_template_id').eq('id', templateId).eq('organization_id', organizationId).maybeSingle()
    if (!tpl) return json({ error: 'Plantilla no encontrada' }, 404)

    if (tpl.meta_template_id) {
      try {
        await metaFetch(`${waAccount.waba_id}/message_templates?name=${encodeURIComponent(tpl.name)}`, { method: 'DELETE' })
      } catch (e) {
        console.error('sync-templates: error borrando en Meta:', e)
      }
    }
    const { error } = await adminClient.from('message_templates').delete().eq('id', templateId)
    if (error) return json({ error: error.message }, 500)
    return json({ ok: true })
  }

  return json({ error: 'action inválida' }, 422)
})
