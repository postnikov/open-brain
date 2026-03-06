import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { AppServices } from '../bootstrap.js'
import { logger } from '../shared/logger.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const EPISTEMIC_STATUSES = ['hypothesis', 'conviction', 'fact', 'outdated', 'question'] as const

const updateThoughtSchema = z.object({
  content: z.string().min(1).max(50000).optional(),
  title: z.string().max(500).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
})

const renameTagSchema = z.object({
  old_tag: z.string().min(1).max(100),
  new_tag: z.string().min(1).max(100),
})

const weightSchema = z.object({
  direction: z.enum(['fade', 'amplify']),
})

const epistemicStatusSchema = z.object({
  status: z.enum(EPISTEMIC_STATUSES).nullable(),
})

const mergeSchema = z.object({
  keep_id: z.string().regex(UUID_RE),
  remove_id: z.string().regex(UUID_RE),
})

const dismissSchema = z.object({
  id_a: z.string().regex(UUID_RE),
  id_b: z.string().regex(UUID_RE),
})

const batchSchema = z.object({
  ids: z.array(z.string().regex(UUID_RE)).min(1).max(200),
  action: z.enum(['delete', 'compost', 'add_tag', 'remove_tag', 'set_status']),
  params: z.object({
    tag: z.string().min(1).max(100).optional(),
    status: z.enum(EPISTEMIC_STATUSES).nullable().optional(),
  }).optional(),
})

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

const importFilesSchema = z.object({
  files: z.array(z.object({
    name: z.string().min(1).max(500),
    content: z.string().min(1).max(102400),
    tags: z.array(z.string().max(100)).max(20).optional(),
  })).min(1).max(50),
  source: z.string().max(50).default('upload'),
})

const obsidianScanSchema = z.object({
  path: z.string().min(1).max(1000),
})

const obsidianStartSchema = z.object({
  path: z.string().min(1).max(1000),
  files: z.array(z.string().min(1).max(500)).min(1).max(500),
})

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(data))
}

async function parseJsonBody(req: IncomingMessage, maxSize = 1024 * 64): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let destroyed = false

    req.on('data', (chunk: Buffer) => {
      if (destroyed) return
      size += chunk.length
      if (size > maxSize) {
        destroyed = true
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (destroyed) return
      try {
        const body = Buffer.concat(chunks).toString('utf-8')
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })

    req.on('error', reject)
  })
}

function matchPath(pathname: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split('/')
  const pathParts = pathname.split('/')
  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const pat = patternParts[i]
    const val = pathParts[i]
    if (pat && pat.startsWith(':')) {
      params[pat.slice(1)] = val ?? ''
    } else if (pat !== val) {
      return null
    }
  }
  return params
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = parseInt(raw ?? '', 10)
  return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, min), max)
}

function clampFloat(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = parseFloat(raw ?? '')
  return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, min), max)
}

function isValidUuid(id: string): boolean {
  return UUID_RE.test(id)
}

