import 'dotenv/config'
import { bootstrapServices } from './bootstrap.js'
import { loadHttpSecurity } from './security/http.js'
import { createHardenedServer } from './security/server.js'
import { createDistillationScheduler } from './distillation/scheduler.js'
import { runStreamCleanup } from './stream/cleanup.js'

async function main() {
  // Fail closed before bootstrap, scheduler or cleanup can touch data.
  const security = await loadHttpSecurity()
  const services = await bootstrapServices()
  const distillationScheduler = createDistillationScheduler(services.distillationService, services.config.distillation.schedule, services.config.distillation.enabled, services.config.distillation.retry_poll_ms)
  const { http, closeSessions } = createHardenedServer({ ...services, distillationScheduler }, security)
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(security.port, security.host, resolve) })
  distillationScheduler.start()
  const cleanup = async () => {
    await services.repository.cleanupCompost(30)
    await runStreamCleanup(services.streamRepository)
  }
  // Deployment/maintenance may pause deletion until durable TTL coordination ships.
  // This does not change distillation policy or replay historical input.
  const cleanupEnabled = process.env.OPEN_BRAIN_DISABLE_CLEANUP !== '1' && process.env.OPEN_BRAIN_MAINTENANCE !== '1'
  const timer = cleanupEnabled ? setInterval(() => { void cleanup().catch(() => console.error('Cleanup failed')) }, 60 * 60 * 1000) : undefined
  if (cleanupEnabled && services.config.stream.cleanup_on_startup) await cleanup()
  // Nightly-style consolidation of memory tiers: no AI calls, no deletion, paused by maintenance.
  const memory = services.config.memory
  const refreshTiers = () => services.repository.refreshTiers({ hotMinOpens: memory.hot_min_opens, hotWindowDays: memory.hot_window_days, coolAfterDays: memory.cool_after_days })
    .then((r) => { if (r.promoted || r.demoted || r.candidatesTagged) console.error(`Memory tiers: +hot ${r.promoted}, -hot ${r.demoted}, candidates ${r.candidatesTagged}`) })
    .catch(() => console.error('Memory tier refresh failed'))
  const tierTimer = process.env.OPEN_BRAIN_MAINTENANCE !== '1' ? setInterval(() => { void refreshTiers() }, memory.tier_refresh_hours * 60 * 60 * 1000) : undefined
  if (tierTimer) void refreshTiers()
  const shutdown = async () => {
    clearInterval(timer); clearInterval(tierTimer); distillationScheduler.stop(); await closeSessions()
    await new Promise<void>(resolve => http.close(() => resolve()))
    await services.pool.end()
  }
  process.once('SIGTERM', () => { void shutdown() })
  process.once('SIGINT', () => { void shutdown() })
  console.error(`Open Brain secured HTTP listening on ${security.host}:${security.port}`)
}
main().catch((error: unknown) => {
  // Configuration errors are safe to name (key names only); anything else stays generic.
  const message = error instanceof Error && /^(OPEN_BRAIN_|Invalid OPEN_BRAIN_|Configure exactly one|Invalid HTTP port|Auth token must|HTTP token unavailable)/.test(error.message) ? `: ${error.message}` : '; check private configuration'
  console.error(`Secured server failed to start${message}`); process.exit(1)
})
