import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppServices } from '../bootstrap.js'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const EPISTEMIC_STATUSES = ['hypothesis', 'conviction', 'fact', 'outdated', 'question'] as const

export interface RouteContext {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly url: URL
  readonly params: Record<string, string>
  readonly services: AppServices
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>

export interface Route {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly pattern: string
  readonly handler: RouteHandler
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
  })
  res.end(JSON.stringify(data))
}

export async function parseJsonBody(req: IncomingMessage, maxSize = 1024 * 64): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let destroyed = false

    req.on('data', (chunk: Buffer) => {
      if (destroyed) return
      size += chunk.length
      if (size > maxSize) {
        destroyed = true
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (destroyed) return
      try {
        const body = Buffer.concat(chunks).toString('utf-8')
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })

    req.on('error', reject)
  })
}

export function matchPath(pathname: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split('/')
  const pathParts = pathname.split('/')
  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const pat = patternParts[i]
    const val = pathParts[i]
    if (pat && pat.startsWith(':')) {
      params[pat.slice(1)] = val ?? ''
    } else if (pat !== val) {
      return null
    }
  }
  return params
}

export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = parseInt(raw ?? '', 10)
  return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, min), max)
}

export function clampFloat(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = parseFloat(raw ?? '')
  return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, min), max)
}

export function isValidUuid(id: string): boolean {
  return UUID_RE.test(id)
}

export function thoughtToJson(t: { id: string; content: string; title: string | null; tags: readonly string[] | null; source: string; sourceRef: string | null; contentType: string; weight: number; epistemicStatus: string | null; createdAt: Date | null; compostedAt?: Date | null }) {
  return {
    id: t.id,
    content: t.content,
    title: t.title,
    tags: t.tags,
    source: t.source,
    source_ref: t.sourceRef,
    content_type: t.contentType,
    weight: t.weight,
    epistemic_status: t.epistemicStatus,
    created_at: t.createdAt?.toISOString() ?? null,
  }
}
