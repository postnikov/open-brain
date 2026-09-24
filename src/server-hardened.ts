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
  const distillationScheduler = createDistillationScheduler(services.distillationService, services.config.distillation.schedule, services.config.distillation.enabled)
  const { http, closeSessions } = createHardenedServer({ ...services, distillationScheduler }, security)
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(security.port, security.host, resolve) })
  distillationScheduler.start()
  const cleanup = async () => {
    await services.repository.cleanupCompost(30)
    await runStreamCleanup(services.streamRepository)
  }
  // Deployment/maintenance may pause deletion until durable TTL coordination ships.
  // This does not change distillation policy or replay historical input.
  const cleanupEnabled = process.env.OPEN_BRAIN_DISABLE_CLEANUP !== '1'
  const timer = cleanupEnabled ? setInterval(() => { void cleanup().catch(() => console.error('Cleanup failed')) }, 60 * 60 * 1000) : undefined
  if (cleanupEnabled && services.config.stream.cleanup_on_startup) await cleanup()
  const shutdown = async () => {
    clearInterval(timer); distillationScheduler.stop(); await closeSessions()
    await new Promise<void>(resolve => http.close(() => resolve()))
    await services.pool.end()
  }
  process.once('SIGTERM', () => { void shutdown() })
  process.once('SIGINT', () => { void shutdown() })
  console.error(`Open Brain secured HTTP listening on 127.0.0.1:${security.port}`)
}
main().catch(() => { console.error('Secured server failed to start; check private configuration'); process.exit(1) })
