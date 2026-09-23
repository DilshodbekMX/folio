import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Checks of the operational scripts and documents (npm run test:scripts): the README backup and
 * restore procedure, `npm start` signal handling, the env handling of `npm run dev`
 * (web/vite.config.ts), scripts/setup.mjs and the throw-away servers (scripts/dev-instance.mjs,
 * scripts/e2e-server.mjs). They start real Folio servers (fake compile runner, temporary data
 * directories, free ports), so they are slower than `npm test` and not part of it.
 */
export default defineConfig({
  // the app's node_modules, not a new scripts/node_modules
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/scripts', import.meta.url)),
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
