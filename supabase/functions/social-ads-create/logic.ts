// Lógica pura de validación de social-ads-create -- sin red, sin DB, para
// poder probarla de verdad con `deno test` (ver logic_test.ts). La misma
// regla de categorías especiales también vive en la base (trigger
// validate_special_ad_category en la migración) -- aquí se repite a propósito
// para dar un mensaje de error claro ANTES de llamar a Meta, en vez de
// depender de que la excepción cruda de Postgres se vea bien en el frontend.
import { AudienceSpec, minDailyBudget } from '../_shared/metaAds.ts'

export const SPECIAL_AD_CATEGORIES = ['NONE', 'EMPLOYMENT', 'HOUSING', 'CREDIT', 'ISSUES_ELECTIONS_POLITICS'] as const
const RESTRICTED_CATEGORIES = ['EMPLOYMENT', 'HOUSING', 'CREDIT']

export function validateBudget(budgetMode: 'daily' | 'lifetime', budgetAmount: number, currency: string): string | null {
  if (!(budgetAmount > 0)) return 'El presupuesto debe ser mayor a 0.'
  const floor = minDailyBudget(currency)
  if (budgetMode === 'daily' && budgetAmount < floor) {
    return `El presupuesto diario mínimo es de ${floor} ${currency}.`
  }
  if (budgetMode === 'lifetime' && budgetAmount < floor) {
    return `El presupuesto total mínimo es de ${floor} ${currency}.`
  }
  return null
}

export function validateSpecialAdCategory(
  categories: string[],
  audienceMode: 'auto' | 'custom',
  spec: AudienceSpec,
): string | null {
  const real = (categories ?? []).filter(c => c && c !== 'NONE')
  if (!real.length) return null
  for (const c of real) {
    if (!SPECIAL_AD_CATEGORIES.includes(c as any)) return `Categoría especial de anuncios desconocida: ${c}.`
  }
  const restricted = real.some(c => RESTRICTED_CATEGORIES.includes(c))
  if (!restricted) return null
  if (audienceMode === 'custom') {
    if ((spec.age_min ?? 18) < 18) return 'Las categorías de empleo, vivienda o crédito exigen edad mínima 18 años.'
    if (spec.interests?.length) return 'Las categorías de empleo, vivienda o crédito no permiten segmentar por intereses.'
  }
  return null
}

export function validateDateRange(startTime: string, endTime: string | null | undefined): string | null {
  const start = new Date(startTime)
  if (isNaN(start.getTime())) return 'Fecha de inicio inválida.'
  if (!endTime) return null
  const end = new Date(endTime)
  if (isNaN(end.getTime())) return 'Fecha de fin inválida.'
  if (end <= start) return 'La fecha de fin debe ser posterior a la de inicio.'
  return null
}

// Combina el público guardado (si se eligió uno) con los overrides sueltos
// que el wizard manda -- el público guardado es la base, cualquier campo que
// venga explícito en `spec` gana.
export function resolveEffectiveAudienceSpec(savedSpec: AudienceSpec | null, overrideSpec: AudienceSpec | null): AudienceSpec {
  return { ...(savedSpec ?? {}), ...(overrideSpec ?? {}) }
}
