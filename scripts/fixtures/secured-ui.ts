// Synthetic UI only: no bootstrap, DB or AI. Stop this process after browser QA.
import { createServer } from 'node:http'
import { guardHttp } from '../../src/security/http.js'
import { serveStatic } from '../../src/web/static.js'
const port = Number(process.env.OPEN_BRAIN_UI_TEST_PORT ?? '3199')
const security = { host: '127.0.0.1' as const, port, token: 'a'.repeat(64), authorities: [`127.0.0.1:${port}`], origins: [`http://127.0.0.1:${port}`] }
const server = createServer(async (req, res) => {
  const url = guardHttp(req, res, security)
  if (!url) return
  if (await serveStatic(url.pathname, res, true)) return
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(url.pathname === '/api/brain/status' ? { thoughts: { total: 0 } } : url.pathname === '/health' ? { status: 'ok' } : { results: [], thoughts: [], total: 0 }))
})
server.listen(port, '127.0.0.1', () => console.log(`Synthetic UI fixture on ${port}`))
process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())
