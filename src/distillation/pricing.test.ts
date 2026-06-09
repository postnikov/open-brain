import { describe, expect, it } from 'vitest'
import { estimateCost } from './pricing.js'

describe('estimateCost', () => {
  it('computes cost for a known model', () => {
    expect(estimateCost('gpt-4o-mini', 800, 200)).toBeCloseTo((800 * 0.15 + 200 * 0.6) / 1_000_000, 10)
  })

  it('resolves dated model variants by longest prefix', () => {
    expect(estimateCost('gpt-4o-mini-2024-07-18', 1000, 0)).toBeCloseTo((1000 * 0.15) / 1_000_000, 10)
    expect(estimateCost('gpt-4o-2024-08-06', 1000, 0)).toBeCloseTo((1000 * 2.5) / 1_000_000, 10)
  })

  it('does not confuse gpt-4.1 with gpt-4.1-mini', () => {
    expect(estimateCost('gpt-4.1-mini', 1000, 0)).toBeCloseTo((1000 * 0.4) / 1_000_000, 10)
    expect(estimateCost('gpt-4.1', 1000, 0)).toBeCloseTo((1000 * 2) / 1_000_000, 10)
  })

  it('returns 0 for unknown models', () => {
    expect(estimateCost('claude-fable-5', 1000, 1000)).toBe(0)
  })

  it('returns 0 cost for zero tokens', () => {
    expect(estimateCost('gpt-4o-mini', 0, 0)).toBe(0)
  })
})
