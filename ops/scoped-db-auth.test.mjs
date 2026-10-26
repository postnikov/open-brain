import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import pg from 'pg'
import { parse } from 'pg-connection-string'
import { command, checksum } from '../scripts/backup/lib.mjs'
import { scramVerifier } from './rotate-db-password.mjs'
import { scopedHba, applyHba, restoreHba, authMatrix, routeUrl } from './scoped-db-auth.mjs'

const base = 'local all all trust\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n'
it('prepends exactly three pair-specific rules and preserves every existing byte', () => {
  const actual = scopedHba(base, 'open_brain', 'open_brain')
  expect(actual.endsWith(base)).toBe(true)
  expect(actual.slice(0, -base.length)).toBe('# Open-Brain scoped SCRAM\nlocal open_brain open_brain scram-sha-256\nhost open_brain open_brain 127.0.0.1/32 scram-sha-256\nhost open_brain open_brain ::1/128 scram-sha-256\n\n')
})
it('rejects scope injection', () => {
  expect(() => scopedHba(base, 'open_brain\nlocal all all trust', 'open_brain')).toThrow('Invalid scope')
})
it('refuses duplicate blocks', () => {
  expect(() => scopedHba(scopedHba(base, 'open_brain', 'open_brain'), 'open_brain', 'open_brain')).toThrow('already present')
})
it('passes a bare IPv6 address to the installed pg URL parser', () => {
  const parsed = parse(routeUrl('postgresql://fixture:synthetic@localhost:12345/fixture', 'ipv6', '/fixture'))
  expect(parsed.host).toBe('::1')
  expect(parsed.port).toBe('12345')
})

const bin = process.env.OPEN_BRAIN_TEST_PG_BIN
describe.skipIf(!bin)('scoped HBA on isolated real PostgreSQL', () => {
  let root, socket, port, admin, state, current, old, started = false
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hba-test-')); socket = join(root, 's'); await mkdir(socket)
    const server = net.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port
    await new Promise(resolve => server.close(resolve))
    await command(join(bin, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '-U', 'fixture_admin', '--no-locale', '--encoding=UTF8'])
    await writeFile(join(root, 'data/postgresql.auto.conf'), `listen_addresses='localhost'\nport=${port}\nunix_socket_directories='${socket}'\n`)
    await writeFile(join(root, 'data/pg_hba.conf'), base)
    await command(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'postgres.log'), '-w', 'start']); started = true
    admin = new pg.Client({ host: socket, port, database: 'postgres', user: 'fixture_admin' }); await admin.connect()
    await admin.query(`CREATE ROLE open_brain LOGIN PASSWORD '${scramVerifier('synthetic-current')}'`)
    await admin.query('CREATE ROLE unrelated LOGIN')
    await admin.query('CREATE DATABASE open_brain OWNER open_brain')
    await admin.query('CREATE DATABASE unrelated OWNER unrelated')
    current = `postgresql://open_brain:synthetic-current@localhost:${port}/open_brain`
    old = `postgresql://open_brain:synthetic-old@localhost:${port}/open_brain`
    const backup = join(root, 'pg_hba.before'); await writeFile(backup, base)
    state = { hba: join(root, 'data/pg_hba.conf'), backup, originalSha256: await checksum(backup), database: 'open_brain', role: 'open_brain', scratch: join(root, 'writes') }
  }, 30000)
  afterAll(async () => {
    await admin?.end()
    if (started) await command(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop'])
    if (root) console.log(`Stopped scoped-auth fixture retained: ${root}`)
  })
  it('enforces all three routes, leaves other database/role pairs on trust, and rolls back', async () => {
    let persistedBeforeReplacement = false
    const result = await applyHba(state, admin, () => authMatrix(current, old, socket), async s => {
      persistedBeforeReplacement = s.status === 'applying' && s.appliedSha256.length === 64 && await readFile(s.hba, 'utf8') === base
    })
    expect(persistedBeforeReplacement).toBe(true)
    expect(result.verification).toHaveLength(3)
    for (const route of ['local', 'ipv4', 'ipv6']) {
      for (const [role, database] of [['unrelated', 'unrelated'], ['open_brain', 'unrelated'], ['unrelated', 'open_brain']]) {
        const url = routeUrl(`postgresql://${role}:incorrect@localhost:${port}/${database}`, route, socket)
        const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query('SELECT 1'); await c.end()
      }
    }
    await restoreHba(state, admin)
    expect(await readFile(state.hba, 'utf8')).toBe(base)
    expect(state.status).toBe('rolled_back')
  })
  it('restores original HBA and reloads when a consumer check refuses', async () => {
    await expect(applyHba(state, admin, async () => { throw new Error('synthetic consumer failure') })).rejects.toThrow('original rules restored')
    expect(await readFile(state.hba, 'utf8')).toBe(base)
    expect(state.status).toBe('rolled_back')
    const c = new pg.Client({ connectionString: routeUrl(old, 'ipv4', socket) })
    await c.connect(); await c.query('SELECT 1'); await c.end()
  })
  it('refuses a corrupt backup before changing the live file', async () => {
    const bad = join(root, 'bad-backup'); await writeFile(bad, 'corrupted')
    await expect(applyHba({ ...state, backup: bad }, admin, async () => {})).rejects.toThrow('checksum mismatch')
    expect(await readFile(state.hba, 'utf8')).toBe(base)
  })
})
