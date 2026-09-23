import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'

/**
 * The Vite dev server (`npm run dev`, dev-instance --vite-port) proxies /api, /ws, /pdfjs and
 * /healthz to the Folio server. It reads the same settings as the server: the shell environment
 * first, then the app's `.env` (or FOLIO_ENV_FILE; `none` reads no file — server/src/env.ts rules),
 * so PORT / HOST / VITE_PORT set in `.env` move both halves of `npm run dev` together.
 *
 *   FOLIO_API    proxy target (default http://<HOST>:<PORT>, i.e. http://127.0.0.1:3100)
 *   VITE_PORT    port of the dev server (default 5173)
 *
 * Only these keys are taken from the file: the rest of `.env` (secrets, NODE_ENV…) stays out of
 * Vite's process.env.
 */
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))

function readEnvFile(): Record<string, string> {
  const requested = process.env.FOLIO_ENV_FILE?.trim()
  if (requested === 'none') return {}
  const file = requested ? path.resolve(requested) : path.join(APP_ROOT, '.env')
  try {
    return parseEnv(fs.readFileSync(file, 'utf8')) as Record<string, string>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Folio: could not read ${file}: ${(err as Error).message}`)
    return {}
  }
}

const fileEnv = readEnvFile()
/** a setting as the server sees it: the environment wins over the file; empty means unset */
const setting = (name: string): string | undefined => (process.env[name] ?? fileEnv[name])?.trim() || undefined

/** where the server can be reached from this machine, given the address it listens on */
function apiTarget(): string {
  const explicit = setting('FOLIO_API')
  if (explicit) return explicit.replace(/\/+$/, '')
  const host = setting('HOST') ?? '127.0.0.1'
  const connect = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${connect}:${setting('PORT') ?? 3100}`
}

const API = apiTarget()
const WS = API.replace(/^http/, 'ws')
const PORT = Number(setting('VITE_PORT') ?? 5173)

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    // A single instance of each is required (instanceof / facet identity checks).
    dedupe: ['yjs', 'y-protocols', 'lib0', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@lezer/common', '@lezer/highlight'],
  },
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    // changeOrigin must stay false: the server's CSRF check compares Origin with Host.
    proxy: {
      '/api': { target: API },
      '/ws': { target: WS, ws: true },
      '/pdfjs': { target: API },
      '/healthz': { target: API },
    },
  },
  // pre-bundle pdf.js so the lazily loaded viewer chunk doesn't trigger a dev re-optimise + reload
  optimizeDeps: { include: ['pdfjs-dist', 'pdfjs-dist/web/pdf_viewer.mjs'] },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
  },
})
