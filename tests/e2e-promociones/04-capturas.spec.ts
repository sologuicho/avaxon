import { test, expect } from '@playwright/test'
import { login, goToNavView, ORG_A_EMAIL } from './helpers'

// Capturas para docs/capturas-promociones/ -- se copian ahí después de correr
// esto en los dos proyectos (desktop-chromium / mobile-chromium). No son
// aserciones estrictas de pixel-perfect, son evidencia de que cada paso y
// estado realmente se ve bien en el navegador real (ver docs/promociones-meta.md §7).

test('capturas: login, wizard (5 pasos + estados), lista con datos y vacía', async ({ page }, testInfo) => {
  const tag = testInfo.project.name
  await page.goto('/index.html')
  await page.screenshot({ path: `test-results/captura-${tag}-00-login.png`, fullPage: true })

  await login(page, ORG_A_EMAIL)

  await goToNavView(page, 'publicaciones')
  await page.click('#pub-tab-historial')
  await page.waitForTimeout(400)
  const row = page.locator('tr', { hasText: 'Post de prueba Org A' })
  await row.getByRole('button', { name: 'Promocionar' }).click()
  await page.waitForSelector('#promo-modal-overlay', { state: 'visible' })
  await page.screenshot({ path: `test-results/captura-${tag}-01-paso1-objetivo.png`, fullPage: true })

  await page.click('#promo-btn-next')
  await page.screenshot({ path: `test-results/captura-${tag}-02-paso2-publico.png`, fullPage: true })

  await page.click('#promo-btn-next')
  await page.screenshot({ path: `test-results/captura-${tag}-03-paso3-presupuesto.png`, fullPage: true })

  await page.click('#promo-btn-next')
  await page.screenshot({ path: `test-results/captura-${tag}-04-paso4-ubicaciones-preview.png`, fullPage: true })

  await page.click('#promo-btn-next')
  await expect(page.locator('#promo-step-body')).toContainText('no garantizado')
  await page.screenshot({ path: `test-results/captura-${tag}-05-paso5-confirmacion.png`, fullPage: true })

  // Estado "creando..." (best-effort, es una ventana angosta de tiempo) --
  // no se espera el click para poder tomar la captura mientras el botón
  // todavía dice "Creando…" y está deshabilitado.
  const clickPromise = page.click('#promo-btn-next')
  await page.waitForTimeout(50)
  await page.screenshot({ path: `test-results/captura-${tag}-06-estado-creando.png`, fullPage: true }).catch(() => {})
  await clickPromise
  await expect(page.locator('#promo-step-body')).toContainText('Promoción creada', { timeout: 10000 })
  await page.screenshot({ path: `test-results/captura-${tag}-07-estado-creada.png`, fullPage: true })

  await page.getByRole('button', { name: 'Dejar pausada' }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `test-results/captura-${tag}-08-lista-con-datos.png`, fullPage: true })

  // Estado vacío: filtrar a "Rechazadas" (no debería haber ninguna)
  await page.click('#promo-f-rechazada')
  await page.waitForTimeout(300)
  await expect(page.locator('#promo-list-empty')).toBeVisible()
  await page.screenshot({ path: `test-results/captura-${tag}-09-estado-vacio.png`, fullPage: true })
})
