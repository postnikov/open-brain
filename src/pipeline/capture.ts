import type { EmbeddingService } from './embeddings.js'
import type { MetadataService } from './metadata.js'
import type { ThoughtsRepository } from '../repository/types.js'
import type { Thought } from '../repository/types.js'
import { logger } from '../shared/logger.js'

export interface CaptureInput {
  readonly content: string
  readonly source: string
  readonly contentType?: string
  readonly tags?: readonly string[]
  readonly thoughtAt?: Date
}

export interface CaptureResult {
  readonly thought: Thought
}

export interface CapturePipeline {
  readonly capture: (input: CaptureInput) => Promise<CaptureResult>
}

export function createCapturePipeline(
  embeddingService: EmbeddingService,
  metadataService: MetadataService,
  repository: ThoughtsRepository,
): CapturePipeline {
  return {
    async capture(input: CaptureInput): Promise<CaptureResult> {
      logger.info({ source: input.source, contentLength: input.content.length }, 'Capturing thought')

      const [embedding, metadata] = await Promise.all([
        embeddingService.embed(input.content),
        metadataService.extract(input.content),
      ])

      const thought = await repository.create({
        content: input.content,
        source: input.source,
        contentType: input.contentType ?? metadata.content_type,
        title: metadata.title,
        tags: input.tags && input.tags.length > 0 ? input.tags : metadata.tags,
        topics: metadata.topics,
        sentiment: metadata.sentiment,
        embedding,
        thoughtAt: input.thoughtAt,
      })

      logger.info({ id: thought.id, title: thought.title }, 'Thought captured')
      return { thought }
    },
  }
}
