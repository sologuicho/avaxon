import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { corsHeaders, json, resolveAdsCaller, getAdConnection, getOwnedPromotion } from '../_shared/socialAdsAuth.ts'
import { updateNodeStatus, updateAdSetBudgetOrEnd } from '../_shared/metaAds.ts'
import { validateBudget, validateDateRange } from '../social-ads-create/logic.ts'

// ── Pausar / reanudar / editar presupuesto o fecha final / duplicar ────────
// Una sola función con un discriminador `action` -- cada acción valida que
// la promoción esté en el estado correcto antes de tocar Meta, y deja un
// registro en social_promotion_audit.
//
// NO está desplegada a producción -- solo existe en el repo para revisión.

type Action = 'pausar' | 'reanudar' | 'editar_presupuesto' | 'editar_fecha_fin' | 'duplicar'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const resolved = await resolveAdsCaller(req)
  if ('error' in resolved) return resolved.error
  const { ctx } = resolved

  let body: { promotion_id?: string; action?: Action; budget_amount?: number; end_time?: string | null }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  if (!body.promotion_id || !body.action) return json({ error: 'promotion_id y action son requeridos' }, 422)

  const promo = await getOwnedPromotion(ctx.adminClient, ctx.organizationId, body.promotion_id)
  if (!promo) return json({ error: 'Promoción no encontrada' }, 404)

  if (body.action === 'duplicar') {
    const { data: dup, error: dupErr } = await ctx.adminClient.from('social_promotions').insert({
      organization_id: ctx.organizationId,
      post_target_id: promo.post_target_id,
      idempotency_key: crypto.randomUUID(),
      objective: promo.objective,
      audience_mode: promo.audience_mode,
      audience_spec: promo.audience_spec,
      saved_audience_id: promo.saved_audience_id,
      budget_mode: promo.budget_mode,
      budget_amount: promo.budget_amount,
      currency: promo.currency,
      start_time: new Date().toISOString(),
      end_time: null,
      placements: promo.placements,
      special_ad_categories: promo.special_ad_categories,
      status: 'borrador', // todavía no existe en Meta -- el usuario debe confirmar el wizard para crearla
      created_by: ctx.userId,
    }).select('*').single()
    if (dupErr || !dup) return json({ error: `No se pudo duplicar: ${dupErr?.message}` }, 500)
    await ctx.adminClient.from('social_promotion_audit').insert({
      promotion_id: promo.id, organization_id: ctx.organizationId, action: 'duplicar', actor_id: ctx.userId, detail: { new_promotion_id: dup.id },
    })
    return json({ ok: true, promotion: dup })
  }

  // El resto de acciones sí tocan Meta -- requieren que ya exista ahí.
  if (!promo.meta_ad_id || !promo.meta_adset_id) return json({ error: 'Esta promoción todavía no se creó en Meta.' }, 422)
  const conn = await getAdConnection(ctx.adminClient, ctx.organizationId)
  if (!conn) return json({ error: 'Conecta tu cuenta publicitaria de Meta.' }, 422)
  const creds = { adAccountId: conn.ad_account_id, accessToken: conn.accessToken }

  if (body.action === 'pausar') {
    if (!['activa', 'en_revision'].includes(promo.status)) return json({ error: `No se puede pausar una promoción en estado "${promo.status}".` }, 422)
    try { await updateNodeStatus(creds, promo.meta_ad_id, 'PAUSED') } catch (e: any) { return json({ error: e.message }, 502) }
    const { data: updated } = await ctx.adminClient.from('social_promotions').update({ status: 'pausada', updated_at: new Date().toISOString() }).eq('id', promo.id).select('*').single()
    await ctx.adminClient.from('social_promotion_audit').insert({ promotion_id: promo.id, organization_id: ctx.organizationId, action: 'pausar', actor_id: ctx.userId, detail: {} })
    return json({ ok: true, promotion: updated })
  }

  if (body.action === 'reanudar') {
    if (promo.status !== 'pausada') return json({ error: `No se puede reanudar una promoción en estado "${promo.status}".` }, 422)
    try { await updateNodeStatus(creds, promo.meta_ad_id, 'ACTIVE') } catch (e: any) { return json({ error: e.message }, 502) }
    const { data: updated } = await ctx.adminClient.from('social_promotions').update({ status: 'en_revision', updated_at: new Date().toISOString() }).eq('id', promo.id).select('*').single()
    await ctx.adminClient.from('social_promotion_audit').insert({ promotion_id: promo.id, organization_id: ctx.organizationId, action: 'reanudar', actor_id: ctx.userId, detail: {} })
    return json({ ok: true, promotion: updated })
  }

  if (body.action === 'editar_presupuesto') {
    if (!['activa', 'en_revision', 'pausada'].includes(promo.status)) return json({ error: `No se puede editar el presupuesto en estado "${promo.status}".` }, 422)
    const budgetErr = validateBudget(promo.budget_mode, Number(body.budget_amount), promo.currency)
    if (budgetErr) return json({ error: budgetErr }, 422)
    const cents = Math.round(Number(body.budget_amount) * 100)
    try {
      await updateAdSetBudgetOrEnd(creds, promo.meta_adset_id, promo.budget_mode === 'daily' ? { daily_budget: cents } : { lifetime_budget: cents })
    } catch (e: any) { return json({ error: e.message }, 502) }
    const { data: updated } = await ctx.adminClient.from('social_promotions').update({ budget_amount: body.budget_amount, updated_at: new Date().toISOString() }).eq('id', promo.id).select('*').single()
    await ctx.adminClient.from('social_promotion_audit').insert({ promotion_id: promo.id, organization_id: ctx.organizationId, action: 'editar_presupuesto', actor_id: ctx.userId, detail: { budget_amount: body.budget_amount } })
    return json({ ok: true, promotion: updated })
  }

  if (body.action === 'editar_fecha_fin') {
    const dateErr = validateDateRange(promo.start_time, body.end_time)
    if (dateErr) return json({ error: dateErr }, 422)
    try {
      await updateAdSetBudgetOrEnd(creds, promo.meta_adset_id, { end_time: body.end_time ?? undefined })
    } catch (e: any) { return json({ error: e.message }, 502) }
    const { data: updated } = await ctx.adminClient.from('social_promotions').update({ end_time: body.end_time ?? null, updated_at: new Date().toISOString() }).eq('id', promo.id).select('*').single()
    await ctx.adminClient.from('social_promotion_audit').insert({ promotion_id: promo.id, organization_id: ctx.organizationId, action: 'editar_fecha_fin', actor_id: ctx.userId, detail: { end_time: body.end_time } })
    return json({ ok: true, promotion: updated })
  }

  return json({ error: 'action inválida' }, 422)
})
