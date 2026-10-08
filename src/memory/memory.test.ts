import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema.js'
import { createThoughtsRepository } from '../repository/thoughts.js'
import type { ThoughtsRepository } from '../repository/types.js'
import { createRecallService } from './recall.js'
import { shortRef, sourceState } from './source.js'
import { DEFAULT_CONFIG } from '../config/defaults.js'

const exec = promisify(execFile)
const bin = process.env.OPEN_BRAIN_TEST_PG_BIN
const sqlFile = (name: string) => readFile(new URL(`../../ops/sql/${name}`, import.meta.url), 'utf8')
const tx = (body: string) => `BEGIN;\n${body}\nCOMMIT;`

/** Deterministic 1536-d embeddings: same axis = similar, different axis = orthogonal. */
function vec(axis: number, noise = 0): number[] {
  const v = new Array(1536).fill(0)
  v[axis] = 1
  if (noise) v[axis + 1] = noise
  return v
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key))
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => k === key || hasKeyDeep(v, key))
  return false
}

describe('source helpers', () => {
  it('shortens file and distillation references without leaking text', () => {
    expect(shortRef('{"session_ids":["s1","s2"],"block_ids":["b"],"distillation_run_id":"12345678-aaaa"}')).toBe('session:s1 +1 · run:12345678')
    expect(shortRef('{"distillation_run_id" : "abcdef12-0000", "legacy" : true}')).toBe('run:abcdef12 · legacy')
    expect(shortRef('unattributed:cli')).toBe('unattributed:cli')
  })
  it('reports live, changed and missing source files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ob-src-'))
    const file = join(dir, 'Note.md')
    await writeFile(file, '  Same text \n')
    expect(await sourceState(file, 'Same text')).toEqual({ sourceLive: true, sourceChanged: false })
    expect(await sourceState(file, 'Older text')).toEqual({ sourceLive: true, sourceChanged: true })
    expect(await sourceState(join(dir, 'Gone.md'), 'x')).toEqual({ sourceLive: false, sourceChanged: null })
    expect(await sourceState('session:abc', 'x')).toEqual({ sourceLive: null, sourceChanged: null })
  })
})

describe('recall service — pointers never carry text', () => {
  it('has no content key at any depth and caps the limit at 10', async () => {
    const recall = vi.fn(async () => [{ id: 'i', title: 'T', date: new Date('2026-10-01'), contentType: 'decision', tier: 'pointer' as const, source: 's', sourceRef: '/x/Note.md', status: 'active' as const, score: 0.9 }])
    const service = createRecallService({ embed: async () => vec(1) } as never, { recall } as unknown as ThoughtsRepository, DEFAULT_CONFIG.memory)
    const out = await service.recall('q', { limit: 50 })
    expect(hasKeyDeep(out, 'content')).toBe(false)
    expect(out.pointers[0]).toMatchObject({ id: 'i', date: '2026-10-01', type: 'decision', status: 'active' })
    expect(recall).toHaveBeenCalledWith(expect.any(Array), 10, DEFAULT_CONFIG.memory.recall_min_similarity, DEFAULT_CONFIG.memory.hot_boost, false)
  })
})

