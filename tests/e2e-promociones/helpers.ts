import { Page } from '@playwright/test'

export const ORG_A_EMAIL = 'org-a-admin@test.local'
export const ORG_B_EMAIL = 'org-b-admin@test.local'
export const TEST_PASSWORD = 'test1234'

export async function login(page: Page, email: string, password: string = TEST_PASSWORD) {
  await page.goto('/index.html')
  await page.fill('#login-email', email)
  await page.fill('#login-password', password)
  await page.click('#login-btn')
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 15000 })
}

// En viewport angosto (móvil) el nav vive detrás del botón hamburguesa
// (fuera de pantalla vía CSS, no display:none -- isVisible() del nav-item no
// sirve para detectar esto, hay que fijarse en el propio botón hamburguesa,
// que solo se muestra bajo el media query angosto).
export async function goToNavView(page: Page, view: string) {
  const hamburger = page.locator('#hamburger-btn')
  if (await hamburger.isVisible()) {
    await hamburger.click()
    await page.waitForTimeout(300) // transición de apertura del drawer
  }
  await page.locator(`.nav-item[data-view="${view}"]`).click()
}

export async function openPublicacionesPromociones(page: Page) {
  await goToNavView(page, 'publicaciones')
  await page.waitForSelector('#pub-tab-promociones', { state: 'visible', timeout: 10000 })
  await page.click('#pub-tab-promociones')
  await page.waitForTimeout(500)
}
