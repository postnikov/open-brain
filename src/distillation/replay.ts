import type { CaptureInput } from '../pipeline/capture.js'
import type { CreateThoughtInput } from '../repository/types.js'
import type { StreamBlock } from '../stream/types.js'
import { distillationResponseSchema } from './prompt.js'
import { RetryStore, type RetryConfig } from './retry-store.js'

export interface ReplayDependencies {
  readonly extract: (blocks: readonly StreamBlock[], config: RetryConfig) => Promise<unknown>
  readonly prepare: (input: CaptureInput) => Promise<CreateThoughtInput>
}

/** Only persistence/retry mechanics: extraction rules and metadata stay with existing callers. */
export async function replayDistillation(store: RetryStore, jobId: string, deps: ReplayDependencies, leaseMs = 60_000) {
  const claim = await store.claim(jobId, leaseMs)
  if (!claim) return { status: 'not-claimed' as const, saved: 0, reused: 0, failed: 0 }
  let leaseLost = false
  const heartbeat = setInterval(() => { void store.renew(claim, leaseMs).catch(() => { leaseLost = true }) }, Math.max(10, Math.floor(leaseMs / 3)))
  let saved = 0, reused = 0, failed = 0
  let failure: string | undefined
  try {
    if (claim.extraction === null) {
      const qualified = claim.blocks.filter(b => b.content.length >= claim.config.minBlockLength)
      const raw = qualified.length ? await deps.extract(qualified, claim.config) : { thoughts: [] }
      const extraction = distillationResponseSchema.parse(raw)
      if (leaseLost) throw new Error('Lease lost')
      await store.saveExtraction(claim, extraction)
    }
    const sourceRef = JSON.stringify({
      session_ids: [...new Set(claim.blocks.filter(b => b.content.length >= claim.config.minBlockLength).map(b => b.sessionId))],
      block_ids: claim.blocks.filter(b => b.content.length >= claim.config.minBlockLength).map(b => b.id),
      distillation_run_id: claim.id,
    })
    for (const item of await store.items(jobId)) {
      if (item.thought_id) { reused++; continue }
      if (leaseLost) throw new Error('Lease lost')
      try {
        const p = item.payload
        const prepared = await deps.prepare({ content: p.content, source: 'distillation', contentType: p.content_type, tags: [...(p.tags ?? []), 'distilled'], sourceRef })
        await store.saveItem(claim, item, prepared)
        saved++
      } catch { failed++ }
    }
    if (!failed) { await store.finish(claim); return { status: 'success' as const, saved, reused, failed } }
    failure = 'capture_failed'
    return { status: 'partial' as const, saved, reused, failed }
  } catch (error) {
    failure = 'extraction_or_commit_failed'
    throw error
  } finally {
    clearInterval(heartbeat)
    await store.release(claim, failure)
  }
}
