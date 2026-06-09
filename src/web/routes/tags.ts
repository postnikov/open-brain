import { z } from 'zod'
import { isValidUuid, json, parseJsonBody, type Route } from '../http.js'

const renameTagSchema = z.object({
  old_tag: z.string().min(1).max(100),
  new_tag: z.string().min(1).max(100),
})

export const tagRoutes: readonly Route[] = [
  {
    method: 'GET',
    pattern: '/api/tags',
    handler: async ({ res, services }) => {
      const tags = await services.repository.listTags()

      json(res, {
        tags: Array.from(tags.entries()).map(([tag, count]) => ({ tag, count })),
        total_unique: tags.size,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/tags/orphans',
    handler: async ({ res, services }) => {
      const orphans = await services.repository.findOrphanTags()

      json(res, {
        orphans: orphans.map(({ tag, thought }) => ({
          tag,
          thought: { id: thought.id, title: thought.title, content: thought.content, source: thought.source, created_at: thought.createdAt?.toISOString() ?? null },
        })),
        total: orphans.length,
      })
    },
  },
  {
    method: 'PUT',
    pattern: '/api/tags/rename',
    handler: async ({ req, res, services }) => {
      const raw = await parseJsonBody(req)
      const body = renameTagSchema.parse(raw)
      const affected = await services.repository.renameTag(body.old_tag, body.new_tag)
      json(res, { renamed: body.old_tag, to: body.new_tag, thoughts_affected: affected })
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/tags/:tag/from/:thoughtId',
    handler: async ({ res, params, services }) => {
      const { tag, thoughtId } = params
      if (!tag || !thoughtId || !isValidUuid(thoughtId)) {
        json(res, { error: 'Missing or invalid tag/thoughtId' }, 400)
        return
      }
      const decodedTag = decodeURIComponent(tag)
      const removed = await services.repository.removeTagFromThought(thoughtId, decodedTag)
      if (!removed) {
        json(res, { error: 'Tag not found on thought' }, 404)
        return
      }
      json(res, { removed: true, tag: decodedTag, thoughtId })
    },
  },
]
