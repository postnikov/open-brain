import cron from 'node-cron'
import { logger } from '../shared/logger.js'
import type { DistillationService } from './types.js'

export interface DistillationScheduler {
  readonly start: () => void
  readonly stop: () => void
  readonly getNextRun: () => Date | null
  readonly isScheduled: () => boolean
}

export function createDistillationScheduler(
  distillationService: DistillationService,
  schedule: string,
  enabled: boolean,
): DistillationScheduler {
  let task: cron.ScheduledTask | null = null

  return {
    start() {
      if (!enabled) {
        logger.info('Distillation scheduler disabled by config')
        return
      }

      if (!cron.validate(schedule)) {
        logger.error({ schedule }, 'Invalid cron schedule for distillation')
        return
      }

      task = cron.schedule(schedule, async () => {
        try {
          logger.info('Cron-triggered distillation starting')
          await distillationService.run('cron')
        } catch (error) {
          logger.error({ err: error }, 'Cron distillation failed')
        }
      })

      logger.info({ schedule }, 'Distillation scheduler started')
    },

    stop() {
      if (task) {
        task.stop()
        task = null
        logger.info('Distillation scheduler stopped')
      }
    },

    getNextRun(): Date | null {
      if (!task || !enabled) return null
      try {
        // node-cron doesn't expose next run directly; compute from schedule
        const parts = schedule.split(' ')
        if (parts.length < 5) return null

        const now = new Date()
        const hour = parseInt(parts[1] ?? '0', 10)
        const minute = parseInt(parts[0] ?? '0', 10)

        const next = new Date(now)
        next.setHours(hour, minute, 0, 0)
        if (next <= now) {
          next.setDate(next.getDate() + 1)
        }
        return next
      } catch {
        return null
      }
    },

    isScheduled: () => task !== null && enabled,
  }
}
