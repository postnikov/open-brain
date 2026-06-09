import { z } from 'zod'
import { clampFloat, clampInt, json, parseJsonBody, thoughtToJson, UUID_RE, type Route } from '../http.js'

const mergeSchema = z.object({
  keep_id: z.string().regex(UUID_RE),
  remove_id: z.string().regex(UUID_RE),
})

const dismissSchema = z.object({
  id_a: z.string().regex(UUID_RE),
  id_b: z.string().regex(UUID_RE),
})

export const duplicateRoutes: readonly Route[] = [
  {
    method: 'GET',
    pattern: '/api/duplicates',
    handler: async ({ res, url, services }) => {
      const minSimilarity = clampFloat(url.searchParams.get('min_similarity'), 0.92, 0.8, 1)
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 50)
      const pairs = await services.repository.findDuplicates(minSimilarity, limit)

      json(res, {
        pairs: pairs.map((p) => ({
          thought_a: thoughtToJson(p.thoughtA),
          thought_b: thoughtToJson(p.thoughtB),
          similarity: Math.round(p.similarity * 1000) / 1000,
        })),
        total: pairs.length,
      })
    },
  },
  {
    method: 'POST',
    pattern: '/api/duplicates/merge',
    handler: async ({ req, res, services }) => {
      const raw = await parseJsonBody(req)
      const body = mergeSchema.parse(raw)
      const merged = await services.repository.mergeThoughts(body.keep_id, body.remove_id)
      if (!merged) {
        json(res, { error: 'Thoughts not found' }, 404)
        return
      }
      json(res, { merged: thoughtToJson(merged), removed_id: body.remove_id })
    },
  },
  {
    method: 'POST',
    pattern: '/api/duplicates/dismiss',
    handler: async ({ req, res, services }) => {
      const raw = await parseJsonBody(req)
      const body = dismissSchema.parse(raw)
      await services.repository.dismissPair(body.id_a, body.id_b)
      json(res, { dismissed: true })
    },
  },
]
