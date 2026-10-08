import { createHash } from 'node:crypto'
import { z } from 'zod'
import { clampFloat, clampInt, isValidUuid, json, parseJsonBody, thoughtToJson, EPISTEMIC_STATUSES, UUID_RE, type Route } from '../http.js'

const updateThoughtSchema = z.object({
  content: z.string().min(1).max(50000).optional(),
  title: z.string().max(500).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
})

const openSchema = z.object({
  ids: z.array(z.string().regex(UUID_RE)).min(1).max(10),
  recall_id: z.string().regex(UUID_RE).optional(),
})

const weightSchema = z.object({
  direction: z.enum(['fade', 'amplify']),
})

const epistemicStatusSchema = z.object({
  status: z.enum(EPISTEMIC_STATUSES).nullable(),
})

const batchSchema = z.object({
  ids: z.array(z.string().regex(UUID_RE)).min(1).max(200),
  action: z.enum(['delete', 'compost', 'add_tag', 'remove_tag', 'set_status']),
  params: z.object({
    tag: z.string().min(1).max(100).optional(),
    status: z.enum(EPISTEMIC_STATUSES).nullable().optional(),
  }).optional(),
})

export const thoughtRoutes: readonly Route[] = [
  {
    // Two-step recall, step 1: pointers without text (used by the worker recall hook).
    method: 'GET',
    pattern: '/api/recall',
    handler: async ({ res, url, services }) => {
      const query = url.searchParams.get('q')
      if (!query) {
        json(res, { error: 'Missing query parameter "q"' }, 400)
        return
      }
      const limit = url.searchParams.has('limit') ? clampInt(url.searchParams.get('limit'), services.config.memory.recall_limit, 1, 10) : undefined
      const minSimilarity = url.searchParams.has('min_similarity')
        ? clampFloat(url.searchParams.get('min_similarity'), services.config.memory.recall_min_similarity, 0, 1)
        : undefined
      json(res, await services.recallService.recall(query, { limit, minSimilarity, includeInactive: url.searchParams.get('include_inactive') === 'true' }))
    },
  },
  {
    // Step 2: full text for chosen ids; counts the open.
    method: 'POST',
    pattern: '/api/open',
    handler: async ({ req, res, services }) => {
      const body = openSchema.parse(await parseJsonBody(req))
      json(res, await services.recallService.open(body.ids, body.recall_id))
    },
  },
  {
    method: 'GET',
    pattern: '/api/search',
    handler: async ({ res, url, services }) => {
      const query = url.searchParams.get('q')
      if (!query) {
        json(res, { error: 'Missing query parameter "q"' }, 400)
        return
      }

      const limit = clampInt(url.searchParams.get('limit'), 10, 1, 100)
      const minSimilarity = clampFloat(url.searchParams.get('min_similarity'), 0.3, 0, 1)

      const embedding = await services.embeddingService.embed(query)
      const results = await services.repository.search(embedding, limit, minSimilarity)

      json(res, {
        results: results.map((r) => ({
          ...thoughtToJson(r.thought),
          similarity: Math.round(r.similarity * 1000) / 1000,
        })),
        total: results.length,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/recent',
    handler: async ({ res, url, services }) => {
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 200)
      const source = url.searchParams.get('source') ?? undefined
      const epistemicStatus = url.searchParams.get('epistemic_status') ?? undefined

      const results = await services.repository.findRecent(limit, { source, epistemicStatus })

      json(res, {
        thoughts: results.map(thoughtToJson),
        total: results.length,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/stats',
    handler: async ({ res, services }) => {
      const stats = await services.repository.getStats()

      json(res, {
        total: stats.total,
        by_source: Object.fromEntries(stats.bySource),
        by_type: Object.fromEntries(stats.byType),
        last_7_days: stats.last7Days,
        last_30_days: stats.last30Days,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/compost',
    handler: async ({ res, services }) => {
      const composted = await services.repository.findComposted()
      const now = Date.now()

      json(res, {
        thoughts: composted.map((t) => {
          const elapsed = t.compostedAt ? Math.floor((now - t.compostedAt.getTime()) / (1000 * 60 * 60 * 24)) : 0
          return { ...thoughtToJson(t), composted_at: t.compostedAt?.toISOString() ?? null, days_remaining: Math.max(30 - elapsed, 0) }
        }),
        total: composted.length,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/questions',
    handler: async ({ res, url, services }) => {
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
      const questions = await services.repository.findByEpistemicStatus('question', limit)

      json(res, {
        thoughts: questions.map(thoughtToJson),
        total: questions.length,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/review',
    handler: async ({ res, url, services }) => {
      const daysAgo = clampInt(url.searchParams.get('days_ago'), 7, 1, 365)
      const limit = clampInt(url.searchParams.get('limit'), 7, 1, 20)
      const results = await services.repository.findForReview(daysAgo, limit)
      const now = new Date()

      json(res, {
        thoughts: results.map(thoughtToJson),
        total: results.length,
        period: {
          days_ago: daysAgo,
          from: new Date(now.getTime() - (daysAgo + 1) * 86400000).toISOString().split('T')[0],
          to: new Date(now.getTime() - (daysAgo - 1) * 86400000).toISOString().split('T')[0],
        },
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/timeline',
    handler: async ({ res, url, services }) => {
      const query = url.searchParams.get('q')
      if (!query) {
        json(res, { error: 'Missing query parameter "q"' }, 400)
        return
      }
      const limit = clampInt(url.searchParams.get('limit'), 30, 1, 100)
      const minSimilarity = clampFloat(url.searchParams.get('min_similarity'), 0.3, 0, 1)

      const embedding = await services.embeddingService.embed(query)
      const results = await services.repository.searchTimeline(embedding, limit, minSimilarity)

      json(res, {
        results: results.map((r) => ({
          ...thoughtToJson(r.thought),
          similarity: Math.round(r.similarity * 1000) / 1000,
        })),
        total: results.length,
      })
    },
  },
  {
    method: 'POST',
    pattern: '/api/thoughts/batch',
    handler: async ({ req, res, services }) => {
      const raw = await parseJsonBody(req)
      const body = batchSchema.parse(raw)
      const { repository } = services
      let affected = 0

      if (body.action === 'delete') {
        const results = await Promise.all(body.ids.map((id) => repository.deleteById(id)))
        affected = results.filter(Boolean).length
      } else if (body.action === 'compost') {
        const results = await Promise.all(body.ids.map((id) => repository.compost(id)))
        affected = results.filter(Boolean).length
      } else if (body.action === 'add_tag' && body.params?.tag) {
        affected = await repository.addTagToThoughts(body.ids, body.params.tag)
      } else if (body.action === 'remove_tag' && body.params?.tag) {
        const results = await Promise.all(body.ids.map((id) => repository.removeTagFromThought(id, body.params!.tag!)))
        affected = results.filter(Boolean).length
      } else if (body.action === 'set_status' && body.params?.status !== undefined) {
        const results = await Promise.all(body.ids.map((id) => repository.update(id, { epistemicStatus: body.params!.status })))
        affected = results.filter(Boolean).length
      }

      json(res, { affected, action: body.action })
    },
  },
  {
    method: 'PATCH',
    pattern: '/api/thoughts/:id/weight',
    handler: async ({ req, res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const existing = await services.repository.findById(id)
      if (!existing) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      const raw = await parseJsonBody(req)
      const body = weightSchema.parse(raw)
      const currentWeight = existing.weight
      const newWeight = body.direction === 'fade'
        ? Math.max(currentWeight * 0.5, 0.1)
        : Math.min(currentWeight * 2.0, 10.0)

      await services.repository.update(id, { weight: Math.round(newWeight * 100) / 100 })
      json(res, { id, weight: Math.round(newWeight * 100) / 100, direction: body.direction })
    },
  },
  {
    method: 'PATCH',
    pattern: '/api/thoughts/:id/status',
    handler: async ({ req, res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const existing = await services.repository.findById(id)
      if (!existing) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      const raw = await parseJsonBody(req)
      const body = epistemicStatusSchema.parse(raw)
      await services.repository.update(id, { epistemicStatus: body.status })
      json(res, { id, epistemic_status: body.status })
    },
  },
  {
    method: 'POST',
    pattern: '/api/thoughts/:id/compost',
    handler: async ({ res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const composted = await services.repository.compost(id)
      if (!composted) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      json(res, { id, composted_at: composted.compostedAt?.toISOString() ?? null })
    },
  },
  {
    method: 'POST',
    pattern: '/api/thoughts/:id/restore',
    handler: async ({ res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const restored = await services.repository.uncompost(id)
      if (!restored) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      json(res, { id, restored: true })
    },
  },
  {
    // Undo a replacement mark (merge, edit or explicit supersede); the newer thought stays.
    method: 'POST',
    pattern: '/api/thoughts/:id/unsupersede',
    handler: async ({ res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const restored = await services.repository.unsupersede(id)
      if (!restored) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      json(res, { id, restored: true })
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/thoughts/:id',
    handler: async ({ res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const existing = await services.repository.findById(id)
      if (!existing) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      const deleted = await services.repository.deleteById(id)
      json(res, { deleted, id })
    },
  },
  {
    method: 'PUT',
    pattern: '/api/thoughts/:id',
    handler: async ({ req, res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const existing = await services.repository.findById(id)
      if (!existing) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      const raw = await parseJsonBody(req)
      const body = updateThoughtSchema.parse(raw)

      if (!body.content && !body.title && !body.tags) {
        json(res, { error: 'No fields to update (provide content, title, or tags)' }, 400)
        return
      }

      // Nothing is overwritten: new text becomes a new version that supersedes this one.
      if (body.content && body.content !== existing.content) {
        if (existing.supersededBy) {
          json(res, { error: `Thought is superseded by ${existing.supersededBy}; edit the newer version` }, 409)
          return
        }
        const embedding = await services.embeddingService.embed(body.content)
        const version = await services.repository.createSuperseding({
          content: body.content,
          source: existing.source,
          sourceRef: existing.sourceRef ?? `unattributed:${existing.source}`,
          contentType: existing.contentType,
          title: body.title ?? existing.title ?? undefined,
          tags: body.tags ?? existing.tags ?? undefined,
          topics: existing.topics ?? undefined,
          sentiment: existing.sentiment ?? undefined,
          embedding,
          thoughtAt: existing.thoughtAt ?? undefined,
          contentHash: createHash('sha256').update(body.content.trim()).digest('hex').slice(0, 16),
          validTo: existing.validTo ?? undefined,
        }, { supersedes: id, reason: 'edited in UI' })
        json(res, {
          ...thoughtToJson(version),
          updated_at: version.updatedAt?.toISOString() ?? null,
          re_embedded: true,
          previous_id: id,
        })
        return
      }

      const updated = await services.repository.update(id, {
        title: body.title,
        tags: body.tags,
      })

      if (!updated) {
        json(res, { error: 'Update failed' }, 500)
        return
      }

      json(res, {
        ...thoughtToJson(updated),
        updated_at: updated.updatedAt?.toISOString() ?? null,
        re_embedded: false,
      })
    },
  },
]
