import { z } from 'zod'
import type { StreamBlock } from '../stream/types.js'
import { DistillationError } from '../shared/errors.js'

const extractedThoughtSchema = z.object({
  content: z.string().min(1),
  content_type: z.enum(['decision', 'insight', 'question', 'formulation', 'contradiction']),
  tags: z.array(z.string()).max(7).optional(),
})

export const distillationResponseSchema = z.object({
  thoughts: z.array(extractedThoughtSchema),
})

export type DistillationResponse = z.infer<typeof distillationResponseSchema>

const SYSTEM_PROMPT = `You extract significant thoughts from raw conversation stream blocks. Your job is to identify decisions, insights, open questions, precise formulations, and contradictions worth preserving.

Rules:
- Only extract genuinely significant thoughts — skip small talk, logistics, and repetitive content
- Each thought must be self-contained and understandable without the original conversation context
- Write thoughts in the same language as the source content
- Prefer the user's own words and formulations when possible
- If a block contains nothing worth extracting, return an empty thoughts array
- Tags should be lowercase, 2-5 per thought
- content_type: decision (chosen course of action), insight (new understanding), question (open question to revisit), formulation (precise wording or metaphor), contradiction (changed position)

Return valid JSON only.`

const USER_PROMPT_TEMPLATE = `Extract significant thoughts from these conversation stream blocks:

{blocks}

Return JSON:
{
  "thoughts": [
    {
      "content": "the extracted thought, self-contained",
      "content_type": "decision|insight|question|formulation|contradiction",
      "tags": ["tag1", "tag2"]
    }
  ]
}`

export function buildDistillationPrompt(blocks: readonly StreamBlock[]): { system: string; user: string } {
  const grouped = new Map<string, StreamBlock[]>()
  for (const block of blocks) {
    const existing = grouped.get(block.sessionId) ?? []
    grouped.set(block.sessionId, [...existing, block])
  }

  const formatted = Array.from(grouped.entries())
    .map(([sessionId, sessionBlocks]) => {
      const header = `--- Session: ${sessionId} ---`
      const body = sessionBlocks
        .map((b) => {
          const topicLine = b.topic ? `[Topic: ${b.topic}]` : ''
          return `Block #${b.blockNumber} ${topicLine}\n${b.content}`
        })
        .join('\n\n')
      return `${header}\n${body}`
    })
    .join('\n\n')

  return {
    system: SYSTEM_PROMPT,
    user: USER_PROMPT_TEMPLATE.replace('{blocks}', formatted),
  }
}

export function parseDistillationResponse(raw: string): DistillationResponse {
  try {
    const parsed = JSON.parse(raw)
    return distillationResponseSchema.parse(parsed)
  } catch (error) {
    throw new DistillationError('Failed to parse distillation response', error)
  }
}
