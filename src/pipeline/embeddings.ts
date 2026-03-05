import OpenAI from 'openai'
import { logger } from '../shared/logger.js'
import { EmbeddingError } from '../shared/errors.js'

export interface EmbeddingService {
  readonly embed: (text: string) => Promise<readonly number[]>
}

export function createEmbeddingService(apiKey: string, model: string): EmbeddingService {
  const client = new OpenAI({ apiKey })

  return {
    async embed(text: string): Promise<readonly number[]> {
      try {
        const response = await client.embeddings.create({
          model,
          input: text,
        })

        const embedding = response.data[0]?.embedding
        if (!embedding) {
          throw new EmbeddingError('No embedding returned from OpenAI')
        }

        logger.debug({ model, dimensions: embedding.length }, 'Embedding generated')
        return embedding
      } catch (error) {
        if (error instanceof EmbeddingError) throw error
        throw new EmbeddingError('Failed to generate embedding', error)
      }
    },
  }
}
