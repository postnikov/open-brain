import { sql, desc, eq, gte, and, type SQL } from 'drizzle-orm'
import { activityLog } from '../db/schema.js'
import type { Database } from '../db/connection.js'

export interface ActivityLogEntry {
  readonly id?: string
  readonly toolName: string
  readonly clientName?: string
  readonly clientVersion?: string
  readonly sessionId?: string
  readonly status: 'success' | 'error'
  readonly durationMs: number
  readonly inputSummary?: string
  readonly outputSummary?: string
  readonly errorMessage?: string
  readonly createdAt?: Date
}

export interface ActivityStats {
  readonly totalCalls: number
  readonly today: number
  readonly byTool: ReadonlyMap<string, number>
  readonly byClient: ReadonlyMap<string, number>
  readonly avgDurationMs: number
}

export interface ActivityFilters {
  readonly tool?: string
  readonly client?: string
  readonly status?: string
}

export interface ActivityLogger {
  readonly log: (entry: Omit<ActivityLogEntry, 'id' | 'createdAt'>) => Promise<void>
  readonly getRecent: (limit: number, filters?: ActivityFilters) => Promise<readonly ActivityLogEntry[]>
  readonly getStats: () => Promise<ActivityStats>
}

export function createActivityLogger(db: Database): ActivityLogger {
  return {
    async log(entry): Promise<void> {
      await db.insert(activityLog).values({
        toolName: entry.toolName,
        clientName: entry.clientName ?? null,
        clientVersion: entry.clientVersion ?? null,
        sessionId: entry.sessionId ?? null,
        status: entry.status,
        durationMs: entry.durationMs,
        inputSummary: entry.inputSummary ?? null,
        outputSummary: entry.outputSummary ?? null,
        errorMessage: entry.errorMessage ?? null,
      })
    },

    async getRecent(limit, filters): Promise<readonly ActivityLogEntry[]> {
      const conditions: SQL[] = []
      if (filters?.tool) conditions.push(eq(activityLog.toolName, filters.tool))
      if (filters?.client) conditions.push(eq(activityLog.clientName, filters.client))
      if (filters?.status) conditions.push(eq(activityLog.status, filters.status))

      const query = conditions.length > 0
        ? db.select().from(activityLog).where(and(...conditions)).orderBy(desc(activityLog.createdAt)).limit(limit)
        : db.select().from(activityLog).orderBy(desc(activityLog.createdAt)).limit(limit)

      const rows = await query
      return rows.map((row) => ({
        id: row.id,
        toolName: row.toolName,
        clientName: row.clientName ?? undefined,
        clientVersion: row.clientVersion ?? undefined,
        sessionId: row.sessionId ?? undefined,
        status: row.status as 'success' | 'error',
        durationMs: row.durationMs ?? 0,
        inputSummary: row.inputSummary ?? undefined,
        outputSummary: row.outputSummary ?? undefined,
        errorMessage: row.errorMessage ?? undefined,
        createdAt: row.createdAt ?? undefined,
      }))
    },

    async getStats(): Promise<ActivityStats> {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)

      const [totalResult, todayResult, toolRows, clientRows, avgResult] = await Promise.all([
        db.execute(sql`SELECT count(*) as count FROM activity_log`),
        db.execute(sql`SELECT count(*) as count FROM activity_log WHERE created_at >= ${todayStart}`),
        db.execute(sql`SELECT tool_name, count(*) as count FROM activity_log GROUP BY tool_name ORDER BY count DESC`),
        db.execute(sql`SELECT client_name, count(*) as count FROM activity_log WHERE client_name IS NOT NULL GROUP BY client_name ORDER BY count DESC`),
        db.execute(sql`SELECT COALESCE(AVG(duration_ms), 0) as avg FROM activity_log`),
      ])

      const byTool = new Map<string, number>()
      for (const row of toolRows.rows) {
        byTool.set(row.tool_name as string, Number(row.count))
      }

      const byClient = new Map<string, number>()
      for (const row of clientRows.rows) {
        byClient.set(row.client_name as string, Number(row.count))
      }

      return {
        totalCalls: Number(totalResult.rows[0]?.count ?? 0),
        today: Number(todayResult.rows[0]?.count ?? 0),
        byTool,
        byClient,
        avgDurationMs: Math.round(Number(avgResult.rows[0]?.avg ?? 0)),
      }
    },
  }
}
