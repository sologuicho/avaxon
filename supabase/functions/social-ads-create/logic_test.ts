Deno.env.set('META_ADS_MODE', 'mock')
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { validateBudget, validateSpecialAdCategory, validateDateRange, resolveEffectiveAudienceSpec } from './logic.ts'

Deno.test('validateBudget: rechaza presupuesto <= 0', () => {
  assert(validateBudget('daily', 0, 'MXN')?.includes('mayor a 0'))
  assert(validateBudget('daily', -5, 'MXN')?.includes('mayor a 0'))
})

Deno.test('validateBudget: rechaza presupuesto diario bajo el piso configurado', () => {
  Deno.env.set('META_ADS_MIN_DAILY_BUDGET_MXN', '50')
  assert(validateBudget('daily', 10, 'MXN')?.includes('mínimo'))
  assertEquals(validateBudget('daily', 50, 'MXN'), null)
  assertEquals(validateBudget('daily', 100, 'MXN'), null)
  Deno.env.delete('META_ADS_MIN_DAILY_BUDGET_MXN')
})

Deno.test('validateSpecialAdCategory: NONE o vacío siempre pasa', () => {
  assertEquals(validateSpecialAdCategory([], 'auto', {}), null)
  assertEquals(validateSpecialAdCategory(['NONE'], 'custom', { age_min: 13 }), null)
})

Deno.test('validateSpecialAdCategory: EMPLOYMENT/HOUSING/CREDIT exigen edad mínima 18', () => {
  const err = validateSpecialAdCategory(['EMPLOYMENT'], 'custom', { age_min: 16 })
  assert(err?.includes('edad mínima'))
  assertEquals(validateSpecialAdCategory(['EMPLOYMENT'], 'custom', { age_min: 18 }), null)
})

Deno.test('validateSpecialAdCategory: EMPLOYMENT/HOUSING/CREDIT bloquean intereses', () => {
  const err = validateSpecialAdCategory(['HOUSING'], 'custom', { age_min: 25, interests: [{ id: '1', name: 'x' }] })
  assert(err?.includes('intereses'))
})

Deno.test('validateSpecialAdCategory: ISSUES_ELECTIONS_POLITICS no exige edad/intereses (solo EMPLOYMENT/HOUSING/CREDIT lo hacen)', () => {
  assertEquals(validateSpecialAdCategory(['ISSUES_ELECTIONS_POLITICS'], 'custom', { age_min: 13, interests: [{ id: '1', name: 'x' }] }), null)
})

Deno.test('validateSpecialAdCategory: categoría desconocida se rechaza', () => {
  const err = validateSpecialAdCategory(['ALGO_INVENTADO'], 'auto', {})
  assert(err?.includes('desconocida'))
})

Deno.test('validateDateRange: fin debe ser posterior a inicio', () => {
  const now = new Date().toISOString()
  const before = new Date(Date.now() - 86400000).toISOString()
  assert(validateDateRange(now, before)?.includes('posterior'))
  assertEquals(validateDateRange(now, null), null)
})

Deno.test('resolveEffectiveAudienceSpec: el override gana sobre el público guardado', () => {
  const saved = { age_min: 18, age_max: 65, interests: [{ id: '1', name: 'Comida' }] }
  const override = { age_max: 40 }
  const result = resolveEffectiveAudienceSpec(saved, override)
  assertEquals(result.age_min, 18)
  assertEquals(result.age_max, 40)
  assertEquals(result.interests?.[0].id, '1')
})

Deno.test('resolveEffectiveAudienceSpec: sin público guardado usa solo el override', () => {
  const result = resolveEffectiveAudienceSpec(null, { age_min: 21 })
  assertEquals(result.age_min, 21)
})
