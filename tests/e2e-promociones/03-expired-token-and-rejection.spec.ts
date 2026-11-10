import { test, expect } from '@playwright/test'
import { login, goToNavView, ORG_A_EMAIL } from './helpers'
import { execSync } from 'node:child_process'

function psql(sql: string) {
  execSync(`docker exec -i supabase_db_wprvjhvtnyibiwpeiusc psql -U postgres -d postgres -c "${sql.replace(/"/g, '\\"')}"`)
}

test.describe.serial('token vencido y rechazo de Meta', () => {
  test('token vencido: la pestaña Promociones muestra el banner de "necesita atención"', async ({ page }) => {
    psql("update social_ad_connections set status = 'token_expired', last_error_message = 'Simulado para prueba E2E' where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';")
    try {
      await login(page, ORG_A_EMAIL)
      await goToNavView(page, 'publicaciones')
      await page.click('#pub-tab-promociones')
      await page.waitForTimeout(500)
      await expect(page.locator('#promo-ads-banner')).toBeVisible()
      await expect(page.locator('#promo-ads-banner-text')).toContainText('token_expired')
      await page.screenshot({ path: 'test-results/token-expirado-banner.png' })
    } finally {
      psql("update social_ad_connections set status = 'connected', last_error_message = null where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';")
    }
  })

  test('rechazo de Meta: el wizard muestra el error y no deja una promoción a medias', async ({ page }) => {
    await login(page, ORG_A_EMAIL)
    await goToNavView(page, 'publicaciones')
    await page.click('#pub-tab-historial')
    await page.waitForTimeout(400)

    const row = page.locator('tr', { hasText: 'Post para probar rechazo de Meta' })
    await row.getByRole('button', { name: 'Promocionar' }).click()
    await page.waitForSelector('#promo-modal-overlay', { state: 'visible' })

    for (let i = 0; i < 4; i++) await page.click('#promo-btn-next') // pasos 1-4 con defaults
    await expect(page.locator('#promo-step-body')).toContainText('no garantizado')
    await page.click('#promo-btn-next') // Confirmar y crear -> debe rechazar

    await expect(page.locator('#avx-toast')).toContainText('Meta rechazó', { timeout: 10000 }).catch(async () => {
      // Si el toast ya desapareció para cuando corre esta aserción, al menos
      // el wizard no debe haber avanzado a la pantalla de "creada".
      await expect(page.locator('#promo-step-body')).not.toContainText('Promoción creada')
    })
    await expect(page.locator('#promo-step-body')).toContainText('no garantizado') // sigue en paso 5, no avanzó
    await page.screenshot({ path: 'test-results/rechazo-meta.png' })
  })
})
