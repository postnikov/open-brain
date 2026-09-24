import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer, type AppServices } from '../bootstrap.js'
import { handleApiRequest } from '../web/api.js'
import { serveStatic } from '../web/static.js'
import { guardHttp, type HttpSecurity } from './http.js'
import { uploadOnlyImportService } from './file-access.js'

/** Separate staged entry point: legacy production does not acquire auth on restart. */
export function createHardenedServer(base: AppServices, security: HttpSecurity) {
  const services = { ...base, importService: uploadOnlyImportService(base.importService) }
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createMcpServer> }>()
  const http = createServer(async (req, res) => {
    try {
      const url = guardHttp(req, res, security)
      if (!url) return
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', sessions: sessions.size })); return
      }
      if (req.method === 'GET' && await serveStatic(url.pathname, res, true)) return
      if (url.pathname.startsWith('/api/')) { await handleApiRequest(req, res, url, services); return }
      if (url.pathname !== '/mcp') { res.writeHead(404); res.end(); return }
      const sessionId = req.headers['mcp-session-id']
      if (Array.isArray(sessionId)) { res.writeHead(400); res.end(); return }
      const session = sessionId ? sessions.get(sessionId) : undefined
      if (req.method === 'POST') {
        if (session) { await session.transport.handleRequest(req, res); return }
        if (sessionId) { res.writeHead(404); res.end(); return }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
        const server = createMcpServer(services, () => {
          const info = server.server.getClientVersion()
          return { name: info?.name, version: info?.version }
        })
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId) }
        await server.connect(transport)
        try {
          await transport.handleRequest(req, res)
          if (transport.sessionId) sessions.set(transport.sessionId, { transport, server })
          else { await transport.close(); await server.close() }
        } catch (error) { await transport.close(); await server.close(); throw error }
        return
      }
      if (req.method === 'GET' && session) { await session.transport.handleRequest(req, res); return }
      if (req.method === 'DELETE' && session) {
        await session.transport.close(); await session.server.close(); sessions.delete(sessionId!)
        res.writeHead(200); res.end(); return
      }
      res.writeHead(req.method === 'GET' || req.method === 'DELETE' ? 404 : 405); res.end()
    } catch {
      // Provider payloads and authorization headers must never reach an error log/response.
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request failed' }))
    }
  })
  return { http, closeSessions: async () => {
    for (const { transport, server } of sessions.values()) { await transport.close(); await server.close() }
    sessions.clear()
  } }
}
