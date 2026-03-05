import { logger } from '../shared/logger.js'
import type { StreamRepository } from './types.js'

export async function runStreamCleanup(streamRepository: StreamRepository): Promise<void> {
  try {
    const deleted = await streamRepository.cleanupExpired()
    if (deleted > 0) {
      logger.info({ deleted }, 'Stream cleanup: removed expired blocks')
    }
  } catch (error) {
    logger.error({ err: error }, 'Stream cleanup failed')
  }
}
