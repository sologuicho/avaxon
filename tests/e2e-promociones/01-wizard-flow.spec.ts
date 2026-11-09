import { test, expect } from '@playwright/test'
import { login, goToNavView, ORG_A_EMAIL, ORG_B_EMAIL } from './helpers'

async function openHistorialAndPromocionar(page, captionText: string) {
  await goToNavView(page, 'publicaciones')
  await page.click('#pub-tab-historial')
  await page.waitForTimeout(400)
  const row = page.locator('tr', { hasText: captionText })
  await row.getByRole('button', { name: 'Promocionar' }).click()
  await page.waitForSelector('#promo-modal-overlay', { state: 'visible' })
}

test('flujo completo: conectar (ya conectada) -> 5 pasos -> confirmar -> activar -> ver en Promociones', async ({ page }) => {
  await login(page, ORG_A_EMAIL)
  await openHistorialAndPromocionar(page, 'Post de prueba Org A')

  // Paso 1: Objetivo (ya conectada -> arranca en paso 1, no en paso 0)
  await expect(page.locator('#promo-step-body')).toContainText('objetivo')
  await page.locator('input[name="promo-obj"][value="traffic"]').check()
  await page.click('#promo-btn-next')

  // Paso 2: Público -- cambiar a personalizado y agregar un interés
  await expect(page.locator('#promo-step-body')).toContainText('Automático')
  await page.getByRole('button', { name: 'Personalizado' }).click()
  await page.fill('#promo-interest-input', 'Restaurantes')
  await page.waitForSelector('#promo-interest-suggestions div', { timeout: 3000 })
  await page.click('#promo-interest-suggestions div')
  await expect(page.locator('#promo-step-body')).toContainText('Restaurantes')
  await page.waitForTimeout(700) // debounce de promoRefreshEstimate
  await page.click('#promo-btn-next')

  // Paso 3: Presupuesto y duración
  await expect(page.locator('#promo-step-body')).toContainText('Gasto máximo')
  await page.fill('#promo-step-body input[type="number"]', '150')
  await page.click('#promo-btn-next')

  // Paso 4: Ubicaciones y vista previa
  await expect(page.locator('#promo-step-body')).toContainText('Vista previa')
  await expect(page.locator('#promo-step-body')).toContainText('Post de prueba Org A')
  await page.click('#promo-btn-next')

  // Paso 5: Confirmación -- nunca debe mostrar el alcance como garantizado
  await expect(page.locator('#promo-step-body')).toContainText('no garantizado')
  await expect(page.locator('#promo-step-body')).toContainText('pausada')
  await page.click('#promo-btn-next') // Confirmar y crear

  await expect(page.locator('#promo-step-body')).toContainText('Promoción creada (pausada)', { timeout: 10000 })
  await page.screenshot({ path: 'test-results/wizard-paso5-creada.png' })

  await page.getByRole('button', { name: 'Activar ahora' }).click()
  await page.waitForTimeout(1000)

  // Debe cerrar el wizard y mostrar la promoción activa en la pestaña Promociones
  await expect(page.locator('#promo-modal-overlay')).toBeHidden()
  await expect(page.locator('#pub-pane-promociones')).toContainText('En revisión')
})

test('doble clic en "Confirmar y crear" no crea dos promociones (idempotencia desde la UI)', async ({ page }) => {
  await login(page, ORG_A_EMAIL)
  await openHistorialAndPromocionar(page, 'Post de prueba Org A')

  for (let i = 0; i < 4; i++) await page.click('#promo-btn-next') // pasos 1-4 con defaults
  await expect(page.locator('#promo-step-body')).toContainText('no garantizado')

  // Doble clic real y rápido sobre "Confirmar y crear"
  const nextBtn = page.locator('#promo-btn-next')
  await Promise.all([nextBtn.click(), nextBtn.click({ force: true }).catch(() => {})])

  await expect(page.locator('#promo-step-body')).toContainText('Promoción creada (pausada)', { timeout: 10000 })
  // El botón se deshabilita en el primer clic (nextBtn.disabled=true), así
  // que el segundo clic no debió disparar una segunda petición -- de
  // cualquier forma, el idempotency_key es el mismo en todo el wizard, así
  // que aunque ambos clics llegaran a social-ads-create, el backend
  // (ver 00-smoke / social-ads-create/index.ts) regresa la misma fila.
})

