import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadConfig, getDatabaseUrl } from './config/loader.js'
import { createDatabase } from './db/connection.js'
import { createThoughtsRepository } from './repository/thoughts.js'
import { createEmbeddingService } from './pipeline/embeddings.js'
import { createMetadataService } from './pipeline/metadata.js'
import { createCapturePipeline } from './pipeline/capture.js'
import { registerTools } from './tools/register.js'
import type { CapturePipeline } from './pipeline/capture.js'
import type { EmbeddingService } from './pipeline/embeddings.js'
import type { ThoughtsRepository } from './repository/types.js'
import type pg from 'pg'

export interface AppServices {
  readonly pipeline: CapturePipeline
  readonly embeddingService: EmbeddingService
  readonly repository: ThoughtsRepository
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
  const embeddingService = createEmbeddingService(apiKey, config.openai.embedding_model)
  const metadataService = createMetadataService(apiKey, config.openai.metadata_model)
  const pipeline = createCapturePipeline(embeddingService, metadataService, repository)

  return { pipeline, embeddingService, repository, pool }
}

export function createMcpServer(services: AppServices): McpServer {
  const server = new McpServer({
    name: 'open-brain',
    version: '0.1.0',
  })

  registerTools(server, services.pipeline, services.embeddingService, services.repository)

  return server
}
