/**
 * End-to-end tests (npm run e2e): Playwright drives the real web app served by a throw-away Folio
 * server (scripts/e2e-server.mjs: builds web/dist if needed, fresh DATA_DIR, users alice/bob/carol,
 * the real paper + an Example project). Compiles use Docker unless COMPILE_RUNNER=fake.
 *
 *   E2E_PORT=3199          port of the server under test
 *   COMPILE_RUNNER=fake    skip Docker (fixture PDF)
 *   E2E_WEB_DIST=<dir>     build/serve the web app from another directory
 *   E2E_PAPER=0            do not seed the real paper
 *   E2E_SHOTS=<dir>        where helpers.shot() writes screenshots (default test-results/e2e-shots)
 */
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 3199)

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  globalSetup: './e2e/global-setup.ts',
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    // Ready once the script prints the path of its state file (users and projects seeded); no
    // `url` on purpose — Playwright would race it against `wait` and start before the seeding.
    wait: { stdout: /FOLIO_E2E_READY (?<folio_e2e_state>\S+)/ },
    timeout: 300_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 45_000 },
    stdout: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
})
