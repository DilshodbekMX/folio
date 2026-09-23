/**
 * The complete Express application: foundation routes (http/base.ts) plus the route modules of
 * compile, synctex and history.
 */
import type express from 'express'
import type { Services } from '../services.ts'
import { compileRoutes } from '../compile/routes.ts'
import { synctexRoutes } from '../synctex/routes.ts'
import { historyRoutes } from '../history/routes.ts'
import { buildApp } from './base.ts'

export { buildApp, foundationRouters } from './base.ts'

export function createApp(services: Services): express.Express {
  return buildApp(services, {
    extraRouters: [compileRoutes(services), synctexRoutes(services), historyRoutes(services)],
  })
}
