import OpenAI from 'openai'
import { z } from 'zod'
import { logger } from '../shared/logger.js'
import { MetadataExtractionError } from '../shared/errors.js'

const metadataSchema = z.object({
  title: z.string(),
  content_type: z.enum(['thought', 'note', 'idea', 'question', 'observation', 'decision']),
  tags: z.array(z.string()).min(1).max(7),
  topics: z.array(z.string()).min(1).max(3),
  sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
})

export type ExtractedMetadata = z.infer<typeof metadataSchema>

export interface MetadataService {
  readonly extract: (content: string) => Promise<ExtractedMetadata>
}

const SYSTEM_PROMPT = `You extract metadata from thoughts and notes. Return valid JSON only.`

const USER_PROMPT_TEMPLATE = `Extract metadata from this thought/note:

"""
{content}
"""

Return JSON:
{
  "title": "short descriptive title, 5-10 words",
  "content_type": "thought|note|idea|question|observation|decision",
  "tags": ["tag1", "tag2"],
  "topics": ["topic1", "topic2"],
  "sentiment": "positive|negative|neutral|mixed"
}

Rules:
- title: concise, descriptive, 5-10 words
- tags: 2-5 relevant tags, lowercase
- topics: 1-3 broader categories
- content_type: choose the most fitting type
- sentiment: overall emotional tone`

export function createMetadataService(apiKey: string, model: string): MetadataService {
  const client = new OpenAI({ apiKey })

  return {
    async extract(content: string): Promise<ExtractedMetadata> {
      try {
        const response = await client.chat.completions.create({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: USER_PROMPT_TEMPLATE.replace('{content}', content) },
          ],
          temperature: 0.3,
          max_tokens: 300,
        })

        const raw = response.choices[0]?.message?.content
        if (!raw) {
          throw new MetadataExtractionError('No response from metadata model')
        }

        const parsed = JSON.parse(raw)
        const validated = metadataSchema.parse(parsed)

        logger.debug({ title: validated.title, tags: validated.tags }, 'Metadata extracted')
        return validated
      } catch (error) {
        if (error instanceof MetadataExtractionError) throw error
        throw new MetadataExtractionError('Failed to extract metadata', error)
      }
    },
  }
}
