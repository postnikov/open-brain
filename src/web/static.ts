import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerResponse } from 'node:http'
import { logger } from '../shared/logger.js'

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static')

// Allowlist instead of filesystem lookup — no path traversal surface
const FILES: Record<string, { readonly file: string; readonly contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/static/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
}

// ES modules under /static/js/ — strict name pattern keeps traversal impossible
const JS_MODULE_RE = /^\/static\/js\/([a-z]+\.js)$/

function resolveFile(pathname: string): { readonly file: string; readonly contentType: string } | null {
  const known = FILES[pathname]
  if (known) {
    return known
  }
  const jsMatch = JS_MODULE_RE.exec(pathname)
  if (jsMatch) {
    return { file: join('js', jsMatch[1]!), contentType: 'application/javascript; charset=utf-8' }
  }
  return null
}

export async function serveStatic(pathname: string, res: ServerResponse, authenticatedShell = false): Promise<boolean> {
  const entry = resolveFile(pathname)
  if (!entry) {
    return false
  }

  try {
    let body = await readFile(join(STATIC_DIR, entry.file))
    if (authenticatedShell && pathname === '/') {
      body = Buffer.from(body.toString('utf8').replace('/static/js/main.js', '/static/js/authmain.js'))
    }
    res.writeHead(200, { 'Content-Type': entry.contentType, 'Cache-Control': 'no-cache' })
    res.end(body)
  } catch (error) {
    logger.error({ err: error, pathname }, 'Failed to serve static asset')
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Failed to read static asset')
  }
  return true
}
