import { json, type Route } from '../http.js'

export const systemRoutes: readonly Route[] = [
  {
    method: 'GET',
    pattern: '/api/brain/status',
    handler: async ({ res, services }) => {
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
    },
  },
]
