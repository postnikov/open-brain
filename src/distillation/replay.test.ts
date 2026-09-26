import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { RetryStore } from './retry-store.js'
import { replayDistillation } from './replay.js'
import { createCapturePipeline } from '../pipeline/capture.js'
import type { CaptureInput } from '../pipeline/capture.js'
import type { ThoughtsRepository } from '../repository/types.js'
const exec = promisify(execFile)
const bin = process.env.OPEN_BRAIN_TEST_PG_BIN
const config = { minBlockLength: 10, model: 'test-fake', temperature: 0.3 }
const extraction = { thoughts: [{ content: 'First retained decision', content_type: 'decision' }, { content: 'Second retained insight', content_type: 'insight' }] }
const prepare = async (input: CaptureInput) => ({ ...input, embedding: Array(1536).fill(0).map((_, i) => i === 0 ? 1 : 0), title: 'Synthetic test' })

describe.skipIf(!bin)('durable distillation replay — real PostgreSQL, fake AI', () => {
  let root: string, socket: string, admin: pg.Client
  const pools: pg.Pool[] = []
  beforeAll(async () => {
    root = await mkdtemp('/tmp/ob-retry-'); socket = join(root, 'socket'); await mkdir(socket, { mode: 0o700 })
    await exec(join(bin!, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale', '--encoding=UTF8'])
    await writeFile(join(root, 'data/postgresql.auto.conf'), `listen_addresses=''\nunix_socket_directories='${socket}'\n`)
    await exec(join(bin!, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'log'), '-w', 'start'])
    admin = new pg.Client({ host: socket, database: 'postgres', user: 'fixture' }); await admin.connect()
  }, 20_000)
  afterAll(async () => {
    for (const p of pools) await p.end()
    await admin?.end()
    if (root) { await exec(join(bin!, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop']); console.log(`Retry fixture retained (stopped): ${root}`) }
  }, 20_000)
  async function setup(content = 'Synthetic pending source block', count = 1) {
    const database = 'test_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
    const pool = new pg.Pool({ host: socket, database, user: 'fixture' }); pools.push(pool)
    await pool.query('CREATE EXTENSION vector')
    const migration = await readFile(new URL('../db/migrate.ts', import.meta.url), 'utf8')
    for (const match of migration.matchAll(/const [A-Z0-9_]+_SQL = `([\s\S]*?)`/g)) await pool.query(match[1]!)
    await pool.query(await readFile(new URL('../../ops/sql/distillation-retry.sql', import.meta.url), 'utf8'))
    const ids = []
    for (let i = 0; i < count; i++) ids.push((await pool.query("INSERT INTO stream(session_id,block_number,content,expires_at) VALUES($1,$2,$3,now()-interval '1 day') RETURNING id", [database, i, content])).rows[0].id as string)
    const store = new RetryStore(pool, { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 8 })
    return { pool, store, ids, job: await store.create(ids, config), database }
  }
  async function counts(pool: pg.Pool) {
    return (await pool.query('SELECT (SELECT count(*)::int FROM thoughts) AS thoughts,(SELECT count(*)::int FROM stream WHERE distilled_at IS NOT NULL) AS distilled,(SELECT count(*)::int FROM distillation_log) AS logs')).rows[0]
  }
  it('preserves mixed failures, restarts without extraction, and creates exactly A/B once', async () => {
    const { pool, store, job } = await setup()
    const extract = vi.fn(async () => extraction)
    const faulty = vi.fn(async (input: CaptureInput) => { if (input.content.startsWith('Second')) throw new Error('metadata enum request/recommendation'); return prepare(input) })
    expect(await replayDistillation(store, job, { extract, prepare: faulty })).toEqual({ status: 'partial', saved: 1, reused: 0, failed: 1 })
    expect(await counts(pool)).toEqual({ thoughts: 1, distilled: 0, logs: 0 })
    const firstId = (await store.items(job))[0]!.thought_id
    const forbiddenExtract = vi.fn(async () => { throw new Error('Must not re-extract') })
    const restarted = new RetryStore(pool, { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 8 })
    expect(await replayDistillation(restarted, job, { extract: forbiddenExtract, prepare })).toEqual({ status: 'success', saved: 1, reused: 1, failed: 0 })
    expect(forbiddenExtract).not.toHaveBeenCalled(); expect(extract).toHaveBeenCalledOnce()
    expect((await store.items(job))[0]!.thought_id).toBe(firstId)
    expect(await counts(pool)).toEqual({ thoughts: 2, distilled: 1, logs: 1 })
    expect((await replayDistillation(restarted, job, { extract, prepare })).status).toBe('not-claimed')
    expect(await counts(pool)).toEqual({ thoughts: 2, distilled: 1, logs: 1 })
  })
  it('retains all-failed, quota, invalid extraction and malformed item inputs', async () => {
    for (const mode of ['all-failed', 'quota', 'invalid', 'bad-item']) {
      const { pool, store, job } = await setup()
      const extract = async () => {
        if (mode === 'quota') throw new Error('429')
        if (mode === 'invalid') return 'invalid JSON'
        if (mode === 'bad-item') return { thoughts: [{ content: 'bad', content_type: 'request' }] }
        return extraction
      }
      const deps = { extract, prepare: async () => { throw new Error('capture failed') } }
      if (mode === 'all-failed') expect((await replayDistillation(store, job, deps)).status).toBe('partial')
      else await expect(replayDistillation(store, job, deps)).rejects.toThrow()
      expect(await counts(pool)).toEqual({ thoughts: 0, distilled: 0, logs: 0 })
      expect((await pool.query('SELECT count(*)::int AS n FROM stream')).rows[0].n).toBe(1)
    }
  })
  it('terminates valid empty extraction and too-short batches without retry loops', async () => {
    for (const content of ['short', 'Long enough block that contains nothing worth retaining']) {
      const { pool, store, job } = await setup(content)
      const extract = vi.fn(async () => ({ thoughts: [] }))
      expect((await replayDistillation(store, job, { extract, prepare })).status).toBe('success')
      expect(await counts(pool)).toEqual({ thoughts: 0, distilled: 1, logs: 1 })
      expect(extract).toHaveBeenCalledTimes(content === 'short' ? 0 : 1)
    }
  })
  it('fences expired workers and reserves overlapping inputs across independent connections', async () => {
    const { pool, store, job, ids, database } = await setup()
    const otherPool = new pg.Pool({ host: socket, database, user: 'fixture' }); pools.push(otherPool)
    const other = new RetryStore(otherPool)
    await expect(other.create(ids, config)).rejects.toThrow()
    const claims = await Promise.all([store.claim(job, 60_000), other.claim(job, 60_000)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const old = claims.find(Boolean)!
    await pool.query("UPDATE distillation_retry_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job])
    const next = (await other.claim(job, 60_000))!
    await expect(store.saveExtraction(old, extraction as any)).rejects.toThrow('Lease lost')
    await other.saveExtraction(next, extraction as any)
    const item = (await other.items(job))[0]!
    await expect(store.saveItem(old, item, await prepare({ content: item.payload.content, source: 'distillation' }))).rejects.toThrow('Lease lost')
    await other.release(next)
    expect((await replayDistillation(store, job, { extract: async () => { throw new Error() }, prepare })).status).toBe('success')
    expect(await counts(pool)).toEqual({ thoughts: 2, distilled: 1, logs: 1 })
  })
  it('survives commit acknowledgement loss and repeats the same item with the same ID', async () => {
    const { pool, store, job } = await setup()
    const claim = (await store.claim(job, 60_000))!
    await store.saveExtraction(claim, extraction as any)
    const item = (await store.items(job))[0]!
    const input = await prepare({ content: item.payload.content, source: 'distillation' })
    const id = await store.saveItem(claim, item, input) // Commit succeeded; caller loses acknowledgement.
    expect(await store.saveItem(claim, item, input)).toBe(id)
    await store.release(claim)
    expect((await replayDistillation(new RetryStore(pool, { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 8 }), job, { extract: async () => { throw new Error() }, prepare })).status).toBe('success')
    expect(await counts(pool)).toEqual({ thoughts: 2, distilled: 1, logs: 1 })
  })
  it('rolls final mark/log/job transition back together and retries without duplicate thoughts', async () => {
    const { pool, store, job } = await setup()
    await pool.query(`CREATE TABLE injected_fault(enabled boolean); INSERT INTO injected_fault VALUES(true);
      CREATE FUNCTION fail_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT enabled FROM injected_fault) THEN RAISE EXCEPTION 'injected final-log failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_log BEFORE INSERT ON distillation_log FOR EACH ROW EXECUTE FUNCTION fail_log()`)
    await expect(replayDistillation(store, job, { extract: async () => extraction, prepare })).rejects.toThrow('injected')
    expect(await counts(pool)).toEqual({ thoughts: 2, distilled: 0, logs: 0 })
    await pool.query('UPDATE injected_fault SET enabled=false')
    expect(await replayDistillation(store, job, { extract: async () => { throw new Error() }, prepare })).toEqual({ status: 'success', saved: 0, reused: 2, failed: 0 })
    expect(await counts(pool)).toEqual({ thoughts: 2, distilled: 1, logs: 1 })
  })
  it('refuses to mark a changed input as processed', async () => {
    const { pool, store, job, ids } = await setup()
    await expect(pool.query('UPDATE stream SET content=$2 WHERE id=$1', [ids[0], 'New source content changed after reservation'])).rejects.toThrow('immutable')
    // Simulate corruption by a privileged operator, beyond the normal trigger guard.
    await pool.query('ALTER TABLE stream DISABLE TRIGGER protect_stream_distillation')
    await pool.query('UPDATE stream SET content=$2 WHERE id=$1', [ids[0], 'New source content changed after reservation'])
    await expect(replayDistillation(store, job, { extract: async () => extraction, prepare })).rejects.toThrow('Input changed')
    expect(await counts(pool)).toEqual({ thoughts: 2, distilled: 0, logs: 0 })
  })
  it('backs up an unfinished job, restores it, and resumes only the missing item', async () => {
    const { pool, store, job, database } = await setup()
    await replayDistillation(store, job, {
      extract: async () => extraction,
      prepare: async input => { if (input.content.startsWith('Second')) throw new Error('transient'); return prepare(input) },
    })
    const ops = await import(new URL('../../scripts/backup/lib.mjs', import.meta.url).href)
    const directory = join(root, 'backup-roundtrip')
    const c = { directory, restoreDirectory: join(root, 'restore-roundtrip'), pgBin: bin, serverPlist: join(root, 'source.plist'), envFile: join(root, 'source.env'), appConfig: join(root, 'source.json'), minFreeBytes: 0, minBackupIntervalHours: 20, maxBackupHours: 36, maxRestoreHours: 192 }
    await writeFile(c.envFile, '')
    await writeFile(c.appConfig, JSON.stringify({ database: { host: socket, user: 'fixture', database } }))
    await writeFile(c.serverPlist, JSON.stringify({ EnvironmentVariables: {} }))
    await exec('/usr/bin/plutil', ['-convert', 'xml1', c.serverPlist])
    const m = await ops.backup(c)
    expect(m.objects.tables.some((t: { name: string }) => t.name === 'distillation_retry_items')).toBe(true)
    const r = await ops.restore(c)
    expect(r.sha256).toBe(m.sha256)
    await exec(join(bin!, 'pg_ctl'), ['-D', join(r.cluster, 'data'), '-l', join(r.cluster, 'postgres.log'), '-w', 'start'])
    const restoredPool = new pg.Pool({ host: join(r.cluster, 'socket'), user: 'restore_admin', database: 'open_brain_restorecheck' })
    try {
      const resumed = new RetryStore(restoredPool)
      const extract = vi.fn(async () => { throw new Error('Must use persisted extraction') })
      expect(await replayDistillation(resumed, job, { extract, prepare })).toEqual({ status: 'success', saved: 1, reused: 1, failed: 0 })
      expect(extract).not.toHaveBeenCalled()
      expect(await counts(restoredPool)).toEqual({ thoughts: 2, distilled: 1, logs: 1 })
      expect(await counts(pool)).toEqual({ thoughts: 1, distilled: 0, logs: 0 })
    } finally {
      await restoredPool.end()
      await exec(join(bin!, 'pg_ctl'), ['-D', join(r.cluster, 'data'), '-m', 'fast', '-w', 'stop'])
    }
  }, 30_000)
  it('prepares the existing capture metadata/embedding without writing a thought', async () => {
    const create = vi.fn()
    const pipeline = createCapturePipeline({ embed: async () => [1, 0] }, { extract: async () => ({ title: 'Title', content_type: 'note', tags: ['auto'], topics: ['topic'], sentiment: 'neutral' }) }, { create } as unknown as ThoughtsRepository)
    const result = await pipeline.prepare({ content: 'same content', source: 'distillation', contentType: 'insight', tags: ['manual'] })
    expect(result).toMatchObject({ content: 'same content', contentType: 'insight', tags: ['manual'], embedding: [1, 0], title: 'Title' })
    expect(create).not.toHaveBeenCalled()
  })
})
