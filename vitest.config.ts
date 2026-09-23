import { defineConfig } from 'vitest/config'

/**
 * Unit + integration tests (npm test). Docker-backed suites run only with FOLIO_DOCKER_TESTS=1
 * (npm run test:docker). Server logs are limited to errors (many tests provoke expected
 * warnings); set LOG_LEVEL=debug to see everything.
 */
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: './shared', include: ['test/**/*.test.ts'], environment: 'node' } },
      // pure web modules and stores (no DOM: tests stub the few browser globals they need)
      { test: { name: 'web', root: './web', include: ['src/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'server',
          root: './server',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          pool: 'forks',
          env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'error' },
        },
      },
    ],
  },
})