function thoughtToJson(t: { id: string; content: string; title: string | null; tags: readonly string[] | null; source: string; sourceRef: string | null; contentType: string; weight: number; epistemicStatus: string | null; createdAt: Date | null; compostedAt?: Date | null }) {
  return {
    id: t.id,
    content: t.content,
    title: t.title,
    tags: t.tags,
    source: t.source,
    source_ref: t.sourceRef,
    content_type: t.contentType,
    weight: t.weight,
    epistemic_status: t.epistemicStatus,
    created_at: t.createdAt?.toISOString() ?? null,
  }
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  services: AppServices,
): Promise<void> {
  const { repository, embeddingService } = services

  try {
    // GET /api/brain/status
    if (url.pathname === '/api/brain/status' && req.method === 'GET') {
      const [streamStats, thoughtStats, recentRuns, expiringBlocks] = await Promise.all([
        services.streamRepository.getStats(),
        services.repository.getStats(),
        services.distillationRepo.getRecentRuns(100),
        services.streamRepository.findExpiringBlocks(3),
      ])

      const lastRun = recentRuns[0] ?? null
      const now = Date.now()
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000

      const weeklyThoughts = recentRuns
        .filter((r) => r.createdAt && r.createdAt.getTime() > sevenDaysAgo)
        .reduce((sum, r) => sum + r.thoughtsCreated, 0)

      const weeklyCost = recentRuns
        .filter((r) => r.createdAt && r.createdAt.getTime() > sevenDaysAgo)
        .reduce((sum, r) => sum + r.estimatedCost, 0)

      const monthlyCost = recentRuns
        .filter((r) => r.createdAt && r.createdAt.getTime() > thirtyDaysAgo)
        .reduce((sum, r) => sum + r.estimatedCost, 0)

      const totalDistilledBlocks = recentRuns.reduce((sum, r) => sum + r.blocksProcessed, 0)
      const totalDistilledThoughts = recentRuns.reduce((sum, r) => sum + r.thoughtsCreated, 0)
      const conversionRate = totalDistilledBlocks > 0
        ? Math.round((totalDistilledThoughts / totalDistilledBlocks) * 100) / 100
        : 0

      const scheduler = services.distillationScheduler
      const nextRun = scheduler ? scheduler.getNextRun() : null

      json(res, {
        stream: {
          total_blocks: streamStats.totalBlocks,
          pending_blocks: streamStats.pendingBlocks,
          distilled_blocks: streamStats.distilledBlocks,
          pinned_blocks: streamStats.pinnedBlocks,
          expiring_soon: expiringBlocks.length,
        },
        distillation: {
          last_run: lastRun ? {
            id: lastRun.id,
            trigger: lastRun.trigger,
            status: lastRun.status,
            thoughts_created: lastRun.thoughtsCreated,
            blocks_processed: lastRun.blocksProcessed,
            estimated_cost: lastRun.estimatedCost,
            duration_ms: lastRun.durationMs,
            created_at: lastRun.createdAt?.toISOString() ?? null,
          } : null,
          next_run: nextRun?.toISOString() ?? null,
          weekly_thoughts: weeklyThoughts,
          conversion_rate: conversionRate,
          cost_7d: Math.round(weeklyCost * 1000000) / 1000000,
          cost_30d: Math.round(monthlyCost * 1000000) / 1000000,
        },
        thoughts: {
          total: thoughtStats.total,
          last_7_days: thoughtStats.last7Days,
          last_30_days: thoughtStats.last30Days,
          by_source: Object.fromEntries(thoughtStats.bySource),
        },
      })
      return
    }

    // GET /api/search
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const query = url.searchParams.get('q')
      if (!query) {
        json(res, { error: 'Missing query parameter "q"' }, 400)
        return
      }

      const limit = clampInt(url.searchParams.get('limit'), 10, 1, 100)
      const minSimilarity = clampFloat(url.searchParams.get('min_similarity'), 0.3, 0, 1)

      const embedding = await embeddingService.embed(query)
      const results = await repository.search(embedding, limit, minSimilarity)

      json(res, {
        results: results.map((r) => ({
          ...thoughtToJson(r.thought),
          similarity: Math.round(r.similarity * 1000) / 1000,
        })),
        total: results.length,
      })
      return
    }

    // GET /api/recent
    if (url.pathname === '/api/recent' && req.method === 'GET') {
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 200)
      const source = url.searchParams.get('source') ?? undefined
      const epistemicStatus = url.searchParams.get('epistemic_status') ?? undefined

      const results = await repository.findRecent(limit, { source, epistemicStatus })

      json(res, {
        thoughts: results.map(thoughtToJson),
        total: results.length,
      })
      return
    }

    // GET /api/stats
    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const stats = await repository.getStats()

      json(res, {
        total: stats.total,
        by_source: Object.fromEntries(stats.bySource),
        by_type: Object.fromEntries(stats.byType),
        last_7_days: stats.last7Days,
        last_30_days: stats.last30Days,
      })
      return
    }

    // GET /api/tags
    if (url.pathname === '/api/tags' && req.method === 'GET') {
      const tags = await repository.listTags()

      json(res, {
        tags: Array.from(tags.entries()).map(([tag, count]) => ({ tag, count })),
        total_unique: tags.size,
      })
      return
    }

    // GET /api/tags/orphans
    if (url.pathname === '/api/tags/orphans' && req.method === 'GET') {
      const tags = await repository.listTags()
      const orphanTags = Array.from(tags.entries())
        .filter(([, count]) => count === 1)
        .map(([tag]) => tag)

      const orphans = await Promise.all(
        orphanTags.map(async (tag) => {
          const tagThoughts = await repository.findByTag(tag)
          const thought = tagThoughts[0]
          return {
            tag,
            thought: thought
              ? { id: thought.id, title: thought.title, content: thought.content, source: thought.source, created_at: thought.createdAt?.toISOString() ?? null }
              : null,
          }
        }),
      )

      json(res, { orphans, total: orphans.length })
      return
    }

    // PUT /api/tags/rename
    if (url.pathname === '/api/tags/rename' && req.method === 'PUT') {
      const raw = await parseJsonBody(req)
      const body = renameTagSchema.parse(raw)
      const affected = await repository.renameTag(body.old_tag, body.new_tag)
      json(res, { renamed: body.old_tag, to: body.new_tag, thoughts_affected: affected })
      return
    }

    // GET /api/compost
    if (url.pathname === '/api/compost' && req.method === 'GET') {
      const composted = await repository.findComposted()
      const now = Date.now()

      json(res, {
        thoughts: composted.map((t) => {
          const elapsed = t.compostedAt ? Math.floor((now - t.compostedAt.getTime()) / (1000 * 60 * 60 * 24)) : 0
          return { ...thoughtToJson(t), composted_at: t.compostedAt?.toISOString() ?? null, days_remaining: Math.max(30 - elapsed, 0) }
        }),
        total: composted.length,
      })
      return
    }

    // GET /api/questions
    if (url.pathname === '/api/questions' && req.method === 'GET') {
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
      const questions = await repository.findByEpistemicStatus('question', limit)

      json(res, {
        thoughts: questions.map(thoughtToJson),
        total: questions.length,
      })
      return
    }

    // GET /api/review
    if (url.pathname === '/api/review' && req.method === 'GET') {
      const daysAgo = clampInt(url.searchParams.get('days_ago'), 7, 1, 365)
      const limit = clampInt(url.searchParams.get('limit'), 7, 1, 20)
      const results = await repository.findForReview(daysAgo, limit)
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
      return
    }

    // GET /api/timeline
    if (url.pathname === '/api/timeline' && req.method === 'GET') {
      const query = url.searchParams.get('q')
      if (!query) {
        json(res, { error: 'Missing query parameter "q"' }, 400)
        return
      }
      const limit = clampInt(url.searchParams.get('limit'), 30, 1, 100)
      const minSimilarity = clampFloat(url.searchParams.get('min_similarity'), 0.3, 0, 1)

      const embedding = await embeddingService.embed(query)
      const results = await repository.searchTimeline(embedding, limit, minSimilarity)

      json(res, {
        results: results.map((r) => ({
          ...thoughtToJson(r.thought),
          similarity: Math.round(r.similarity * 1000) / 1000,
        })),
        total: results.length,
      })
      return
    }

    // POST /api/import/files
    if (url.pathname === '/api/import/files' && req.method === 'POST') {
      const raw = await parseJsonBody(req, 1024 * 1024 * 6)
      const body = importFilesSchema.parse(raw)
      const progress = services.importService.getProgress()
      if (progress.running) {
        json(res, { error: 'Import already in progress' }, 409)
        return
      }
      services.importService.importFiles(body.files, body.source).catch((err) => {
        logger.error({ err }, 'Background file import failed')
      })
      json(res, { started: true, total: body.files.length })
      return
    }

    // POST /api/import/obsidian/scan
    if (url.pathname === '/api/import/obsidian/scan' && req.method === 'POST') {
      const raw = await parseJsonBody(req)
      const body = obsidianScanSchema.parse(raw)
      const files = await services.importService.scanVault(body.path)
      json(res, { files, total: files.length })
      return
    }

    // POST /api/import/obsidian/start
    if (url.pathname === '/api/import/obsidian/start' && req.method === 'POST') {
      const raw = await parseJsonBody(req)
      const body = obsidianStartSchema.parse(raw)
      const progress = services.importService.getProgress()
      if (progress.running) {
        json(res, { error: 'Import already in progress' }, 409)
        return
      }
      services.importService.importVaultFiles(body.path, body.files).catch((err) => {
        logger.error({ err }, 'Background vault import failed')
      })
      json(res, { started: true, total: body.files.length })
      return
    }

    // GET /api/import/status
    if (url.pathname === '/api/import/status' && req.method === 'GET') {
      json(res, services.importService.getProgress())
      return
    }

    // GET /api/activity
    if (url.pathname === '/api/activity' && req.method === 'GET') {
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
      const tool = url.searchParams.get('tool') ?? undefined
      const client = url.searchParams.get('client') ?? undefined
      const entries = await services.activityLogger.getRecent(limit, { tool, client })

      json(res, {
        entries: entries.map((e) => ({
          id: e.id,
          tool_name: e.toolName,
          client_name: e.clientName ?? null,
          client_version: e.clientVersion ?? null,
          status: e.status,
          duration_ms: e.durationMs,
          input_summary: e.inputSummary ?? null,
          output_summary: e.outputSummary ?? null,
          error_message: e.errorMessage ?? null,
          created_at: e.createdAt?.toISOString() ?? null,
        })),
        total: entries.length,
      })
      return
    }

    // GET /api/activity/stats
    if (url.pathname === '/api/activity/stats' && req.method === 'GET') {
      const stats = await services.activityLogger.getStats()

      json(res, {
        total_calls: stats.totalCalls,
        today: stats.today,
        by_tool: Object.fromEntries(stats.byTool),
        by_client: Object.fromEntries(stats.byClient),
        avg_duration_ms: stats.avgDurationMs,
      })
      return
    }

    // GET /api/duplicates
    if (url.pathname === '/api/duplicates' && req.method === 'GET') {
      const minSimilarity = clampFloat(url.searchParams.get('min_similarity'), 0.92, 0.8, 1)
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 50)
      const pairs = await repository.findDuplicates(minSimilarity, limit)

      json(res, {
        pairs: pairs.map((p) => ({
          thought_a: thoughtToJson(p.thoughtA),
          thought_b: thoughtToJson(p.thoughtB),
          similarity: Math.round(p.similarity * 1000) / 1000,
        })),
        total: pairs.length,
      })
      return
    }

    // POST /api/duplicates/merge
    if (url.pathname === '/api/duplicates/merge' && req.method === 'POST') {
      const raw = await parseJsonBody(req)
      const body = mergeSchema.parse(raw)
      const merged = await repository.mergeThoughts(body.keep_id, body.remove_id)
      if (!merged) {
        json(res, { error: 'Thoughts not found' }, 404)
        return
      }
      json(res, { merged: thoughtToJson(merged), removed_id: body.remove_id })
      return
    }

    // POST /api/duplicates/dismiss
    if (url.pathname === '/api/duplicates/dismiss' && req.method === 'POST') {
      const raw = await parseJsonBody(req)
      const body = dismissSchema.parse(raw)
      await repository.dismissPair(body.id_a, body.id_b)
      json(res, { dismissed: true })
      return
    }

    // POST /api/thoughts/batch
    if (url.pathname === '/api/thoughts/batch' && req.method === 'POST') {
      const raw = await parseJsonBody(req)
      const body = batchSchema.parse(raw)
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
      return
    }

    // DELETE /api/tags/:tag/from/:thoughtId
    const tagRemoveMatch = matchPath(url.pathname, '/api/tags/:tag/from/:thoughtId')
    if (tagRemoveMatch && req.method === 'DELETE') {
      const { tag, thoughtId } = tagRemoveMatch
      if (!tag || !thoughtId || !isValidUuid(thoughtId)) {
        json(res, { error: 'Missing or invalid tag/thoughtId' }, 400)
        return
      }
      const decodedTag = decodeURIComponent(tag)
      const removed = await repository.removeTagFromThought(thoughtId, decodedTag)
      if (!removed) {
        json(res, { error: 'Tag not found on thought' }, 404)
        return
      }
      json(res, { removed: true, tag: decodedTag, thoughtId })
      return
    }

    // PATCH /api/thoughts/:id/weight
    const weightMatch = matchPath(url.pathname, '/api/thoughts/:id/weight')
    if (weightMatch && req.method === 'PATCH') {
      const { id } = weightMatch
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const existing = await repository.findById(id)
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

      await repository.update(id, { weight: Math.round(newWeight * 100) / 100 })
      json(res, { id, weight: Math.round(newWeight * 100) / 100, direction: body.direction })
      return
    }

    // PATCH /api/thoughts/:id/status
    const statusMatch = matchPath(url.pathname, '/api/thoughts/:id/status')
    if (statusMatch && req.method === 'PATCH') {
      const { id } = statusMatch
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const existing = await repository.findById(id)
      if (!existing) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      const raw = await parseJsonBody(req)
      const body = epistemicStatusSchema.parse(raw)
      await repository.update(id, { epistemicStatus: body.status })
      json(res, { id, epistemic_status: body.status })
      return
    }

    // POST /api/thoughts/:id/compost
    const compostMatch = matchPath(url.pathname, '/api/thoughts/:id/compost')
    if (compostMatch && req.method === 'POST') {
      const { id } = compostMatch
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const composted = await repository.compost(id)
      if (!composted) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      json(res, { id, composted_at: composted.compostedAt?.toISOString() ?? null })
      return
    }

    // POST /api/thoughts/:id/restore
    const restoreMatch = matchPath(url.pathname, '/api/thoughts/:id/restore')
    if (restoreMatch && req.method === 'POST') {
      const { id } = restoreMatch
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const restored = await repository.uncompost(id)
      if (!restored) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      json(res, { id, restored: true })
      return
    }

    // DELETE /api/thoughts/:id
    const deleteMatch = matchPath(url.pathname, '/api/thoughts/:id')
    if (deleteMatch && req.method === 'DELETE') {
      const { id } = deleteMatch
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const existing = await repository.findById(id)
      if (!existing) {
        json(res, { error: 'Thought not found' }, 404)
        return
      }
      const deleted = await repository.deleteById(id)
      json(res, { deleted, id })
      return
    }

    // PUT /api/thoughts/:id
    const putMatch = matchPath(url.pathname, '/api/thoughts/:id')
    if (putMatch && req.method === 'PUT') {
      const { id } = putMatch
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid thought ID' }, 400)
        return
      }
      const existing = await repository.findById(id)
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

      let newEmbedding: readonly number[] | undefined
      if (body.content && body.content !== existing.content) {
        newEmbedding = await embeddingService.embed(body.content)
      }

      const updated = await repository.update(id, {
        content: body.content,
        title: body.title,
        tags: body.tags,
        embedding: newEmbedding,
      })

      if (!updated) {
        json(res, { error: 'Update failed' }, 500)
        return
      }

      json(res, {
        ...thoughtToJson(updated),
        updated_at: updated.updatedAt?.toISOString() ?? null,
        re_embedded: newEmbedding !== undefined,
      })
      return
    }

    // GET /api/stream
    if (url.pathname === '/api/stream' && req.method === 'GET') {
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
      return
    }

    // GET /api/stream/sessions
    if (url.pathname === '/api/stream/sessions' && req.method === 'GET') {
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
      return
    }

    // GET /api/stream/stats
    if (url.pathname === '/api/stream/stats' && req.method === 'GET') {
      const stats = await services.streamRepository.getStats()

      json(res, {
        total_blocks: stats.totalBlocks,
        total_sessions: stats.totalSessions,
        pending_blocks: stats.pendingBlocks,
        distilled_blocks: stats.distilledBlocks,
        pinned_blocks: stats.pinnedBlocks,
      })
      return
    }

    // POST /api/stream
    if (url.pathname === '/api/stream' && req.method === 'POST') {
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
      return
    }

    // PATCH /api/stream/:id/pin
    const streamPinMatch = matchPath(url.pathname, '/api/stream/:id/pin')
    if (streamPinMatch && req.method === 'PATCH') {
      const { id } = streamPinMatch
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
      return
    }

    // POST /api/distillation/run
    if (url.pathname === '/api/distillation/run' && req.method === 'POST') {
      if (services.distillationService.isRunning()) {
        json(res, { error: 'Distillation is already running' }, 409)
        return
      }
      services.distillationService.run('power_nap').catch((err) => {
        logger.error({ err }, 'Background distillation run failed')
      })
      json(res, { started: true })
      return
    }

    // GET /api/distillation/status
    if (url.pathname === '/api/distillation/status' && req.method === 'GET') {
      const running = services.distillationService.isRunning()
      const recent = await services.distillationRepo.getRecentRuns(1)
      const lastRun = recent[0] ?? null

      json(res, {
        running,
        last_run: lastRun ? {
          id: lastRun.id,
          trigger: lastRun.trigger,
          status: lastRun.status,
          thoughts_created: lastRun.thoughtsCreated,
          blocks_processed: lastRun.blocksProcessed,
          duration_ms: lastRun.durationMs,
          created_at: lastRun.createdAt?.toISOString() ?? null,
        } : null,
      })
      return
    }

    // GET /api/distillation/log
    if (url.pathname === '/api/distillation/log' && req.method === 'GET') {
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100)
      const runs = await services.distillationRepo.getRecentRuns(limit)

      json(res, {
        runs: runs.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          status: r.status,
          blocks_processed: r.blocksProcessed,
          sessions_processed: r.sessionsProcessed,
          thoughts_created: r.thoughtsCreated,
          thought_ids: r.thoughtIds,
          blocks_skipped: r.blocksSkipped,
          tokens_used: r.tokensUsed,
          estimated_cost: r.estimatedCost,
          duration_ms: r.durationMs,
          error_message: r.errorMessage,
          created_at: r.createdAt?.toISOString() ?? null,
        })),
        total: runs.length,
      })
      return
    }

    // GET /api/distillation/log/:id
    const distillLogMatch = matchPath(url.pathname, '/api/distillation/log/:id')
    if (distillLogMatch && req.method === 'GET') {
      const { id } = distillLogMatch
      if (!id || !isValidUuid(id)) {
        json(res, { error: 'Invalid run ID' }, 400)
        return
      }
      const run = await services.distillationRepo.getRunById(id)
      if (!run) {
        json(res, { error: 'Run not found' }, 404)
        return
      }

      // Enrich thought_ids with titles for UI display
      const thoughtSummaries = await Promise.all(
        (run.thoughtIds ?? []).map(async (tid) => {
          const thought = await repository.findById(tid)
          return thought
            ? { id: tid, title: thought.title ?? thought.content.slice(0, 80) }
            : { id: tid, title: null }
        }),
      )

      json(res, {
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        blocks_processed: run.blocksProcessed,
        sessions_processed: run.sessionsProcessed,
        thoughts_created: run.thoughtsCreated,
        thought_ids: run.thoughtIds,
        thought_summaries: thoughtSummaries,
        blocks_skipped: run.blocksSkipped,
        skip_reasons: run.skipReasons,
        tokens_used: run.tokensUsed,
        estimated_cost: run.estimatedCost,
        duration_ms: run.durationMs,
        error_message: run.errorMessage,
        created_at: run.createdAt?.toISOString() ?? null,
      })
      return
    }

    // DELETE /api/stream/:id
    const streamDeleteMatch = matchPath(url.pathname, '/api/stream/:id')
    if (streamDeleteMatch && req.method === 'DELETE') {
      const { id } = streamDeleteMatch
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
      return
    }

    json(res, { error: 'Not found' }, 404)
  } catch (error) {
    if (error instanceof z.ZodError) {
      json(res, { error: 'Validation failed', details: error.errors.map((e) => e.message) }, 400)
      return
    }
    logger.error({ err: error }, 'API error')
    json(res, { error: 'Internal server error' }, 500)
  }
}
