import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadConfig, getDatabaseUrl } from './config/loader.js'
import { createDatabase } from './db/connection.js'
import { createThoughtsRepository } from './repository/thoughts.js'
import { createEmbeddingService } from './pipeline/embeddings.js'
import { createMetadataService } from './pipeline/metadata.js'
import { createCapturePipeline } from './pipeline/capture.js'
import { createActivityLogger } from './activity/logger.js'
import { createImportService } from './import/service.js'
import { registerTools } from './tools/register.js'
import type { CapturePipeline } from './pipeline/capture.js'
import type { EmbeddingService } from './pipeline/embeddings.js'
import type { ThoughtsRepository } from './repository/types.js'
import type { ActivityLogger } from './activity/logger.js'
import type { ImportService } from './import/service.js'
import type { ClientInfo } from './activity/middleware.js'
import type pg from 'pg'

export interface AppServices {
  readonly pipeline: CapturePipeline
  readonly embeddingService: EmbeddingService
  readonly repository: ThoughtsRepository
  readonly activityLogger: ActivityLogger
  readonly importService: ImportService
  readonly pool: pg.Pool
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

  return { pipeline, embeddingService, repository, activityLogger, importService, pool }
}

export function createMcpServer(services: AppServices, getClientInfo: () => ClientInfo): McpServer {
  const server = new McpServer({
    name: 'open-brain',
    version: '0.1.0',
  })

  registerTools(server, services.pipeline, services.embeddingService, services.repository, services.activityLogger, getClientInfo)

  return server
}