describe.skipIf(!bin)('memory tiers — real PostgreSQL', () => {
  let root = '', socket = '', admin: pg.Client
  const pools: pg.Pool[] = []
  beforeAll(async () => {
    root = await mkdtemp('/tmp/ob-memory-'); socket = join(root, 'socket')
    await mkdir(socket, { mode: 0o700 })
    await exec(join(bin!, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale', '--encoding=UTF8'])
    await writeFile(join(root, 'data/postgresql.auto.conf'), `listen_addresses=''\nunix_socket_directories='${socket}'\n`)
    await exec(join(bin!, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'log'), '-w', 'start'])
    admin = new pg.Client({ host: socket, database: 'postgres', user: 'fixture' }); await admin.connect()
  }, 20_000)
  afterAll(async () => {
    for (const p of pools) await p.end()
    await admin?.end()
    if (root) { await exec(join(bin!, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop']); console.log(`Memory fixture retained (stopped): ${root}`) }
  }, 20_000)

  /** Schema as production had it before this migration. */
  async function legacyDatabase(): Promise<pg.Pool> {
    const database = 'test_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
    const pool = new pg.Pool({ host: socket, database, user: 'fixture' }); pools.push(pool)
    await pool.query('CREATE EXTENSION vector')
    const migration = await readFile(new URL('../db/migrate.ts', import.meta.url), 'utf8')
    for (const match of migration.matchAll(/const [A-Z0-9_]+_SQL = `([\s\S]*?)`/g)) await pool.query(match[1]!)
    await pool.query(await sqlFile('distillation-retry.sql'))
    return pool
  }
  async function migrated(): Promise<{ pool: pg.Pool; repo: ThoughtsRepository }> {
    const pool = await legacyDatabase()
    await pool.query(tx(await sqlFile('memory-tiers.sql')))
    return { pool, repo: createThoughtsRepository(drizzle(pool, { schema })) }
  }
  const save = (repo: ThoughtsRepository, content: string, axis: number, extra: Record<string, unknown> = {}) =>
    repo.create({ content, source: 'test', sourceRef: `session:${content}`, title: content, tags: ['t'], embedding: vec(axis), ...extra })

  it('backfills legacy NULL source_ref honestly, validates, and rolls back by its own markers', async () => {
    const pool = await legacyDatabase()
    const ins = async (source: string, ref: string | null) => (await pool.query(
      'INSERT INTO thoughts(content,source,source_ref,embedding) VALUES($1,$2,$3,$4::vector) RETURNING id', [`${source} text`, source, ref, JSON.stringify(vec(3))])).rows[0].id as string
    const distilled = await ins('distillation', null)
    const orphanDistilled = await ins('distillation', null)
    const cli = await ins('cli', null)
    const note = await ins('obsidian', '/vault/Knowledge/Note.md')
    const modern = await ins('distillation', '{"session_ids":["s"],"block_ids":["b"],"distillation_run_id":"r"}')
    const run = (await pool.query("INSERT INTO distillation_log(trigger,status,thought_ids) VALUES('cron','success',$1) RETURNING id", [[distilled]])).rows[0].id as string
    const before = (await pool.query('SELECT id, content, source_ref FROM thoughts ORDER BY id')).rows

    await pool.query(tx(await sqlFile('memory-tiers.sql')))
    const ref = async (id: string) => (await pool.query('SELECT source_ref, tier FROM thoughts WHERE id=$1', [id])).rows[0]
    expect(JSON.parse((await ref(distilled)).source_ref)).toEqual({ distillation_run_id: run, legacy: true })
    expect((await ref(orphanDistilled)).source_ref).toBe('unattributed:distillation')
    expect((await ref(cli)).source_ref).toBe('unattributed:cli')
    expect(await ref(note)).toEqual({ source_ref: '/vault/Knowledge/Note.md', tier: 'source' })
    expect((await ref(modern)).tier).toBe('pointer')
    expect((await pool.query("SELECT count(*)::int AS n FROM thoughts WHERE source_ref IS NULL")).rows[0].n).toBe(0)
    expect((await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='thoughts_source_ref_required'")).rows[0].convalidated).toBe(true)
    await expect(pool.query("INSERT INTO thoughts(content,source) VALUES('x','api')")).rejects.toThrow(/thoughts_source_ref_required/)

    await pool.query(tx(await sqlFile('memory-tiers.sql'))) // idempotent
    await pool.query(tx(await sqlFile('memory-tiers-rollback.sql')))
    expect((await pool.query('SELECT id, content, source_ref FROM thoughts ORDER BY id')).rows).toEqual(before)
    await pool.query(tx(await sqlFile('memory-tiers.sql'))) // re-apply after rollback
    expect((await pool.query("SELECT count(*)::int AS n FROM thoughts WHERE source_ref IS NULL")).rows[0].n).toBe(0)
  })

  it('supersedes explicitly: the old thought disappears from every default read and comes back on demand', async () => {
    const { repo } = await migrated()
    const old = await save(repo, 'decision v1', 10)
    const other = await save(repo, 'unrelated', 20)
    const v2 = await repo.createSuperseding({ content: 'decision v2', source: 'test', sourceRef: 'session:v2', title: 'decision v2', tags: ['t'], embedding: vec(10, 0.01) }, { supersedes: old.id, reason: 'changed' })
    expect(v2.supersedes).toBe(old.id)
    const marked = (await repo.findById(old.id))!
    expect(marked).toMatchObject({ supersededBy: v2.id, supersedeReason: 'changed', content: 'decision v1' })

    const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id)
    const search = await repo.search(vec(10), 10, 0.1)
    expect(ids(search.map((r) => r.thought))).not.toContain(old.id)
    expect(ids(search.map((r) => r.thought))).toContain(v2.id)
    expect(ids(await repo.findRecent(10))).not.toContain(old.id)
    expect(ids((await repo.findRelated(v2.id, 10)).map((r) => r.thought))).not.toContain(old.id)
    expect(ids(await repo.recall(vec(10), 10, 0.1, 0.05))).not.toContain(old.id)
    expect(ids((await repo.searchTimeline(vec(10), 10, 0.1)).map((r) => r.thought))).not.toContain(old.id)
    expect((await repo.findDuplicates(0.5, 10)).length).toBe(0)
    expect((await repo.getStats()).total).toBe(2)
    expect(ids((await repo.search(vec(10), 10, 0.1, { includeInactive: true })).map((r) => r.thought))).toContain(old.id)
    const inactive = await repo.recall(vec(10), 10, 0.1, 0.05, true)
    expect(inactive.find((p) => p.id === old.id)?.status).toBe('superseded')

    await expect(repo.createSuperseding({ content: 'v3', source: 'test', sourceRef: 'x', embedding: vec(10) }, { supersedes: old.id })).rejects.toThrow(/already superseded/)
    await repo.unsupersede(old.id)
    expect(ids(await repo.findRecent(10))).toContain(old.id)
    expect(ids(await repo.findRecent(10))).toContain(other.id)
  })

  it('hides expired thoughts by valid_to and merges without deleting', async () => {
    const { repo } = await migrated()
    const expired = await save(repo, 'temporary rule', 30, { validTo: new Date(Date.now() - 1000) })
    const future = await save(repo, 'until next cohort', 31, { validTo: new Date(Date.now() + 86_400_000) })
    expect((await repo.findRecent(10)).map((t) => t.id)).toEqual([future.id])
    const a = await save(repo, 'dup a', 40), b = await save(repo, 'dup b', 40)
    await repo.mergeThoughts(a.id, b.id)
    expect(await repo.findById(b.id)).toMatchObject({ supersededBy: a.id, supersedeReason: 'merged duplicate' })
    expect((await repo.findRecent(10)).map((t) => t.id)).not.toContain(b.id)
    expect(expired.validTo).not.toBeNull()
  })

  it('recall returns pointers without text, open counts, and consolidation moves tiers', async () => {
    const { pool, repo } = await migrated()
    const t = await save(repo, 'secret body text', 50, { title: 'Pointer title', sourceRef: 'session:s-50' })
    const service = createRecallService({ embed: async () => vec(50) } as never, repo, DEFAULT_CONFIG.memory)
    const recalled = await service.recall('anything')
    expect(recalled.pointers.map((p) => p.id)).toEqual([t.id])
    expect(JSON.stringify(recalled)).not.toContain('secret body text')
    expect(hasKeyDeep(recalled, 'content')).toBe(false)

    const opened = await service.open([t.id, t.id, randomUUID()], recalled.recall_id)
    expect(opened.thoughts).toHaveLength(1)
    expect(opened.thoughts[0]).toMatchObject({ content: 'secret body text', source_ref: 'session:s-50', source_live: null })
    expect(opened.missing).toHaveLength(1)
    await service.open([t.id])
    const policy = { hotMinOpens: 2, hotWindowDays: 14, coolAfterDays: 30 }
    const contradiction = await save(repo, 'position changed', 60, { contentType: 'contradiction' })
    expect(await repo.refreshTiers(policy)).toEqual({ promoted: 1, demoted: 0, candidatesTagged: 1 })
    expect((await repo.findById(t.id))!.tier).toBe('hot')
    expect((await repo.findById(contradiction.id))!.tags).toContain('supersede-candidate')
    expect(await repo.refreshTiers(policy)).toEqual({ promoted: 0, demoted: 0, candidatesTagged: 0 })
    await pool.query("UPDATE thoughts SET last_opened_at = now() - interval '40 days' WHERE id = $1", [t.id])
    expect((await repo.refreshTiers(policy)).demoted).toBe(1)
  })
})
