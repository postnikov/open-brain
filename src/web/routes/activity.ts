import { clampInt, json, type Route } from '../http.js'

export const activityRoutes: readonly Route[] = [
  {
    method: 'GET',
    pattern: '/api/activity',
    handler: async ({ res, url, services }) => {
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
    },
  },
  {
    method: 'GET',
    pattern: '/api/activity/stats',
    handler: async ({ res, services }) => {
      const stats = await services.activityLogger.getStats()

      json(res, {
        total_calls: stats.totalCalls,
        today: stats.today,
        by_tool: Object.fromEntries(stats.byTool),
        by_client: Object.fromEntries(stats.byClient),
        avg_duration_ms: stats.avgDurationMs,
      })
    },
  },
]
