import { z } from 'zod'
import { clampInt, isValidUuid, json, parseJsonBody, type Route } from '../http.js'

const streamWriteSchema = z.object({
  session_id: z.string().min(1).max(255),
  block_number: z.number().int().min(0),
  topic: z.string().max(500).optional(),
  content: z.string().min(1).max(102400),
  participants: z.array(z.string().max(100)).max(20).optional(),
  source_client: z.string().max(100).optional(),
})

const streamPinSchema = z.object({
  pinned: z.boolean(),
})

export const streamRoutes: readonly Route[] = [
  {
    method: 'GET',
    pattern: '/api/stream',
    handler: async ({ res, url, services }) => {
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
      const sessionId = url.searchParams.get('session_id') ?? undefined
      const status = url.searchParams.get('status') as 'pending' | 'distilled' | 'pinned' | undefined
      const search = url.searchParams.get('search') ?? undefined

      const blocks = await services.streamRepository.findRecent(limit, { sessionId, status, search })

      json(res, {
        blocks: blocks.map((b) => ({
          id: b.id,
          session_id: b.sessionId,
          block_number: b.blockNumber,
          topic: b.topic,
          content: b.content,
          participants: b.participants,
          source_client: b.sourceClient,
          pinned: b.pinned,
          distilled: b.distilledAt !== null,
          distillation_run_id: b.distillationRunId,
          created_at: b.createdAt?.toISOString() ?? null,
          expires_at: b.expiresAt?.toISOString() ?? null,
        })),
        total: blocks.length,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/stream/sessions',
    handler: async ({ res, url, services }) => {
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
      const sessions = await services.streamRepository.listSessions(limit)

      json(res, {
        sessions: sessions.map((s) => ({
          session_id: s.sessionId,
          block_count: s.blockCount,
          first_block: s.firstBlock?.toISOString() ?? null,
          last_block: s.lastBlock?.toISOString() ?? null,
          topic: s.topic,
          source_client: s.sourceClient,
        })),
        total: sessions.length,
      })
    },
  },
  {
    method: 'GET',
    pattern: '/api/stream/stats',
    handler: async ({ res, services }) => {
      const stats = await services.streamRepository.getStats()

      json(res, {
        total_blocks: stats.totalBlocks,
        total_sessions: stats.totalSessions,
        pending_blocks: stats.pendingBlocks,
        distilled_blocks: stats.distilledBlocks,
        pinned_blocks: stats.pinnedBlocks,
      })
    },
  },
  {
    method: 'POST',
    pattern: '/api/stream',
    handler: async ({ req, res, services }) => {
      const raw = await parseJsonBody(req)
      const body = streamWriteSchema.parse(raw)
      const block = await services.streamRepository.write({
        sessionId: body.session_id,
        blockNumber: body.block_number,
        topic: body.topic,
        content: body.content,
        participants: body.participants,
        sourceClient: body.source_client,
      }, 0)

      json(res, {
        id: block.id,
        session_id: block.sessionId,
        block_number: block.blockNumber,
        created_at: block.createdAt?.toISOString() ?? null,
        expires_at: block.expiresAt?.toISOString() ?? null,
      }, 201)
    },
  },
  {
    method: 'PATCH',
    pattern: '/api/stream/:id/pin',
    handler: async ({ req, res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid stream block ID' }, 400)
        return
      }
      const raw = await parseJsonBody(req)
      const body = streamPinSchema.parse(raw)
      const updated = body.pinned
        ? await services.streamRepository.pin(id)
        : await services.streamRepository.unpin(id)
      if (!updated) {
        json(res, { error: 'Stream block not found' }, 404)
        return
      }
      json(res, {
        id: updated.id,
        pinned: updated.pinned,
        expires_at: updated.expiresAt?.toISOString() ?? null,
      })
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/stream/:id',
    handler: async ({ res, params, services }) => {
      const { id } = params
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid stream block ID' }, 400)
        return
      }
      const deleted = await services.streamRepository.deleteById(id)
      if (!deleted) {
        json(res, { error: 'Stream block not found' }, 404)
        return
      }
      json(res, { deleted: true, id })
    },
  },
]
