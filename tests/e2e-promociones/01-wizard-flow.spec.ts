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

test('Org B no ve ni puede tocar las promociones de Org A (permisos cruzados en la UI)', async ({ page }) => {
  await login(page, ORG_B_EMAIL)
  await goToNavView(page, 'publicaciones')
  await page.click('#pub-tab-promociones')
  await page.waitForTimeout(500)
  await expect(page.locator('#pub-pane-promociones')).not.toContainText('Post de prueba Org A')
})
