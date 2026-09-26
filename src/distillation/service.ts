import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { DistillationError } from '../shared/errors.js'
import { buildDistillationPrompt, parseDistillationResponse } from './prompt.js'
import type { StreamRepository } from '../stream/types.js'
import type { CapturePipeline } from '../pipeline/capture.js'
import type { DistillationRepository, DistillationRunResult, DistillationService } from './types.js'
import { RetryStore, type RetryConfig } from './retry-store.js'
import { replayDistillation } from './replay.js'
import { distillationUsage, recordAiCall } from './usage.js'

interface DistillationServiceConfig extends RetryConfig { readonly maxBlocksPerRun: number }

export function createDistillationService(
  _streamRepo: StreamRepository, pipeline: CapturePipeline, distillationRepo: DistillationRepository,
  config: DistillationServiceConfig, apiKey: string, store: RetryStore,
): DistillationService {
  let running = false
  const client = new OpenAI({ apiKey, maxRetries: 0 })
  return {
    isRunning: () => running,
    retryStatus: () => process.env.OPEN_BRAIN_MAINTENANCE === '1' ? Promise.resolve([]) : store.status(),
    async run(trigger: string): Promise<DistillationRunResult> {
      if (process.env.OPEN_BRAIN_MAINTENANCE === '1') throw new DistillationError('Distillation disabled for maintenance')
      if (running) throw new DistillationError('Distillation is already running')
      running = true
      const start = Date.now()
      let jobId: string | null = null
      try {
        jobId = await store.reserveNext(config.maxBlocksPerRun, { ...config, trigger }, trigger === 'retry')
        if (!jobId) return { runId: randomUUID(), trigger, status: 'success', blocksProcessed: 0, sessionsProcessed: 0,
          thoughtsCreated: 0, thoughtIds: [], blocksSkipped: 0, skipReasons: '{}', tokensUsed: 0, estimatedCost: 0, durationMs: Date.now()-start }
        const outcome = await distillationUsage.run({ pool: store.pool, jobId }, () => replayDistillation(store, jobId!, {
          extract: async (blocks, snapshot) => {
            const { system, user } = buildDistillationPrompt(blocks)
            const response = await recordAiCall('extraction', snapshot.model, () => client.chat.completions.create({
              model: snapshot.model, response_format: { type: 'json_object' }, temperature: snapshot.temperature,
              messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            }))
            const raw = response.choices[0]?.message?.content
            if (!raw) throw new DistillationError('No response from distillation model')
            return parseDistillationResponse(raw)
          },
          prepare: input => pipeline.prepare(input),
        }))
        if (outcome.status === 'success') {
          const result = await distillationRepo.getRunById(jobId)
          if (!result) throw new DistillationError('Completed job log missing')
          return { ...result, runId: result.id, status: 'success', thoughtIds: result.thoughtIds ?? [], skipReasons: result.skipReasons ?? '{}', errorMessage: undefined }
        }
        // An overlapping worker may hold the job. Never report its input as completed.
        const result: DistillationRunResult = { runId: randomUUID(), trigger, status: 'partial', blocksProcessed: 0,
          sessionsProcessed: 0, thoughtsCreated: outcome.saved, thoughtIds: [], blocksSkipped: 0, skipReasons: '{}',
          tokensUsed: 0, estimatedCost: 0, durationMs: Date.now()-start, errorMessage: `Durable job ${jobId}: ${outcome.status}; input retained` }
        // The final atomic job log owns cumulative thought counts and usage.
        // Partial attempts remain visible without counting their saved items twice.
        await distillationRepo.logRun({ ...result, thoughtsCreated: 0 })
        return result
      } catch {
        // Provider errors can include source text or credentials; expose only a stable code.
        throw new DistillationError(`Distillation failed; durable input retained${jobId ? ` (job ${jobId})` : ''}`)
      } finally { running = false }
    },
  }
}
