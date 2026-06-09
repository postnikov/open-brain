import { z } from 'zod'
import { logger } from '../../shared/logger.js'
import { json, parseJsonBody, type Route } from '../http.js'

const importFilesSchema = z.object({
  files: z.array(z.object({
    name: z.string().min(1).max(500),
    content: z.string().min(1).max(102400),
    tags: z.array(z.string().max(100)).max(20).optional(),
  })).min(1).max(50),
  source: z.string().max(50).default('upload'),
})

const obsidianScanSchema = z.object({
  path: z.string().min(1).max(1000),
})

const obsidianStartSchema = z.object({
  path: z.string().min(1).max(1000),
  files: z.array(z.string().min(1).max(500)).min(1).max(500),
})

export const importRoutes: readonly Route[] = [
  {
    method: 'POST',
    pattern: '/api/import/files',
    handler: async ({ req, res, services }) => {
      const raw = await parseJsonBody(req, 1024 * 1024 * 6)
      const body = importFilesSchema.parse(raw)
      const progress = services.importService.getProgress()
      if (progress.running) {
        json(res, { error: 'Import already in progress' }, 409)
        return
      }
      services.importService.importFiles(body.files, body.source).catch((err) => {
        logger.error({ err }, 'Background file import failed')
      })
      json(res, { started: true, total: body.files.length })
    },
  },
  {
    method: 'POST',
    pattern: '/api/import/obsidian/scan',
    handler: async ({ req, res, services }) => {
      const raw = await parseJsonBody(req)
      const body = obsidianScanSchema.parse(raw)
      const files = await services.importService.scanVault(body.path)
      json(res, { files, total: files.length })
    },
  },
  {
    method: 'POST',
    pattern: '/api/import/obsidian/start',
    handler: async ({ req, res, services }) => {
      const raw = await parseJsonBody(req)
      const body = obsidianStartSchema.parse(raw)
      const progress = services.importService.getProgress()
      if (progress.running) {
        json(res, { error: 'Import already in progress' }, 409)
        return
      }
      services.importService.importVaultFiles(body.path, body.files).catch((err) => {
        logger.error({ err }, 'Background vault import failed')
      })
      json(res, { started: true, total: body.files.length })
    },
  },
  {
    method: 'GET',
    pattern: '/api/import/status',
    handler: async ({ res, services }) => {
      json(res, services.importService.getProgress())
    },
  },
]
