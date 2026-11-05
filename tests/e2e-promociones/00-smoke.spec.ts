import { test, expect } from '@playwright/test'
import { login, openPublicacionesPromociones, ORG_A_EMAIL } from './helpers'

// Nota: el stub local de BD (ver docs/promociones-meta.md §7) solo
// reconstruye organizations/profiles + las tablas de publicaciones_redes y
// promocion_publicaciones -- NO reconstruye contacts/integrations/bot_configs
// etc., así que otras secciones del dashboard que cargan datos en segundo
// plano al hacer bootstrap() sí van a loguear 404/400 esperados. Este test
// solo falla si aparece un error relacionado con ESTA feature.
test('login + navegar a Publicaciones > Promociones sin errores relacionados a la feature', async ({ page }) => {
  const relevantErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error' && /social-ads|social_promotion|social_ad_connection|social_audience|promo/i.test(msg.text())) {
      relevantErrors.push(msg.text())
    }
  })
  page.on('pageerror', err => relevantErrors.push(String(err)))

  await login(page, ORG_A_EMAIL)
  await openPublicacionesPromociones(page)

  await expect(page.locator('#pub-pane-promociones')).toBeVisible()
  await expect(page.locator('#pub-pane-promociones')).toContainText('Post de prueba Org A')

  await page.screenshot({ path: 'test-results/smoke-promociones.png', fullPage: true })

  if (relevantErrors.length) console.log('ERRORES RELEVANTES:\n' + relevantErrors.join('\n'))
  expect(relevantErrors, 'no debe haber errores de consola relacionados a promociones').toEqual([])
})
