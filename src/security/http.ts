import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface HttpSecurity {
  readonly host: '127.0.0.1'
  readonly port: number
  readonly token: string
  readonly authorities: readonly string[]
  readonly origins: readonly string[]
}

export async function loadHttpSecurity(env: NodeJS.ProcessEnv = process.env): Promise<HttpSecurity> {
  const rawPort = env.PORT ?? '3100'
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('Invalid HTTP port')
  if (env.OPEN_BRAIN_BIND_HOST && env.OPEN_BRAIN_BIND_HOST !== '127.0.0.1') throw new Error('Only IPv4 loopback is supported')
  const path = env.OPEN_BRAIN_HTTP_TOKEN_FILE
  if (!path?.startsWith('/')) throw new Error('OPEN_BRAIN_HTTP_TOKEN_FILE must be an absolute path')
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let token: string
  try {
    const info = await fd.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 128) throw new Error('Auth token must be an owner-only regular file')
    token = (await fd.readFile('utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Auth token must contain 32 random bytes as lowercase hex')
  } finally { await fd.close() }
  const port = Number(rawPort)
  const authorities = [`127.0.0.1:${port}`, `localhost:${port}`]
  return { host: '127.0.0.1', port, token, authorities, origins: authorities.map(h => `http://${h}`) }
}

function oneHeader(req: IncomingMessage, name: string): boolean {
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === name) count++
  return count <= 1
}

/** Runs before URL routing, request body parsing, DB access or MCP session lookup. */
export function guardHttp(req: IncomingMessage, res: ServerResponse, security: HttpSecurity): URL | null {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  const deny = (status: number, message: string): null => {
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="open-brain"')
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
    return null
  }
  if (!oneHeader(req, 'host') || !oneHeader(req, 'origin') || !oneHeader(req, 'authorization')) return deny(400, 'Duplicate security header')
  const host = req.headers.host
  if (!host || !security.authorities.includes(host)) return deny(403, 'Host not allowed')
  const origin = req.headers.origin
  if (origin !== undefined && !security.origins.includes(origin)) return deny(403, 'Origin not allowed')
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) return deny(400, 'Invalid request target')
  const url = new URL(req.url, `http://${host}`)
  if (req.method === 'OPTIONS') {
    if (!origin) return deny(403, 'Origin required for preflight')
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Session-Id, MCP-Protocol-Version',
      'Vary': 'Origin',
    })
    res.end(); return null
  }
  // Only the empty application shell and allowlisted asset names are public.
  const shell = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/static/styles.css' || /^\/static\/js\/[a-z]+\.js$/.test(url.pathname))
  if (!shell) {
    const supplied = req.headers.authorization ?? ''
    const digest = (s: string) => createHash('sha256').update(s).digest()
    if (!timingSafeEqual(digest(supplied), digest(`Bearer ${security.token}`))) return deny(401, 'Authentication required')
  }
  if (url.pathname.startsWith('/api/import/obsidian/')) return deny(403, 'Directory import disabled; upload selected files')
  return url
}
