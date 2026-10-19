import { describe, expect, it } from 'vitest'
import { createServer, request } from 'node:http'
import { handleApiRequest } from '../api.js'
import type { AppServices } from '../../bootstrap.js'
import { DEFAULT_CONFIG } from '../../config/defaults.js'

const DAY = 24 * 60 * 60 * 1000

function fakeServices(): AppServices {
  const now = Date.now()
  return {
    config: DEFAULT_CONFIG,
    activityLogger: { log: async () => {} },
    repository: { getStats: async () => ({ total: 1131, last7Days: 42, last30Days: 900, bySource: new Map([['mc-card', 1131]]) }) },
    streamRepository: { getStats: async () => ({ totalBlocks: 10, pendingBlocks: 3, distilledBlocks: 7, pinnedBlocks: 0 }) },
    distillationRepo: {
      getRecentRuns: async () => [
        { createdAt: new Date(now - 2 * DAY), estimatedCost: 0.125 },
        { createdAt: new Date(now - 10 * DAY), estimatedCost: 0.5 },
        { createdAt: new Date(now - 40 * DAY), estimatedCost: 9 }, // older than 30 days — not counted
      ],
    },
  } as unknown as AppServices
}

async function get(services: AppServices, path: string) {
  const server = createServer((req, res) => { void handleApiRequest(req, res, new URL(req.url!, 'http://127.0.0.1'), services) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let text = ''; res.on('data', (c) => { text += c }); res.on('end', () => resolve({ status: res.statusCode!, body: text }))
      })
      req.on('error', reject)
      req.end()
    })
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('GET /api/stats/card', () => {
  it('returns a compact { title, items[] } card with the 30-day distillation cost', async () => {
    const res = await get(fakeServices(), '/api/stats/card')
    expect(res.status).toBe(200)
    const card = JSON.parse(res.body) as { title: string; items: { label: string; value: string | number }[] }
    expect(typeof card.title).toBe('string')
    expect(card.items.map((i) => i.value)).toEqual([1131, '+42', 3, '$0.63'])
  })
})
