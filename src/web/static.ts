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
  '/static/app.js': { file: 'app.js', contentType: 'application/javascript; charset=utf-8' },
}

export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const entry = FILES[pathname]
  if (!entry) {
    return false
  }

  try {
    const body = await readFile(join(STATIC_DIR, entry.file))
    res.writeHead(200, { 'Content-Type': entry.contentType, 'Cache-Control': 'no-cache' })
    res.end(body)
  } catch (error) {
    logger.error({ err: error, pathname }, 'Failed to serve static asset')
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Failed to read static asset')
  }
  return true
}
