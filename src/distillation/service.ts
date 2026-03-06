import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { logger } from '../shared/logger.js'
import { DistillationError } from '../shared/errors.js'
import { buildDistillationPrompt, parseDistillationResponse } from './prompt.js'
import type { StreamRepository } from '../stream/types.js'
import type { CapturePipeline } from '../pipeline/capture.js'
import type { DistillationRepository, DistillationRunResult, DistillationService } from './types.js'

interface DistillationServiceConfig {
  readonly model: string
  readonly temperature: number
  readonly maxBlocksPerRun: number
  readonly minBlockLength: number
}

export function createDistillationService(
  streamRepo: StreamRepository,
  pipeline: CapturePipeline,
  distillationRepo: DistillationRepository,
  config: DistillationServiceConfig,
  apiKey: string,
): DistillationService {
  let running = false
  const client = new OpenAI({ apiKey })

  return {
    isRunning: () => running,

    async run(trigger: string): Promise<DistillationRunResult> {
      if (running) {
        throw new DistillationError('Distillation is already running')
      }

      running = true
      const runId = randomUUID()
      const startTime = Date.now()

      try {
        logger.info({ runId, trigger }, 'Starting distillation run')

        const pendingBlocks = await streamRepo.findPendingForDistillation(config.maxBlocksPerRun)

        if (pendingBlocks.length === 0) {
          const result: DistillationRunResult = {
            runId,
            trigger,
            status: 'success',
            blocksProcessed: 0,
            sessionsProcessed: 0,
            thoughtsCreated: 0,
            thoughtIds: [],
            blocksSkipped: 0,
            skipReasons: '{}',
            tokensUsed: 0,
            estimatedCost: 0,
            durationMs: Date.now() - startTime,
          }
          await distillationRepo.logRun(result)
          logger.info({ runId }, 'No pending blocks to distill')
          return result
        }

        const qualifiedBlocks = pendingBlocks.filter((b) => b.content.length >= config.minBlockLength)
        const skippedBlocks = pendingBlocks.filter((b) => b.content.length < config.minBlockLength)

        const sessionIds = new Set(qualifiedBlocks.map((b) => b.sessionId))

        let thoughts: { content: string; contentType: string; tags?: readonly string[] }[] = []
        let tokensUsed = 0
        let estimatedCost = 0

        if (qualifiedBlocks.length > 0) {
          const { system, user } = buildDistillationPrompt(qualifiedBlocks)

          const response = await client.chat.completions.create({
            model: config.model,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: config.temperature,
          })

          const raw = response.choices[0]?.message?.content
          if (!raw) {
            throw new DistillationError('No response from distillation model')
          }

          tokensUsed = (response.usage?.total_tokens ?? 0)
          // gpt-4o-mini pricing: $0.15/1M input, $0.60/1M output
          const inputTokens = response.usage?.prompt_tokens ?? 0
          const outputTokens = response.usage?.completion_tokens ?? 0
          estimatedCost = (inputTokens * 0.00000015) + (outputTokens * 0.0000006)

          const parsed = parseDistillationResponse(raw)
          thoughts = parsed.thoughts.map((t) => ({
            content: t.content,
            contentType: t.content_type,
            tags: t.tags,
          }))
        }

        const blockIds = qualifiedBlocks.map((b) => b.id)
        const sourceRef = JSON.stringify({
          session_ids: [...sessionIds],
          block_ids: blockIds,
          distillation_run_id: runId,
        })

        const thoughtIds: string[] = []
        for (const thought of thoughts) {
          try {
            const { thought: saved } = await pipeline.capture({
              content: thought.content,
              source: 'distillation',
              contentType: thought.contentType,
              tags: thought.tags ? [...thought.tags, 'distilled'] : ['distilled'],
              sourceRef,
            })
            thoughtIds.push(saved.id)
          } catch (error) {
            logger.error({ err: error, content: thought.content.slice(0, 100) }, 'Failed to capture distilled thought')
          }
        }

        const allBlockIds = pendingBlocks.map((b) => b.id)
        if (allBlockIds.length > 0) {
          await streamRepo.markDistilled(allBlockIds, runId)
        }

        const result: DistillationRunResult = {
          runId,
          trigger,
          status: thoughtIds.length > 0 || qualifiedBlocks.length === 0 ? 'success' : 'partial',
          blocksProcessed: qualifiedBlocks.length,
          sessionsProcessed: sessionIds.size,
          thoughtsCreated: thoughtIds.length,
          thoughtIds,
          blocksSkipped: skippedBlocks.length,
          skipReasons: JSON.stringify({ too_short: skippedBlocks.length }),
          tokensUsed,
          estimatedCost: Math.round(estimatedCost * 1000000) / 1000000,
          durationMs: Date.now() - startTime,
        }

        await distillationRepo.logRun(result)
        logger.info({
          runId,
          blocksProcessed: result.blocksProcessed,
          thoughtsCreated: result.thoughtsCreated,
          durationMs: result.durationMs,
        }, 'Distillation run complete')

        return result
      } catch (error) {
        const durationMs = Date.now() - startTime
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'

        const result: DistillationRunResult = {
          runId,
          trigger,
          status: 'error',
          blocksProcessed: 0,
          sessionsProcessed: 0,
          thoughtsCreated: 0,
          thoughtIds: [],
          blocksSkipped: 0,
          skipReasons: '{}',
          tokensUsed: 0,
          estimatedCost: 0,
          durationMs,
          errorMessage,
        }

        try {
          await distillationRepo.logRun(result)
        } catch (logError) {
          logger.error({ err: logError }, 'Failed to log distillation error')
        }

        logger.error({ err: error, runId }, 'Distillation run failed')

        if (error instanceof DistillationError) throw error
        throw new DistillationError('Distillation run failed', error)
      } finally {
        running = false
      }
    },
  }
}
