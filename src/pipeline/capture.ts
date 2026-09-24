import { createHash } from 'node:crypto'
import type { EmbeddingService } from './embeddings.js'
import type { MetadataService } from './metadata.js'
import type { CreateThoughtInput, ThoughtsRepository } from '../repository/types.js'
import type { Thought } from '../repository/types.js'
import { logger } from '../shared/logger.js'

function contentHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex').slice(0, 16)
}

export interface CaptureInput {
  readonly content: string
  readonly source: string
  readonly contentType?: string
  readonly tags?: readonly string[]
  readonly thoughtAt?: Date
  readonly sourceRef?: string
}

export interface CaptureResult {
  readonly thought: Thought
}

export interface CapturePipeline {
  readonly prepare: (input: CaptureInput) => Promise<CreateThoughtInput>
  readonly capture: (input: CaptureInput) => Promise<CaptureResult>
}

export function createCapturePipeline(
  embeddingService: EmbeddingService,
  metadataService: MetadataService,
  repository: ThoughtsRepository,
): CapturePipeline {
  async function prepare(input: CaptureInput): Promise<CreateThoughtInput> {
    const [embedding, metadata] = await Promise.all([
      embeddingService.embed(input.content),
      metadataService.extract(input.content),
    ])
    return {
      content: input.content,
      source: input.source,
      contentType: input.contentType ?? metadata.content_type,
      title: metadata.title,
      tags: input.tags && input.tags.length > 0 ? input.tags : metadata.tags,
      topics: metadata.topics,
      sentiment: metadata.sentiment,
      embedding,
      thoughtAt: input.thoughtAt,
      contentHash: contentHash(input.content),
      sourceRef: input.sourceRef,
    }
  }
  return {
    prepare,
    async capture(input: CaptureInput): Promise<CaptureResult> {
      logger.info({ source: input.source, contentLength: input.content.length }, 'Capturing thought')
      const thought = await repository.create(await prepare(input))

      logger.info({ id: thought.id, title: thought.title }, 'Thought captured')
      return { thought }
    },
  }
}
