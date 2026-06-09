import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { AppServices } from '../bootstrap.js'
import { logger } from '../shared/logger.js'
import { json, matchPath, type Route } from './http.js'
import { systemRoutes } from './routes/system.js'
import { thoughtRoutes } from './routes/thoughts.js'
import { tagRoutes } from './routes/tags.js'
import { duplicateRoutes } from './routes/duplicates.js'
import { importRoutes } from './routes/import.js'
import { activityRoutes } from './routes/activity.js'
import { streamRoutes } from './routes/stream.js'
import { distillationRoutes } from './routes/distillation.js'

const routes: readonly Route[] = [
  ...systemRoutes,
  ...thoughtRoutes,
  ...tagRoutes,
  ...duplicateRoutes,
  ...importRoutes,
  ...activityRoutes,
  ...streamRoutes,
  ...distillationRoutes,
]

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  services: AppServices,
): Promise<void> {
  try {
    for (const route of routes) {
      if (route.method !== req.method) continue
      const params = matchPath(url.pathname, route.pattern)
      if (!params) continue
      await route.handler({ req, res, url, params, services })
      return
    }

    json(res, { error: 'Not found' }, 404)
  } catch (error) {
    if (error instanceof z.ZodError) {
      json(res, { error: 'Validation failed', details: error.errors.map((e) => e.message) }, 400)
      return
    }
    logger.error({ err: error }, 'API error')
    json(res, { error: 'Internal server error' }, 500)
  }
}
