import { logger } from '../../shared/logger.js'
import { clampInt, isValidUuid, json, type Route } from '../http.js'

export const distillationRoutes: readonly Route[] = [
  {
    method: 'POST',
    pattern: '/api/distillation/run',
    handler: async ({ res, services }) => {
      if (services.distillationService.isRunning()) {
        json(res, { error: 'Distillation is already running' }, 409)
        return
      }
      services.distillationService.run('power_nap').catch((err) => {
        logger.error({ err }, 'Background distillation run failed')
      })
      json(res, { started: true })
    },
  },
  {
    method: 'GET',
    pattern: '/api/distillation/status',
    handler: async ({ res, services }) => {
      const running = services.distillationService.isRunning()
      const recent = await services.distillationRepo.getRecentRuns(1)
      const lastRun = recent[0] ?? null

      json(res, {
        running,
        last_run: lastRun ? {
          id: lastRun.id,
          trigger: lastRun.trigger,
          status: lastRun.status,
          thoughts_created: lastRun.thoughtsCreated,
          blocks_processed: lastRun.blocksProcessed,
          duration_ms: lastRun.durationMs,
          created_at: lastRun.createdAt?.toISOString() ?? null,
        } : null,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/distillation/log',
    handler: async ({ res, url, services }) => {
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100)
      const runs = await services.distillationRepo.getRecentRuns(limit)

      json(res, {
        runs: runs.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          status: r.status,
          blocks_processed: r.blocksProcessed,
          sessions_processed: r.sessionsProcessed,
          thoughts_created: r.thoughtsCreated,
          thought_ids: r.thoughtIds,
          blocks_skipped: r.blocksSkipped,
          tokens_used: r.tokensUsed,
          estimated_cost: r.estimatedCost,
          duration_ms: r.durationMs,
          error_message: r.errorMessage,
          created_at: r.createdAt?.toISOString() ?? null,
        })),
        total: runs.length,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/distillation/log/:id',
    handler: async ({ res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid run ID' }, 400)
        return
      }
      const run = await services.distillationRepo.getRunById(id)
      if (!run) {
        json(res, { error: 'Run not found' }, 404)
        return
      }

      // Enrich thought_ids with titles for UI display
      const thoughtSummaries = await Promise.all(
        (run.thoughtIds ?? []).map(async (tid) => {
          const thought = await services.repository.findById(tid)
          return thought
            ? { id: tid, title: thought.title ?? thought.content.slice(0, 80) }
            : { id: tid, title: null }
        }),
      )

      json(res, {
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        blocks_processed: run.blocksProcessed,
        sessions_processed: run.sessionsProcessed,
        thoughts_created: run.thoughtsCreated,
        thought_ids: run.thoughtIds,
        thought_summaries: thoughtSummaries,
        blocks_skipped: run.blocksSkipped,
        skip_reasons: run.skipReasons,
        tokens_used: run.tokensUsed,
        estimated_cost: run.estimatedCost,
        duration_ms: run.durationMs,
        error_message: run.errorMessage,
        created_at: run.createdAt?.toISOString() ?? null,
      })
    },
  },
]
