import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const bin = process.env.OPEN_BRAIN_TEST_PG_BIN
const migrateEntry = new URL('./migrate.ts', import.meta.url).pathname

/** Runs the real `npm run migrate` entry against an isolated socket-only cluster, never a production DSN. */
describe.skipIf(!bin)('migrate on a clean database — real PostgreSQL', () => {
  let root = '', socket = '', home = '', admin: pg.Client
  beforeAll(async () => {
    root = await mkdtemp('/tmp/ob-migrate-'); socket = join(root, 'socket'); home = join(root, 'home')
    await mkdir(socket, { mode: 0o700 }); await mkdir(home, { mode: 0o700 })
    await exec(join(bin!, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale', '--encoding=UTF8'])
    await writeFile(join(root, 'data/postgresql.auto.conf'), `listen_addresses=''\nunix_socket_directories='${socket}'\n`)
    await exec(join(bin!, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'log'), '-w', 'start'])
    admin = new pg.Client({ host: socket, database: 'postgres', user: 'fixture' }); await admin.connect()
    await admin.query('CREATE ROLE app LOGIN NOSUPERUSER')
  }, 30_000)
  afterAll(async () => {
    await admin?.end()
    if (root) { await exec(join(bin!, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop']); console.log(`Migrate fixture retained (stopped): ${root}`) }
  }, 20_000)

  async function database(owner: string): Promise<string> {
    const name = 'test_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE DATABASE "${name}" OWNER "${owner}" TEMPLATE template0`)
    return name
  }
  /** HOME points at the fixture so the default config file is created there, not in the user's home. */
  async function migrate(database: string, user: string): Promise<{ code: number; output: string }> {
    const env = { PATH: process.env.PATH!, HOME: home, DATABASE_URL: `postgresql://${user}@localhost/${database}?host=${encodeURIComponent(socket)}` }
    try {
      const r = await exec(process.execPath, ['--import', 'tsx/esm', migrateEntry], { env, cwd: join(migrateEntry, '../../..'), timeout: 60_000 })
      return { code: 0, output: r.stdout + r.stderr }
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string }
      return { code: e.code ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }
  async function inspect(database: string) {
    const c = new pg.Client({ host: socket, database, user: 'fixture' }); await c.connect()
    try {
      const ext = await c.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)
      const col = await c.query(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = 'thoughts'::regclass AND attname = 'embedding'`)
      const tier = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name = 'tier'`)
      return { extension: ext.rowCount === 1, embedding: col.rows[0]?.type as string | undefined, tiers: tier.rowCount === 1 }
    } finally { await c.end() }
  }

  it('creates pgvector first and migrates a clean database end to end', async () => {
    const db = await database('fixture')
    expect((await inspect(db).catch(() => null))).toBeNull() // no thoughts table yet
    const run = await migrate(db, 'fixture')
    expect(run.code, run.output).toBe(0)
    expect(await inspect(db)).toEqual({ extension: true, embedding: 'vector(1536)', tiers: true })
    const again = await migrate(db, 'fixture')
    expect(again.code, again.output).toBe(0)
  }, 120_000)

  it('needs no privilege when the extension exists (non-superuser production role)', async () => {
    const db = await database('app')
    const c = new pg.Client({ host: socket, database: db, user: 'fixture' }); await c.connect()
    await c.query('CREATE EXTENSION vector'); await c.end()
    const run = await migrate(db, 'app')
    expect(run.code, run.output).toBe(0)
    expect(await inspect(db)).toEqual({ extension: true, embedding: 'vector(1536)', tiers: true })
  }, 120_000)

  it('fails with the fix named when the role cannot create the missing extension', async () => {
    const db = await database('app')
    const run = await migrate(db, 'app')
    expect(run.code).not.toBe(0)
    expect(run.output).toContain('run once as a superuser: CREATE EXTENSION vector')
    const c = new pg.Client({ host: socket, database: db, user: 'fixture' }); await c.connect()
    try { expect((await c.query(`SELECT 1 FROM pg_class WHERE relname = 'thoughts'`)).rowCount).toBe(0) } finally { await c.end() }
  }, 120_000)
})
