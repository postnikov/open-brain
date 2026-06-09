import { describe, expect, it, vi } from 'vitest'
import { createDistillationService } from './service.js'
import { DistillationError } from '../shared/errors.js'
import type { DistillationRepository, DistillationRunResult } from './types.js'
import type { StreamBlock, StreamRepository } from '../stream/types.js'
import type { CapturePipeline } from '../pipeline/capture.js'
import type { Thought } from '../repository/types.js'

const { completionsCreate } = vi.hoisted(() => ({ completionsCreate: vi.fn() }))

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: completionsCreate } }
  },
}))

const CONFIG = {
  model: 'gpt-4o-mini',
  temperature: 0.3,
  maxBlocksPerRun: 50,
  minBlockLength: 20,
}

const SAVED_THOUGHT: Thought = {
  id: 'saved-1',
  content: 'extracted',
  contentType: 'insight',
  source: 'distillation',
  sourceRef: null,
  title: null,
  tags: ['distilled'],
  topics: null,
  sentiment: null,
  weight: 1,
  compostedAt: null,
  epistemicStatus: null,
  createdAt: new Date(),
  thoughtAt: null,
  updatedAt: null,
}

function makeBlock(overrides: Partial<StreamBlock> = {}): StreamBlock {
  return {
    id: 'block-1',
    sessionId: 'session-1',
    blockNumber: 0,
    topic: null,
    content: 'A sufficiently long stream block content for distillation.',
    participants: null,
    sourceClient: null,
    pinned: false,
    distilledAt: null,
    distillationRunId: null,
    createdAt: new Date(),
    expiresAt: null,
    ...overrides,
  }
}

function llmResponse(thoughts: unknown[], usage = { total_tokens: 1000, prompt_tokens: 800, completion_tokens: 200 }) {
  return {
    choices: [{ message: { content: JSON.stringify({ thoughts }) } }],
    usage,
  }
}

function buildService(blocks: readonly StreamBlock[]) {
  const findPendingForDistillation = vi.fn(async () => blocks)
  const markDistilled = vi.fn(async (ids: readonly string[]) => ids.length)
  const streamRepo = { findPendingForDistillation, markDistilled } as unknown as StreamRepository

  const logRun = vi.fn(async (result: DistillationRunResult) => result.runId)
  const distillationRepo = { logRun } as unknown as DistillationRepository

  const capture = vi.fn(async () => ({ thought: SAVED_THOUGHT }))
  const pipeline = { capture } as unknown as CapturePipeline

  const service = createDistillationService(streamRepo, pipeline, distillationRepo, CONFIG, 'test-key')
  return { service, findPendingForDistillation, markDistilled, logRun, capture }
}

describe('createDistillationService', () => {
  it('returns an empty success run when there are no pending blocks', async () => {
    const { service, logRun, markDistilled } = buildService([])

    const result = await service.run('manual')

    expect(result.status).toBe('success')
    expect(result.blocksProcessed).toBe(0)
    expect(result.thoughtsCreated).toBe(0)
    expect(completionsCreate).not.toHaveBeenCalled()
    expect(markDistilled).not.toHaveBeenCalled()
    expect(logRun).toHaveBeenCalledOnce()
  })

  it('skips blocks below min_block_length without calling the LLM, but still marks them distilled', async () => {
    completionsCreate.mockClear()
    const short = [makeBlock({ id: 'b1', content: 'too short' }), makeBlock({ id: 'b2', content: 'also tiny' })]
    const { service, markDistilled } = buildService(short)

    const result = await service.run('manual')

    expect(completionsCreate).not.toHaveBeenCalled()
    expect(result.status).toBe('success')
    expect(result.blocksProcessed).toBe(0)
    expect(result.blocksSkipped).toBe(2)
    expect(result.skipReasons).toBe(JSON.stringify({ too_short: 2 }))
    expect(markDistilled).toHaveBeenCalledWith(['b1', 'b2'], result.runId)
  })

  it('distills qualified blocks into thoughts with sourceRef back-links', async () => {
    completionsCreate.mockClear()
    completionsCreate.mockResolvedValueOnce(
      llmResponse([{ content: 'An extracted insight', content_type: 'insight', tags: ['ai'] }]),
    )
    const blocks = [
      makeBlock({ id: 'b1', sessionId: 's1' }),
      makeBlock({ id: 'b2', sessionId: 's2', blockNumber: 1 }),
    ]
    const { service, capture, markDistilled, logRun } = buildService(blocks)

    const result = await service.run('cron')

    expect(completionsCreate).toHaveBeenCalledWith(expect.objectContaining({ model: CONFIG.model, temperature: CONFIG.temperature }))
    expect(result.status).toBe('success')
    expect(result.blocksProcessed).toBe(2)
    expect(result.sessionsProcessed).toBe(2)
    expect(result.thoughtsCreated).toBe(1)
    expect(result.thoughtIds).toEqual([SAVED_THOUGHT.id])
    expect(result.tokensUsed).toBe(1000)
    expect(result.estimatedCost).toBeCloseTo(800 * 0.00000015 + 200 * 0.0000006, 6)

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'An extracted insight',
        source: 'distillation',
        contentType: 'insight',
        tags: ['ai', 'distilled'],
        sourceRef: JSON.stringify({
          session_ids: ['s1', 's2'],
          block_ids: ['b1', 'b2'],
          distillation_run_id: result.runId,
        }),
      }),
    )
    expect(markDistilled).toHaveBeenCalledWith(['b1', 'b2'], result.runId)
    expect(logRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
  })

  it('returns partial status when the LLM yields no thoughts for qualified blocks', async () => {
    completionsCreate.mockClear()
    completionsCreate.mockResolvedValueOnce(llmResponse([]))
    const { service } = buildService([makeBlock()])

    const result = await service.run('manual')

    expect(result.status).toBe('partial')
    expect(result.thoughtsCreated).toBe(0)
  })

  it('continues past individual capture failures and reports partial status', async () => {
    completionsCreate.mockClear()
    completionsCreate.mockResolvedValueOnce(
      llmResponse([
        { content: 'First thought', content_type: 'insight' },
        { content: 'Second thought', content_type: 'decision' },
      ]),
    )
    const { service, capture } = buildService([makeBlock()])
    capture.mockRejectedValue(new Error('embedding api down'))

    const result = await service.run('manual')

    expect(capture).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('partial')
    expect(result.thoughtsCreated).toBe(0)
  })

  it('logs an error run and throws DistillationError when the LLM call fails', async () => {
    completionsCreate.mockClear()
    completionsCreate.mockRejectedValueOnce(new Error('429 quota exceeded'))
    const { service, logRun, markDistilled } = buildService([makeBlock()])

    await expect(service.run('cron')).rejects.toThrow(DistillationError)

    expect(logRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', errorMessage: '429 quota exceeded' }),
    )
    expect(markDistilled).not.toHaveBeenCalled()
    expect(service.isRunning()).toBe(false)
  })

  it('rejects a second run while one is in flight', async () => {
    completionsCreate.mockClear()
    let release!: (blocks: readonly StreamBlock[]) => void
    const gate = new Promise<readonly StreamBlock[]>((resolve) => {
      release = resolve
    })
    const { service, findPendingForDistillation } = buildService([])
    findPendingForDistillation.mockReturnValueOnce(gate)

    const first = service.run('manual')
    expect(service.isRunning()).toBe(true)

    await expect(service.run('manual')).rejects.toThrow('already running')

    release([])
    await first
    expect(service.isRunning()).toBe(false)
  })
})
