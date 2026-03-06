import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadConfig, getDatabaseUrl } from './config/loader.js'
import { createDatabase } from './db/connection.js'
import { createThoughtsRepository } from './repository/thoughts.js'
import { createEmbeddingService } from './pipeline/embeddings.js'
import { createMetadataService } from './pipeline/metadata.js'
import { createCapturePipeline } from './pipeline/capture.js'
import { createActivityLogger } from './activity/logger.js'
import { createImportService } from './import/service.js'
import { createStreamRepository } from './stream/repository.js'
import { createDistillationRepository } from './distillation/repository.js'
import { createDistillationService } from './distillation/service.js'
import { registerTools } from './tools/register.js'
import type { CapturePipeline } from './pipeline/capture.js'
import type { EmbeddingService } from './pipeline/embeddings.js'
import type { ThoughtsRepository } from './repository/types.js'
import type { ActivityLogger } from './activity/logger.js'
import type { ImportService } from './import/service.js'
import type { StreamRepository } from './stream/types.js'
import type { DistillationService } from './distillation/types.js'
import type { DistillationRepository } from './distillation/types.js'
import type { ClientInfo } from './activity/middleware.js'
import type { AppConfig } from './config/schema.js'
import type pg from 'pg'

export interface DistillationSchedulerInfo {
  readonly getNextRun: () => Date | null
  readonly isScheduled: () => boolean
}

export interface AppServices {
  readonly pipeline: CapturePipeline
  readonly embeddingService: EmbeddingService
  readonly repository: ThoughtsRepository
  readonly activityLogger: ActivityLogger
  readonly importService: ImportService
  readonly streamRepository: StreamRepository
  readonly distillationService: DistillationService
  readonly distillationRepo: DistillationRepository
  readonly config: AppConfig
  readonly pool: pg.Pool
  readonly distillationScheduler?: DistillationSchedulerInfo
}

export async function bootstrapServices(): Promise<AppServices> {
  const config = await loadConfig()
  const databaseUrl = getDatabaseUrl(config)

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required')
  }

  const { db, pool } = await createDatabase(databaseUrl)
  const repository = createThoughtsRepository(db)
  const activityLogger = createActivityLogger(db)
  const embeddingService = createEmbeddingService(apiKey, config.openai.embedding_model)
  const metadataService = createMetadataService(apiKey, config.openai.metadata_model)
  const pipeline = createCapturePipeline(embeddingService, metadataService, repository)

  const importService = createImportService(db, pipeline, repository)
  const streamRepository = createStreamRepository(db, config.stream.ttl_days)

  const distillationRepo = createDistillationRepository(db)
  const distillationService = createDistillationService(
    streamRepository,
    pipeline,
    distillationRepo,
    {
      model: config.distillation.model,
      temperature: config.distillation.temperature,
      maxBlocksPerRun: config.distillation.max_blocks_per_run,
      minBlockLength: config.distillation.min_block_length,
    },
    apiKey,
  )

  return { pipeline, embeddingService, repository, activityLogger, importService, streamRepository, distillationService, distillationRepo, config, pool }
}

export function createMcpServer(services: AppServices, getClientInfo: () => ClientInfo): McpServer {
  const server = new McpServer({
    name: 'open-brain',
    version: '0.1.0',
  })

  registerTools(server, services.pipeline, services.embeddingService, services.repository, services.activityLogger, getClientInfo, services.streamRepository)

  return server
}
