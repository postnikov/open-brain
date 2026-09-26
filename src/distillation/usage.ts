import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { estimateCost } from './pricing.js'

export const distillationUsage = new AsyncLocalStorage<{ pool: pg.Pool; jobId: string }>()

/** Persist intent before a billable request; a crash/timeout remains explicitly unknown. */
export async function recordAiCall<T extends { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }>(
  phase: string, model: string, call: () => Promise<T>,
): Promise<T> {
  const context = distillationUsage.getStore()
  if (!context) return call()
  const id = randomUUID()
  await context.pool.query('INSERT INTO distillation_ai_calls(id,job_id,phase,model) VALUES($1,$2,$3,$4)', [id,context.jobId,phase,model])
  const result = await call()
  const usage = result.usage
  if (usage) {
    const cost = estimateCost(model, usage.prompt_tokens ?? usage.total_tokens ?? 0, usage.completion_tokens ?? 0)
    await context.pool.query("UPDATE distillation_ai_calls SET status='observed',tokens=$2,estimated_cost=$3 WHERE id=$1", [id,usage.total_tokens ?? null,cost || null])
  }
  return result
}
