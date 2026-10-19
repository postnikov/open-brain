import { describe, expect, it, vi } from 'vitest'
import { createServer, request } from 'node:http'
import { handleApiRequest } from '../api.js'
import { restClientName } from '../../activity/middleware.js'
import type { AppServices } from '../../bootstrap.js'
import { DEFAULT_CONFIG } from '../../config/defaults.js'

const ID = '11111111-1111-4111-8111-111111111111'

function fakeServices() {
  const log = vi.fn(async () => {})
  const recall = vi.fn(async (_q: string, _o?: unknown) => ({ recall_id: '22222222-2222-4222-8222-222222222222', pointers: [{ id: ID }], total: 1, next: '' }))
  const open = vi.fn(async (_ids: string[], _r?: string, _s?: unknown) => ({ recall_id: null, thoughts: [], missing: [ID], note: '' }))
  const services = { config: DEFAULT_CONFIG, activityLogger: { log }, recallService: { recall, open } } as unknown as AppServices
  return { services, log, recall, open }
}

async function call(services: AppServices, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const server = createServer((req, res) => { void handleApiRequest(req, res, new URL(req.url!, 'http://127.0.0.1'), services) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let text = ''; res.on('data', (c) => { text += c }); res.on('end', () => resolve({ status: res.statusCode!, body: text }))
      })
      req.on('error', reject)
      if (body !== undefined) req.write(JSON.stringify(body))
      req.end()
    })
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('REST recall/open scope and activity', () => {
  it('passes source/tag filters to recall and records the REST call with the client name', async () => {
    const { services, log, recall } = fakeServices()
    const res = await call(services, '/api/recall?q=hello&source=a,b&source=c&tag=x', 'GET', undefined, { 'X-Open-Brain-Client': 'facade' })
    expect(res.status).toBe(200)
    expect(recall).toHaveBeenCalledWith('hello', expect.objectContaining({ scope: { sources: ['a', 'b', 'c'], tags: ['x'] } }))
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'brain_recall', clientName: 'rest:facade', status: 'success' }))
  })

  it('no filter parameter means no scope; an empty one allows nothing', async () => {
    const { services, recall } = fakeServices()
    await call(services, '/api/recall?q=x')
    expect(recall.mock.calls[0]![1]).toMatchObject({ scope: { sources: undefined, tags: undefined } })
    await call(services, '/api/recall?q=x&source=')
    expect(recall.mock.calls[1]![1]).toMatchObject({ scope: { sources: [] } })
  })

  it('open forwards the scope and logs; bad client names are not recorded verbatim', async () => {
    const { services, log, open } = fakeServices()
    const res = await call(services, '/api/open', 'POST', { ids: [ID], sources: ['mc-card'] }, { 'X-Open-Brain-Client': 'bad name; drop' })
    expect(res.status).toBe(200)
    expect(open).toHaveBeenCalledWith([ID], undefined, { sources: ['mc-card'], tags: undefined })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'brain_open', clientName: 'rest:anonymous' }))
    expect(restClientName(undefined)).toBe('rest:anonymous')
    expect(restClientName(['grok', 'x'])).toBe('rest:grok')
  })

  it('a failing recall is logged as an error and still returns an error response', async () => {
    const { services, log, recall } = fakeServices()
    recall.mockRejectedValueOnce(new Error('embedding down'))
    const res = await call(services, '/api/recall?q=x')
    expect(res.status).toBeGreaterThanOrEqual(500)
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', errorMessage: 'embedding down' })))
  })
})
