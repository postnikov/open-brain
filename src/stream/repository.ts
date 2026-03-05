import { sql, desc, eq, and, isNull, isNotNull } from 'drizzle-orm'
import { stream } from '../db/schema.js'
import type { Database } from '../db/connection.js'
import type {
  StreamBlock,
  CreateStreamBlockInput,
  StreamFilters,
  StreamSessionSummary,
  StreamStats,
  StreamRepository,
} from './types.js'
import { DatabaseError } from '../shared/errors.js'

function toStreamBlock(row: typeof stream.$inferSelect): StreamBlock {
  return {
    id: row.id,
    sessionId: row.sessionId,
    blockNumber: row.blockNumber,
    topic: row.topic,
    content: row.content,
    participants: row.participants,
    sourceClient: row.sourceClient,
    pinned: row.pinned,
    distilledAt: row.distilledAt,
    distillationRunId: row.distillationRunId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

function rawRowToStreamBlock(row: Record<string, unknown>): StreamBlock {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    blockNumber: row.block_number as number,
    topic: row.topic as string | null,
    content: row.content as string,
    participants: row.participants as string[] | null,
    sourceClient: row.source_client as string | null,
    pinned: row.pinned as boolean,
    distilledAt: row.distilled_at ? new Date(row.distilled_at as string) : null,
    distillationRunId: row.distillation_run_id as string | null,
    createdAt: row.created_at ? new Date(row.created_at as string) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
  }
}

export function createStreamRepository(db: Database, ttlDays: number): StreamRepository {
  return {
    async write(input: CreateStreamBlockInput): Promise<StreamBlock> {
      try {
        const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)

        const [row] = await db
          .insert(stream)
          .values({
            sessionId: input.sessionId,
            blockNumber: input.blockNumber,
            topic: input.topic ?? null,
            content: input.content,
            participants: input.participants ? [...input.participants] : null,
            sourceClient: input.sourceClient ?? null,
            expiresAt,
          })
          .onConflictDoUpdate({
            target: [stream.sessionId, stream.blockNumber],
            set: {
              topic: input.topic ?? null,
              content: input.content,
              participants: input.participants ? [...input.participants] : null,
              sourceClient: input.sourceClient ?? null,
              expiresAt,
            },
          })
          .returning()

        if (!row) {
          throw new DatabaseError('Insert returned no rows')
        }

        return toStreamBlock(row)
      } catch (error) {
        if (error instanceof DatabaseError) throw error
        throw new DatabaseError('Failed to write stream block', error)
      }
    },

    async findBySession(sessionId: string, limit: number): Promise<readonly StreamBlock[]> {
      try {
        const rows = await db
          .select()
          .from(stream)
          .where(eq(stream.sessionId, sessionId))
          .orderBy(stream.blockNumber)
          .limit(limit)

        return rows.map(toStreamBlock)
      } catch (error) {
        throw new DatabaseError('Failed to find stream blocks by session', error)
      }
    },

    async findRecent(limit: number, filters?: StreamFilters): Promise<readonly StreamBlock[]> {
      try {
        if (filters?.search) {
          const result = await db.execute(sql`
            SELECT * FROM stream
            WHERE to_tsvector('english', content) @@ plainto_tsquery('english', ${filters.search})
            ${filters.sessionId ? sql`AND session_id = ${filters.sessionId}` : sql``}
            ${filters.status === 'pending' ? sql`AND distilled_at IS NULL` : sql``}
            ${filters.status === 'distilled' ? sql`AND distilled_at IS NOT NULL` : sql``}
            ${filters.status === 'pinned' ? sql`AND pinned = true` : sql``}
            ${filters.fromDate ? sql`AND created_at >= ${filters.fromDate}` : sql``}
            ${filters.toDate ? sql`AND created_at <= ${filters.toDate}` : sql``}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `)

          return result.rows.map((row: Record<string, unknown>) => rawRowToStreamBlock(row))
        }

        const conditions = []

        if (filters?.sessionId) {
          conditions.push(eq(stream.sessionId, filters.sessionId))
        }
        if (filters?.status === 'pending') {
          conditions.push(isNull(stream.distilledAt))
        } else if (filters?.status === 'distilled') {
          conditions.push(isNotNull(stream.distilledAt))
        } else if (filters?.status === 'pinned') {
          conditions.push(eq(stream.pinned, true))
        }
        if (filters?.fromDate) {
          conditions.push(sql`${stream.createdAt} >= ${filters.fromDate}`)
        }
        if (filters?.toDate) {
          conditions.push(sql`${stream.createdAt} <= ${filters.toDate}`)
        }

        const query = db
          .select()
          .from(stream)
          .orderBy(desc(stream.createdAt))
          .limit(limit)

        const rows = conditions.length > 0
          ? await query.where(and(...conditions))
          : await query

        return rows.map(toStreamBlock)
      } catch (error) {
        throw new DatabaseError('Failed to find recent stream blocks', error)
      }
    },

    async listSessions(limit: number): Promise<readonly StreamSessionSummary[]> {
      try {
        const rows = await db.execute(sql`
          SELECT
            session_id,
            count(*) as block_count,
            min(created_at) as first_block,
            max(created_at) as last_block,
            (array_agg(topic ORDER BY block_number) FILTER (WHERE topic IS NOT NULL))[1] as topic,
            (array_agg(source_client) FILTER (WHERE source_client IS NOT NULL))[1] as source_client
          FROM stream
          GROUP BY session_id
          ORDER BY max(created_at) DESC
          LIMIT ${limit}
        `)

        return rows.rows.map((row: Record<string, unknown>) => ({
          sessionId: row.session_id as string,
          blockCount: Number(row.block_count),
          firstBlock: row.first_block ? new Date(row.first_block as string) : null,
          lastBlock: row.last_block ? new Date(row.last_block as string) : null,
          topic: row.topic as string | null,
          sourceClient: row.source_client as string | null,
        }))
      } catch (error) {
        throw new DatabaseError('Failed to list stream sessions', error)
      }
    },

    async findPendingForDistillation(limit: number): Promise<readonly StreamBlock[]> {
      try {
        const rows = await db
          .select()
          .from(stream)
          .where(and(isNull(stream.distilledAt), eq(stream.pinned, false)))
          .orderBy(stream.createdAt)
          .limit(limit)

        return rows.map(toStreamBlock)
      } catch (error) {
        throw new DatabaseError('Failed to find pending stream blocks for distillation', error)
      }
    },

    async markDistilled(ids: readonly string[], runId: string): Promise<number> {
      try {
        const result = await db.execute(sql`
          UPDATE stream
          SET distilled_at = NOW(), distillation_run_id = ${runId}
          WHERE id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`,`)}]::uuid[])
          RETURNING id
        `)
        return result.rows.length
      } catch (error) {
        throw new DatabaseError('Failed to mark stream blocks as distilled', error)
      }
    },

    async cleanupExpired(): Promise<number> {
      try {
        const result = await db
          .delete(stream)
          .where(sql`${stream.expiresAt} < NOW() AND ${stream.pinned} = false`)
          .returning({ id: stream.id })
        return result.length
      } catch (error) {
        throw new DatabaseError('Failed to cleanup expired stream blocks', error)
      }
    },

    async getStats(): Promise<StreamStats> {
      try {
        const rows = await db.execute(sql`
          SELECT
            count(*) as total_blocks,
            count(DISTINCT session_id) as total_sessions,
            count(*) FILTER (WHERE distilled_at IS NULL) as pending_blocks,
            count(*) FILTER (WHERE distilled_at IS NOT NULL) as distilled_blocks,
            count(*) FILTER (WHERE pinned = true) as pinned_blocks
          FROM stream
        `)

        const row = rows.rows[0] as Record<string, unknown> | undefined
        return {
          totalBlocks: Number(row?.total_blocks ?? 0),
          totalSessions: Number(row?.total_sessions ?? 0),
          pendingBlocks: Number(row?.pending_blocks ?? 0),
          distilledBlocks: Number(row?.distilled_blocks ?? 0),
          pinnedBlocks: Number(row?.pinned_blocks ?? 0),
        }
      } catch (error) {
        throw new DatabaseError('Failed to get stream stats', error)
      }
    },

    async pin(id: string): Promise<StreamBlock | null> {
      try {
        const [row] = await db
          .update(stream)
          .set({ pinned: true, expiresAt: null })
          .where(eq(stream.id, id))
          .returning()
        return row ? toStreamBlock(row) : null
      } catch (error) {
        throw new DatabaseError('Failed to pin stream block', error)
      }
    },

    async unpin(id: string): Promise<StreamBlock | null> {
      try {
        const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)
        const [row] = await db
          .update(stream)
          .set({ pinned: false, expiresAt })
          .where(eq(stream.id, id))
          .returning()
        return row ? toStreamBlock(row) : null
      } catch (error) {
        throw new DatabaseError('Failed to unpin stream block', error)
      }
    },

    async deleteById(id: string): Promise<boolean> {
      try {
        const result = await db.delete(stream).where(eq(stream.id, id)).returning({ id: stream.id })
        return result.length > 0
      } catch (error) {
        throw new DatabaseError('Failed to delete stream block', error)
      }
    },
  }
}
