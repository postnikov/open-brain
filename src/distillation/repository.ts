import { desc, eq } from 'drizzle-orm'
import { distillationLog } from '../db/schema.js'
import { DatabaseError } from '../shared/errors.js'
import type { Database } from '../db/connection.js'
import type { DistillationRunResult, DistillationLogEntry, DistillationRepository } from './types.js'

function toLogEntry(row: typeof distillationLog.$inferSelect): DistillationLogEntry {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    blocksProcessed: row.blocksProcessed,
    sessionsProcessed: row.sessionsProcessed,
    thoughtsCreated: row.thoughtsCreated,
    thoughtIds: row.thoughtIds,
    blocksSkipped: row.blocksSkipped,
    skipReasons: row.skipReasons,
    tokensUsed: row.tokensUsed,
    estimatedCost: row.estimatedCost,
    durationMs: row.durationMs,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  }
}

export function createDistillationRepository(db: Database): DistillationRepository {
  return {
    async logRun(result: DistillationRunResult): Promise<string> {
      try {
        const [row] = await db
          .insert(distillationLog)
          .values({
            id: result.runId,
            trigger: result.trigger,
            status: result.status,
            blocksProcessed: result.blocksProcessed,
            sessionsProcessed: result.sessionsProcessed,
            thoughtsCreated: result.thoughtsCreated,
            thoughtIds: [...result.thoughtIds],
            blocksSkipped: result.blocksSkipped,
            skipReasons: result.skipReasons,
            tokensUsed: result.tokensUsed,
            estimatedCost: result.estimatedCost,
            durationMs: result.durationMs,
            errorMessage: result.errorMessage ?? null,
          })
          .returning()

        if (!row) {
          throw new DatabaseError('Insert distillation log returned no rows')
        }

        return row.id
      } catch (error) {
        if (error instanceof DatabaseError) throw error
        throw new DatabaseError('Failed to log distillation run', error)
      }
    },

    async getRecentRuns(limit: number): Promise<readonly DistillationLogEntry[]> {
      try {
        const rows = await db
          .select()
          .from(distillationLog)
          .orderBy(desc(distillationLog.createdAt))
          .limit(limit)

        return rows.map(toLogEntry)
      } catch (error) {
        throw new DatabaseError('Failed to get recent distillation runs', error)
      }
    },

    async getRunById(id: string): Promise<DistillationLogEntry | null> {
      try {
        const [row] = await db
          .select()
          .from(distillationLog)
          .where(eq(distillationLog.id, id))
          .limit(1)

        return row ? toLogEntry(row) : null
      } catch (error) {
        throw new DatabaseError('Failed to get distillation run by ID', error)
      }
    },
  }
}
