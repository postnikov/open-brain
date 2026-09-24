import { describe, it, expect, vi } from 'vitest'
import { createServer, request } from 'node:http'
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { guardHttp, loadHttpSecurity, type HttpSecurity } from './http.js'
import { createHardenedServer } from './server.js'
import { uploadOnlyImportService } from './file-access.js'
import type { AppServices } from '../bootstrap.js'

const TOKEN = 'a'.repeat(64)
const security: HttpSecurity = { host: '127.0.0.1', port: 3100, token: TOKEN, authorities: ['127.0.0.1:3100', 'localhost:3100'], origins: ['http://127.0.0.1:3100', 'http://localhost:3100'] }

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
async function close(server: ReturnType<typeof createServer>) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
function send(port: number, path: string, method = 'GET', headers: Record<string, string | string[]> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: '127.0.0.1:3100', ...headers } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
    }); req.on('error', reject); req.end()
  })
}

describe('HTTP security boundary', () => {
  it('loads Keychain tokens and fails closed on ambiguous, unavailable or invalid credentials', async () => {
    const get = vi.fn(async () => TOKEN)
    expect((await loadHttpSecurity({ OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE: 'test-service' }, get)).token).toBe(TOKEN)
    expect(get).toHaveBeenCalledExactlyOnceWith('test-service')
    await expect(loadHttpSecurity({ OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE: 'test', OPEN_BRAIN_HTTP_TOKEN_FILE: '/tmp/token' }, get)).rejects.toThrow('exactly one')
    await expect(loadHttpSecurity({ OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE: 'test' }, async () => 'invalid')).rejects.toThrow('32 random')
    await expect(loadHttpSecurity({ OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE: 'test' }, async () => { throw new Error('locked') })).rejects.toThrow('locked')
  })
  it('checks Host/Origin/bearer before every sensitive route and side effect', async () => {
    const sideEffect = vi.fn()
    const server = createServer((req, res) => { const url = guardHttp(req, res, security); if (url) { sideEffect(); res.writeHead(200); res.end('allowed') } })
    const port = await listen(server)
    try {
      for (const path of ['/mcp', '/api/export', '/api/import/files', '/api/stats', '/health']) {
        for (const method of ['GET', 'POST', 'DELETE']) {
          expect((await send(port, path, method)).status).toBe(401)
          expect((await send(port, path, method, { 'MCP-Session-Id': 'stolen', Authorization: 'Bearer wrong' })).status).toBe(401)
        }
      }
      expect(sideEffect).not.toHaveBeenCalled()
      for (const Host of ['evil.test:3100', '127.0.0.1:3101', '[::1]:3100', 'localhost:3100.evil', 'localhost']) {
        expect((await send(port, '/', 'GET', { Host, 'X-Forwarded-Host': '127.0.0.1:3100' })).status).toBe(403)
      }
      for (const Origin of ['null', 'https://localhost:3100', 'http://localhost:3101', 'http://localhost:3100.evil', 'garbage']) {
        expect((await send(port, '/health', 'GET', { Origin, Authorization: `Bearer ${TOKEN}` })).status).toBe(403)
      }
      expect((await send(port, '/health', 'GET', { Origin: ['http://localhost:3100', 'http://localhost:3100'] })).status).toBe(400)
      expect((await send(port, '//evil.test/', 'GET')).status).toBe(400)
      expect(sideEffect).not.toHaveBeenCalled()
      expect((await send(port, '/', 'GET')).status).toBe(200)
      expect((await send(port, '/health', 'GET', { Authorization: `Bearer ${TOKEN}` })).status).toBe(200)
      const allowed = await send(port, '/health', 'GET', { Origin: 'http://localhost:3100', Authorization: `Bearer ${TOKEN}` })
      expect(allowed.status).toBe(200)
      expect(allowed.headers['access-control-allow-origin']).toBeUndefined()
      expect((await send(port, '/mcp', 'OPTIONS', { Origin: 'http://localhost:3100' })).status).toBe(204)
      expect((await send(port, '/mcp', 'OPTIONS', { Origin: 'http://evil.test' })).status).toBe(403)
      expect((await send(port, '/api/import/obsidian/scan', 'POST', { Authorization: `Bearer ${TOKEN}` })).status).toBe(403)
    } finally { await close(server) }
  })
  it('fails closed for missing, public, symlinked, malformed secrets and wildcard bind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ob-secret-')); const file = join(dir, 'token')
    try {
      await expect(loadHttpSecurity({})).rejects.toThrow()
      await writeFile(file, TOKEN, { mode: 0o644 })
      await expect(loadHttpSecurity({ OPEN_BRAIN_HTTP_TOKEN_FILE: file })).rejects.toThrow('owner-only')
      await chmod(file, 0o600)
      expect((await loadHttpSecurity({ OPEN_BRAIN_HTTP_TOKEN_FILE: file })).host).toBe('127.0.0.1')
      await symlink(file, join(dir, 'link'))
      await expect(loadHttpSecurity({ OPEN_BRAIN_HTTP_TOKEN_FILE: join(dir, 'link') })).rejects.toThrow()
      await expect(loadHttpSecurity({ OPEN_BRAIN_HTTP_TOKEN_FILE: file, PORT: '3100oops' })).rejects.toThrow()
      await expect(loadHttpSecurity({ OPEN_BRAIN_HTTP_TOKEN_FILE: file, OPEN_BRAIN_BIND_HOST: '0.0.0.0' })).rejects.toThrow()
      await writeFile(file, 'short')
      await expect(loadHttpSecurity({ OPEN_BRAIN_HTTP_TOKEN_FILE: file })).rejects.toThrow('32 random')
    } finally { await rm(dir, { recursive: true }) }
  })
  it('denies directory imports at the service boundary without filesystem/AI calls', async () => {
    const scanVault = vi.fn(), importVaultFiles = vi.fn(), importFiles = vi.fn()
    const service = uploadOnlyImportService({ scanVault, importVaultFiles, importFiles, getProgress: vi.fn() })
    for (const path of ['/etc', '../secret', '/tmp/symlink', '/Users', '/allowed-sibling']) {
      await expect(service.scanVault(path)).rejects.toThrow('disabled')
      await expect(service.importVaultFiles(path, ['../../.env'])).rejects.toThrow('disabled')
    }
    expect(scanVault).not.toHaveBeenCalled(); expect(importVaultFiles).not.toHaveBeenCalled()
    await service.importFiles([{ name: 'selected.md', content: 'synthetic' }], 'upload')
    expect(importFiles).toHaveBeenCalledOnce()
  })
  it('completes authenticated MCP initialize/list/read/reconnect; a session alone is not auth', async () => {
    const findRecent = vi.fn(async () => [])
    const services = { repository: { findRecent }, activityLogger: { log: vi.fn(async () => {}) }, importService: { importFiles: vi.fn(), getProgress: vi.fn() } } as unknown as AppServices
    const mutable = { ...security, authorities: [] as string[], origins: [] as string[] }
    const { http, closeSessions } = createHardenedServer(services, mutable)
    const port = await listen(http)
    mutable.authorities.push(`127.0.0.1:${port}`); mutable.origins.push(`http://127.0.0.1:${port}`)
    const clients: Client[] = []
    try {
      for (let i = 0; i < 2; i++) {
        const client = new Client({ name: `p0-synthetic-${i}`, version: '1' }); clients.push(client)
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } })
        await client.connect(transport)
        expect((await client.listTools()).tools.some(t => t.name === 'brain_recent')).toBe(true)
        expect((await client.callTool({ name: 'brain_recent', arguments: { limit: 1 } })).isError).not.toBe(true)
        expect((await send(port, '/mcp', 'GET', { Host: `127.0.0.1:${port}`, 'MCP-Session-Id': transport.sessionId! })).status).toBe(401)
        await transport.terminateSession(); await client.close()
      }
      expect(findRecent).toHaveBeenCalledTimes(2)
      const shell = await send(port, '/', 'GET', { Host: `127.0.0.1:${port}` })
      expect(shell.body).toContain('/static/js/authmain.js')
      expect(shell.body).not.toContain(TOKEN)
      const blocked = await send(port, '/api/import/obsidian/start', 'POST', { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}` })
      expect(blocked.status).toBe(403)
    } finally { for (const c of clients) await c.close(); await closeSessions(); await close(http) }
  })
})
