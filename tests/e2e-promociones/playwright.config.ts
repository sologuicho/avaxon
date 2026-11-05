import { defineConfig, devices } from '@playwright/test'

// E2E de "Promocionar publicaciones" -- SOLO contra Supabase local (Docker) +
// dashboard servido en localhost con META_ADS_MODE=mock. Nunca apunta a
// producción. Ver docs/promociones-meta.md §7 para cómo se levanta todo esto.
//
// package.json/node_modules viven en ESTE subdirectorio (no en la raíz del
// repo) a propósito: un package.json en la raíz hace que `deno check` sobre
// las Edge Functions intente resolver tipos vía Node (porque Deno camina
// hacia arriba buscando package.json/node_modules), lo que rompe el
// type-check de supabase/functions/*. tests/e2e-promociones/ no es ancestro
// de esa carpeta, así que aislarlo aquí evita el conflicto por completo.
export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  // Postgres local (Docker, recursos limitados) se satura con varios
  // workers pegándole a la vez -- confirmado: con 2+ workers GoTrue tronaba
  // con "dial tcp ... i/o timeout" al loguearse. En CI real con más recursos
  // esto podría subirse, pero en este entorno 1 worker es lo confiable.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8744',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
})
