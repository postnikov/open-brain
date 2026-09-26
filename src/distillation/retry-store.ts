import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { StreamBlock } from '../stream/types.js'
import type { CreateThoughtInput } from '../repository/types.js'
import type { DistillationResponse } from './prompt.js'

export type ExtractedThought = DistillationResponse['thoughts'][number]
export interface RetryConfig { minBlockLength: number; model: string; temperature: number; trigger?: string }
export interface RetryClaim { id: string; owner: string; generation: string; blocks: StreamBlock[]; config: RetryConfig; extraction: DistillationResponse | null }
export interface RetryItem { id: string; payload: ExtractedThought; thought_id: string | null }
const fingerprint = (block: StreamBlock) => createHash('sha256').update(JSON.stringify({
  id: block.id, sessionId: block.sessionId, blockNumber: block.blockNumber, content: block.content,
  topic: block.topic, participants: block.participants, sourceClient: block.sourceClient,
})).digest('hex')

export const DEFAULT_RETRY_POLICY = { baseDelayMs: 60_000, maxDelayMs: 3_600_000, maxAttempts: 8 }

/** Durable replay, reservations and persisted bounded retry scheduling. */
export class RetryStore {
  constructor(readonly pool: pg.Pool, readonly policy = DEFAULT_RETRY_POLICY) {}

  async reserveNext(limit: number, config: RetryConfig, retriesOnly = false): Promise<string | null> {
    return this.transaction(async c => {
      // Serialize batch selection only; never hold this lock across AI calls.
      await c.query('SELECT pg_advisory_xact_lock(732941, 3)')
      const due = await c.query(`SELECT id FROM distillation_retry_jobs WHERE state<>'complete' AND NOT blocked
        AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY next_attempt_at,id LIMIT 1`)
      if (due.rows[0]) return due.rows[0].id
      if (retriesOnly) return null
      const { rows } = await c.query(`SELECT s.* FROM stream s WHERE distilled_at IS NULL AND NOT pinned
        AND NOT EXISTS(SELECT 1 FROM distillation_retry_inputs i WHERE i.block_id=s.id)
        ORDER BY created_at,id LIMIT $1 FOR UPDATE OF s`, [limit])
      if (!rows.length) return null
      const id = randomUUID(), blocks = rows.map(toBlock).sort((a,b) => a.id.localeCompare(b.id))
      await c.query('INSERT INTO distillation_retry_jobs(id,input_snapshot,config_snapshot) VALUES($1,$2,$3)', [id, JSON.stringify(blocks), JSON.stringify(config)])
      for (const b of blocks) await c.query('INSERT INTO distillation_retry_inputs(block_id,job_id,input_hash) VALUES($1,$2,$3)', [b.id,id,fingerprint(b)])
      return id
    })
  }

  async status() {
    return (await this.pool.query(`SELECT id,state,blocked,attempts,next_attempt_at,lease_until,last_error,
      (SELECT count(*)::int FROM distillation_retry_items i WHERE i.job_id=j.id AND thought_id IS NULL) AS remaining_items,
      (SELECT COALESCE(sum(tokens),0)::int FROM distillation_ai_calls a WHERE a.job_id=j.id) AS observed_tokens,
      (SELECT COALESCE(sum(estimated_cost),0) FROM distillation_ai_calls a WHERE a.job_id=j.id) AS known_estimated_cost,
      (SELECT count(*)::int FROM distillation_ai_calls a WHERE a.job_id=j.id AND (status<>'observed' OR estimated_cost IS NULL)) AS unknown_usage_calls
      FROM distillation_retry_jobs j WHERE state<>'complete' ORDER BY created_at LIMIT 100`)).rows
  }

  private async transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect()
    try { await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='10s'"); const result = await fn(c); await c.query('COMMIT'); return result }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
    finally { c.release() }
  }

