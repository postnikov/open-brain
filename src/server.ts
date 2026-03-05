import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { bootstrapServices, createMcpServer } from './bootstrap.js'
import { logger } from './shared/logger.js'
import { handleApiRequest } from './web/api.js'
import { HTML } from './web/ui.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const PORT = parseInt(process.env.PORT ?? '3100', 10)

interface Session {
  readonly transport: StreamableHTTPServerTransport
  readonly server: McpServer
}

async function main(): Promise<void> {
  const services = await bootstrapServices()

  const sessions = new Map<string, Session>()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }))
      return
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
      return
    }

    if (url.pathname.startsWith('/api/') && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    if (url.pathname.startsWith('/api/')) {
      await handleApiRequest(req, res, url, services)
      return
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (req.method === 'POST') {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!
        await session.transport.handleRequest(req, res)
        return
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      })

      const server = createMcpServer(services, () => {
        const info = server.server.getClientVersion()
        return { name: info?.name, version: info?.version }
      })

      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid) {
          sessions.delete(sid)
          logger.info({ sessionId: sid }, 'Session closed')
        }
      }

      await server.connect(transport)
      await transport.handleRequest(req, res)

      const sid = transport.sessionId
      if (sid) {
        sessions.set(sid, { transport, server })
        logger.info({ sessionId: sid }, 'New session created')
      }
      return
    }

    if (req.method === 'GET') {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!
        await session.transport.handleRequest(req, res)
        return
      }
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing or invalid session ID' }))
      return
    }

    if (req.method === 'DELETE') {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!
        await session.transport.close()
        await session.server.close()
        sessions.delete(sessionId)
        res.writeHead(200)
        res.end()
        return
      }
      res.writeHead(404)
      res.end('Session not found')
      return
    }

    res.writeHead(405)
    res.end('Method not allowed')
  })

  // Compost cleanup: run on startup + every hour
  const runCompostCleanup = async () => {
    try {
      const deleted = await services.repository.cleanupCompost(30)
      if (deleted > 0) {
        logger.info({ deleted }, 'Compost cleanup: removed expired thoughts')
      }
    } catch (error) {
      logger.error({ err: error }, 'Compost cleanup failed')
    }
  }
  await runCompostCleanup()
  const cleanupInterval = setInterval(runCompostCleanup, 60 * 60 * 1000)

  httpServer.listen(PORT, () => {
    logger.info({ port: PORT }, 'Open Brain HTTP MCP server started')
    process.stderr.write(`Open Brain listening on http://localhost:${PORT}/mcp\n`)
  })

  const shutdown = async () => {
    logger.info('Shutting down HTTP server...')
    for (const session of sessions.values()) {
      await session.transport.close()
      await session.server.close()
    }
    clearInterval(cleanupInterval)
    httpServer.close()
    await services.pool.end()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  logger.error({ err: error }, 'Failed to start HTTP MCP server')
  process.exit(1)
})
