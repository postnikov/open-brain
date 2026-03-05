import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { bootstrapServices, createMcpServer } from './bootstrap.js'
import { logger } from './shared/logger.js'

async function main(): Promise<void> {
  const services = await bootstrapServices()
  const server = createMcpServer(services)

  const transport = new StdioServerTransport()
  await server.connect(transport)

  logger.info('Open Brain MCP server started (stdio)')

  const shutdown = async () => {
    logger.info('Shutting down...')
    await server.close()
    await services.pool.end()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  logger.error({ err: error }, 'Failed to start MCP server')
  process.exit(1)
})
