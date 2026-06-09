import { logger } from '../shared/logger.js'

// USD per 1M tokens
const MODEL_PRICING: Record<string, { readonly input: number; readonly output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Longest prefix match so dated variants (gpt-4o-mini-2024-07-18) resolve correctly
  const match = Object.entries(MODEL_PRICING)
    .filter(([key]) => model === key || model.startsWith(`${key}-`))
    .sort(([a], [b]) => b.length - a.length)[0]

  if (!match) {
    logger.warn({ model }, 'No pricing data for model, estimated cost will be 0')
    return 0
  }

  const [, pricing] = match
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
}
