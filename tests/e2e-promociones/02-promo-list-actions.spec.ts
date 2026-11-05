import { test, expect } from '@playwright/test'
import { login, goToNavView, ORG_A_EMAIL } from './helpers'

test('pausar, reanudar, editar presupuesto y duplicar desde la lista de Promociones', async ({ page }) => {
  await login(page, ORG_A_EMAIL)
  await goToNavView(page, 'publicaciones')
  await page.click('#pub-tab-promociones')
  await page.waitForTimeout(500)

  // Fila con una promoción en revisión/activa (la que dejó el wizard de
  // 01-wizard-flow.spec.ts) -- se identifica por tener el botón "Pausar".
  const row = page.locator('#promo-list-tbody tr').filter({ has: page.getByRole('button', { name: 'Pausar' }) }).first()
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: 'Pausar' }).click()
  await page.waitForTimeout(600)
  await expect(page.locator('#promo-list-tbody')).toContainText('Pausada')

  const pausedRow = page.locator('#promo-list-tbody tr').filter({ has: page.getByRole('button', { name: 'Reanudar' }) }).first()
  await pausedRow.getByRole('button', { name: 'Reanudar' }).click()
  await page.waitForTimeout(600)
  await expect(page.locator('#promo-list-tbody')).toContainText('En revisión')

  // Editar presupuesto usa prompt() nativo
  const activeRow = page.locator('#promo-list-tbody tr').filter({ has: page.getByRole('button', { name: 'Editar presupuesto' }) }).first()
  page.once('dialog', dialog => dialog.accept('333'))
  await activeRow.getByRole('button', { name: 'Editar presupuesto' }).click()
  await page.waitForTimeout(600)

  const rowCountBefore = await page.locator('#promo-list-tbody tr').count()
  const dupRow = page.locator('#promo-list-tbody tr').filter({ has: page.getByRole('button', { name: 'Duplicar' }) }).first()
  await dupRow.getByRole('button', { name: 'Duplicar' }).click()
  await page.waitForTimeout(600)
  const rowCountAfter = await page.locator('#promo-list-tbody tr').count()
  expect(rowCountAfter).toBe(rowCountBefore + 1)
  await expect(page.locator('#promo-list-tbody')).toContainText('Borrador')

  await page.screenshot({ path: 'test-results/promo-list-after-actions.png', fullPage: true })
})
