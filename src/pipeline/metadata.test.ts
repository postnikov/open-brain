import { describe, expect, it } from 'vitest'
import { parseMetadata } from './metadata.js'

const base = { title: 'T', tags: ['a'], topics: ['b'], sentiment: 'neutral' }

describe('metadata parsing', () => {
  it('keeps a valid content type', () => {
    expect(parseMetadata(JSON.stringify({ ...base, content_type: 'decision' })).content_type).toBe('decision')
  })

  it('falls back to thought for a type outside the enum instead of failing the capture', () => {
    for (const type of ['task', 'request', 'recommendation']) {
      expect(parseMetadata(JSON.stringify({ ...base, content_type: type })).content_type).toBe('thought')
    }
  })

  it('still rejects broken metadata otherwise', () => {
    expect(() => parseMetadata(JSON.stringify({ ...base, content_type: 'note', tags: [] }))).toThrow()
    expect(() => parseMetadata('not json')).toThrow()
  })
})
