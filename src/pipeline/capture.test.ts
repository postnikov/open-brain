import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createCapturePipeline } from './capture.js'
import type { ExtractedMetadata } from './metadata.js'
import type { CreateThoughtInput, Thought, ThoughtsRepository } from '../repository/types.js'

const METADATA: ExtractedMetadata = {
  title: 'Auto title',
  content_type: 'note',
  tags: ['auto-tag'],
  topics: ['auto-topic'],
  sentiment: 'neutral',
}

const EMBEDDING = [0.1, 0.2, 0.3]

function thoughtFromInput(input: CreateThoughtInput): Thought {
  return {
    id: 'thought-1',
    content: input.content,
    contentType: input.contentType ?? 'note',
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    title: input.title ?? null,
    tags: input.tags ?? null,
    topics: input.topics ?? null,
    sentiment: input.sentiment ?? null,
    weight: 1,
    compostedAt: null,
    epistemicStatus: null,
    createdAt: new Date(),
    thoughtAt: input.thoughtAt ?? null,
    updatedAt: null,
  }
}

function buildPipeline() {
  const create = vi.fn(async (input: CreateThoughtInput) => thoughtFromInput(input))
  const embed = vi.fn(async () => EMBEDDING)
  const extract = vi.fn(async () => METADATA)
  const pipeline = createCapturePipeline(
    { embed },
    { extract },
    { create } as unknown as ThoughtsRepository,
  )
  return { pipeline, create, embed, extract }
}

describe('createCapturePipeline', () => {
  it('uses manual tags when provided, ignoring auto-extracted ones', async () => {
    const { pipeline, create } = buildPipeline()

    await pipeline.capture({ content: 'hello', source: 'cli', tags: ['manual'] })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ tags: ['manual'] }))
  })

  it('falls back to auto-extracted tags when manual tags are empty', async () => {
    const { pipeline, create } = buildPipeline()

    await pipeline.capture({ content: 'hello', source: 'cli', tags: [] })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ tags: METADATA.tags }))
  })

  it('falls back to auto-extracted content_type when not provided', async () => {
    const { pipeline, create } = buildPipeline()

    await pipeline.capture({ content: 'hello', source: 'cli' })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'note' }))
  })

  it('prefers explicit contentType over auto-extracted', async () => {
    const { pipeline, create } = buildPipeline()

    await pipeline.capture({ content: 'hello', source: 'cli', contentType: 'decision' })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'decision' }))
  })

  it('computes content_hash as sha256 of trimmed content (16 chars)', async () => {
    const { pipeline, create } = buildPipeline()
    const expected = createHash('sha256').update('hello').digest('hex').slice(0, 16)

    await pipeline.capture({ content: '  hello  ', source: 'cli' })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ contentHash: expected }))
    expect(expected).toHaveLength(16)
  })

  it('passes embedding, sourceRef and metadata fields through to the repository', async () => {
    const { pipeline, create } = buildPipeline()

    await pipeline.capture({ content: 'hello', source: 'api', sourceRef: '{"run":"r1"}' })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        embedding: EMBEDDING,
        sourceRef: '{"run":"r1"}',
        title: METADATA.title,
        topics: METADATA.topics,
        sentiment: METADATA.sentiment,
      }),
    )
  })

  it('propagates repository failures', async () => {
    const { pipeline, create } = buildPipeline()
    create.mockRejectedValueOnce(new Error('db down'))

    await expect(pipeline.capture({ content: 'hello', source: 'cli' })).rejects.toThrow('db down')
  })
})