  /** Reserve immutable snapshots before extraction; overlapping jobs fail atomically. */
  async create(blockIds: readonly string[], config: RetryConfig): Promise<string> {
    if (!blockIds.length || new Set(blockIds).size !== blockIds.length || blockIds.length > 1000) throw new Error('Invalid input batch')
    const id = randomUUID()
    await this.transaction(async c => {
      const { rows } = await c.query('SELECT * FROM stream WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [blockIds])
      if (rows.length !== blockIds.length || rows.some(b => b.distilled_at || b.pinned)) throw new Error('Input missing or not pending')
      const blocks = rows.map(toBlock)
      await c.query('INSERT INTO distillation_retry_jobs(id,input_snapshot,config_snapshot) VALUES($1,$2,$3)', [id, JSON.stringify(blocks), JSON.stringify(config)])
      for (const b of blocks) await c.query('INSERT INTO distillation_retry_inputs(block_id,job_id,input_hash) VALUES($1,$2,$3)', [b.id, id, fingerprint(b)])
    })
    return id
  }

  async claim(id: string, leaseMs: number): Promise<RetryClaim | null> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Invalid lease')
    await this.pool.query(`UPDATE distillation_retry_jobs SET blocked=true,last_error='attempts_exhausted'
      WHERE id=$1 AND state<>'complete' AND attempts >= $2 AND (lease_until IS NULL OR lease_until<=now())`, [id, this.policy.maxAttempts])
    const owner = randomUUID()
    const { rows } = await this.pool.query(`UPDATE distillation_retry_jobs SET lease_owner=$2,lease_until=now()+$3::double precision*interval '1 millisecond',generation=generation+1,attempts=attempts+1
      WHERE id=$1 AND state<>'complete' AND NOT blocked AND next_attempt_at<=now()
      AND (lease_until IS NULL OR lease_until<=now()) RETURNING *`, [id, owner, leaseMs])
    const r = rows[0]
    return r ? { id, owner, generation: r.generation, blocks: r.input_snapshot, config: r.config_snapshot, extraction: r.extraction } : null
  }
  async renew(claim: RetryClaim, leaseMs: number): Promise<void> {
    const r = await this.pool.query(`UPDATE distillation_retry_jobs SET lease_until=now()+$4::double precision*interval '1 millisecond'
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND lease_until>now()`, [claim.id, claim.owner, claim.generation, leaseMs])
    if (!r.rowCount) throw new Error('Lease lost')
  }
  private async fence(c: pg.PoolClient, claim: RetryClaim): Promise<void> {
    const r = await c.query(`SELECT id FROM distillation_retry_jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND lease_until>now() AND state<>'complete' FOR UPDATE`, [claim.id, claim.owner, claim.generation])
    if (!r.rowCount) throw new Error('Lease lost or already complete')
  }
  async saveExtraction(claim: RetryClaim, extraction: DistillationResponse): Promise<void> {
    await this.transaction(async c => {
      await this.fence(c, claim)
      const { rows } = await c.query('SELECT extraction FROM distillation_retry_jobs WHERE id=$1', [claim.id])
      if (rows[0].extraction !== null) throw new Error('Extraction already persisted')
      await c.query("UPDATE distillation_retry_jobs SET extraction=$2,state='ready' WHERE id=$1", [claim.id, JSON.stringify(extraction)])
      for (const [index, payload] of extraction.thoughts.entries()) {
        await c.query('INSERT INTO distillation_retry_items(id,job_id,item_index,payload) VALUES($1,$2,$3,$4)', [randomUUID(), claim.id, index, JSON.stringify(payload)])
      }
    })
  }
  async items(id: string): Promise<RetryItem[]> {
    return (await this.pool.query('SELECT id,payload,thought_id FROM distillation_retry_items WHERE job_id=$1 ORDER BY item_index', [id])).rows
  }
  async saveItem(claim: RetryClaim, item: RetryItem, prepared: CreateThoughtInput): Promise<string> {
    return this.transaction(async c => {
      await this.fence(c, claim)
      const row = (await c.query('SELECT thought_id,payload FROM distillation_retry_items WHERE id=$1 AND job_id=$2 FOR UPDATE', [item.id, claim.id])).rows[0]
      if (!row) throw new Error('Unknown item')
      if (row.thought_id) return row.thought_id // Includes tombstones for deliberately deleted thoughts.
      if (prepared.content !== row.payload.content || prepared.source !== 'distillation') throw new Error('Prepared payload differs from saved extraction')
      const result = await c.query(`INSERT INTO thoughts(content,source,content_type,source_ref,title,tags,topics,sentiment,embedding,thought_at,content_hash,distillation_item_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10,$11,$12)
        ON CONFLICT (distillation_item_id) WHERE distillation_item_id IS NOT NULL DO NOTHING RETURNING id`,
      [prepared.content, prepared.source, prepared.contentType ?? 'thought', prepared.sourceRef ?? null, prepared.title ?? null, prepared.tags ?? null, prepared.topics ?? null, prepared.sentiment ?? null, prepared.embedding ? JSON.stringify(prepared.embedding) : null, prepared.thoughtAt ?? null, prepared.contentHash ?? null, item.id])
      const thoughtId = result.rows[0]?.id ?? (await c.query('SELECT id FROM thoughts WHERE distillation_item_id=$1', [item.id])).rows[0]?.id
      if (!thoughtId) throw new Error('Missing idempotent outcome')
      await c.query('UPDATE distillation_retry_items SET thought_id=$2 WHERE id=$1', [item.id, thoughtId])
      return thoughtId
    })
  }
  async finish(claim: RetryClaim): Promise<void> {
    await this.transaction(async c => {
      await this.fence(c, claim)
      const missing = await c.query('SELECT id FROM distillation_retry_items WHERE job_id=$1 AND thought_id IS NULL LIMIT 1', [claim.id])
      if (missing.rowCount) throw new Error('Incomplete capture')
      const job = (await c.query('SELECT extraction FROM distillation_retry_jobs WHERE id=$1', [claim.id])).rows[0]
      if (job.extraction === null) throw new Error('Missing extraction')
      const inputIds = claim.blocks.map(b => b.id)
      const live = (await c.query('SELECT * FROM stream WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [inputIds])).rows.map(toBlock)
      if (live.length !== claim.blocks.length || live.some((b, i) => fingerprint(b) !== fingerprint(claim.blocks[i]!) || b.pinned || b.distilledAt)) throw new Error('Input changed or disappeared; retain job for review')
      const ids = (await c.query('SELECT thought_id FROM distillation_retry_items WHERE job_id=$1 ORDER BY item_index', [claim.id])).rows.map(r => r.thought_id)
      const qualified = claim.blocks.filter(b => b.content.length >= claim.config.minBlockLength)
      await c.query('UPDATE stream SET distilled_at=now(),distillation_run_id=$2 WHERE id=ANY($1::uuid[])', [inputIds, claim.id])
      await c.query(`INSERT INTO distillation_log(id,trigger,status,blocks_processed,sessions_processed,thoughts_created,thought_ids,blocks_skipped,skip_reasons,tokens_used,estimated_cost,duration_ms)
        SELECT $1,$8,'success',$2,$3,$4,$5,$6,$7,
        COALESCE((SELECT sum(tokens) FROM distillation_ai_calls WHERE job_id=$1),0),
        COALESCE((SELECT sum(estimated_cost) FROM distillation_ai_calls WHERE job_id=$1),0),
        LEAST(2147483647,EXTRACT(epoch FROM now()-created_at)*1000)::int FROM distillation_retry_jobs WHERE id=$1`,
        [claim.id, qualified.length, new Set(qualified.map(b => b.sessionId)).size, ids.length, ids, claim.blocks.length - qualified.length, JSON.stringify({ too_short: claim.blocks.length - qualified.length }), claim.config.trigger ?? 'retry'])
      await c.query("UPDATE distillation_retry_jobs SET state='complete',completed_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1", [claim.id])
    })
  }
  async release(claim: RetryClaim, failure?: string): Promise<void> {
    await this.pool.query(`UPDATE distillation_retry_jobs SET lease_owner=NULL,lease_until=NULL,state=CASE WHEN extraction IS NULL THEN 'pending' ELSE 'partial' END
      ,next_attempt_at=CASE WHEN $4::text IS NULL THEN next_attempt_at ELSE now()+LEAST($6::double precision,$5::double precision*power(2,LEAST(attempts-1,30)))*interval '1 millisecond' END,
      blocked=CASE WHEN $4::text IS NULL THEN blocked ELSE attempts >= $7 END,last_error=$4
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND state<>'complete'`,
      [claim.id, claim.owner, claim.generation, failure ?? null, this.policy.baseDelayMs, this.policy.maxDelayMs, this.policy.maxAttempts])
  }
}
function toBlock(r: Record<string, any>): StreamBlock {
  return { id: r.id, sessionId: r.session_id, blockNumber: r.block_number, topic: r.topic, content: r.content, participants: r.participants, sourceClient: r.source_client, pinned: r.pinned, distilledAt: r.distilled_at, distillationRunId: r.distillation_run_id, createdAt: r.created_at, expiresAt: r.expires_at }
}