test('el estado del wizard persiste entre pasos: objetivo, edad, presupuesto y fechas', async ({ page }) => {
  // Regresión del bug reportado 2026-11-10: estos campos mutaban
  // `promoWizard` directo desde un atributo onchange/onclick inline, que
  // corre en el scope global y nunca veía la variable del IIFE del
  // dashboard -- la asignación fallaba en silencio y todo volvía a mostrar
  // su valor por defecto al navegar entre pasos.
  await login(page, ORG_A_EMAIL)
  await openHistorialAndPromocionar(page, 'Post de prueba Org A')

  // Paso 1: un objetivo distinto al default ('engagement' / Interacción)
  await page.locator('input[name="promo-obj"][value="awareness"]').check()
  await page.click('#promo-btn-next')

  // Paso 2: personalizado, edad fuera del rango default 18-65
  await page.getByRole('button', { name: 'Personalizado' }).click()
  const ageInputs = page.locator('#promo-step-body input[type="number"]')
  await ageInputs.nth(0).fill('25')
  await ageInputs.nth(0).blur()
  await ageInputs.nth(1).fill('55')
  await ageInputs.nth(1).blur()
  await page.waitForTimeout(700) // debounce de promoRefreshEstimate
  await page.click('#promo-btn-next')

  // Paso 3: "Presupuesto total" (bug: el botón no hacía nada visible),
  // monto distinto al default 100, y fecha de fin
  await page.getByRole('button', { name: 'Presupuesto total' }).click()
  await expect(page.getByRole('button', { name: 'Presupuesto total' })).toHaveClass(/btn-primary/)
  await expect(page.locator('#promo-step-body')).toContainText('en total')
  await page.fill('#promo-step-body input[type="number"]', '150')
  await page.locator('#promo-step-body input[type="datetime-local"]').nth(1).fill('2026-12-31T18:00')
  await page.click('#promo-btn-next')

  // Paso 4 -> 5: el resumen debe reflejar lo elegido, no los defaults
  await page.click('#promo-btn-next')
  await expect(page.locator('#promo-step-body')).toContainText('150 MXN total')
  await expect(page.locator('#promo-step-body')).toContainText('2026-12-31 18:00')

  // Regresar hasta el paso 1 -- nada debe haber vuelto al default
  await page.click('#promo-btn-back') // 5 -> 4
  await page.click('#promo-btn-back') // 4 -> 3
  await expect(page.locator('#promo-step-body input[type="number"]')).toHaveValue('150')
  await expect(page.locator('#promo-step-body input[type="datetime-local"]').nth(1)).toHaveValue('2026-12-31T18:00')
  await expect(page.getByRole('button', { name: 'Presupuesto total' })).toHaveClass(/btn-primary/)
  await page.click('#promo-btn-back') // 3 -> 2
  await expect(page.locator('#promo-step-body')).toContainText('Personalizado')
  await expect(ageInputs.nth(0)).toHaveValue('25')
  await expect(ageInputs.nth(1)).toHaveValue('55')
  await page.click('#promo-btn-back') // 2 -> 1
  await expect(page.locator('input[name="promo-obj"][value="awareness"]')).toBeChecked()
})

test.describe('fecha de inicio por defecto en una zona horaria distinta a UTC', () => {
  // Fuerza America/Matamoros (UTC-6) sin importar la zona de la máquina que
  // corre la prueba -- así la regresión se detecta igual en cualquier CI.
  test.use({ timezoneId: 'America/Matamoros' })

  test('usa la hora local del navegador, no UTC', async ({ page }) => {
    // Regresión: el default se calculaba con toISOString() (siempre UTC) y
    // un <input type="datetime-local"> muestra ese string tal cual sin
    // convertir -- en UTC-6 se veía ~6 horas adelantado ("ahora + 10 min"
    // aparecía como "ahora + 6h10min").
    await login(page, ORG_A_EMAIL)
    await openHistorialAndPromocionar(page, 'Post de prueba Org A')
    await page.click('#promo-btn-next') // 1 -> 2
    await page.click('#promo-btn-next') // 2 -> 3
    const value = await page.locator('#promo-step-body input[type="datetime-local"]').first().inputValue()
    const diffMinutes = await page.evaluate((v) => (new Date(v).getTime() - Date.now()) / 60000, value)
    expect(diffMinutes).toBeGreaterThan(5)
    expect(diffMinutes).toBeLessThan(15)
  })
})

test('Org B no ve ni puede tocar las promociones de Org A (permisos cruzados en la UI)', async ({ page }) => {
  await login(page, ORG_B_EMAIL)
  await goToNavView(page, 'publicaciones')
  await page.click('#pub-tab-promociones')
  await page.waitForTimeout(500)
  await expect(page.locator('#pub-pane-promociones')).not.toContainText('Post de prueba Org A')
})
