import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import net from 'node:net'
import pg from 'pg'
import { command, checksum } from '../scripts/backup/lib.mjs'
import { scramVerifier } from './rotate-db-password.mjs'
import { restoreHba } from './scoped-db-auth.mjs'
import { clusterHba, applyCluster, verifyCluster } from './cluster-db-auth.mjs'

const base = 'local all all trust\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\nlocal replication all trust\nhost replication all 127.0.0.1/32 trust\nhost replication all ::1/128 trust\n'
it('removes all trust rules while retaining matching admin peer and replication coverage', () => {
  const result = clusterHba(base, 'admin')
  expect(result).not.toMatch(/\btrust\b/)
  expect(result).toContain('local all admin peer\nlocal all all scram-sha-256')
  expect(result).toContain('local replication admin peer\nlocal replication all scram-sha-256')
  expect(result.match(/scram-sha-256/g)).toHaveLength(6)
})
it('rejects broad-network trust, unexpected methods and incomplete inventory', () => {
  expect(() => clusterHba(base.replace('127.0.0.1/32', '0.0.0.0/0'), 'admin')).toThrow('Unreviewed trust')
  expect(() => clusterHba(base.replace('trust', 'password'), 'admin')).toThrow('Unreviewed HBA')
  expect(() => clusterHba(base.split('\n').slice(1).join('\n'), 'admin')).toThrow('count')
})

const bin = process.env.OPEN_BRAIN_TEST_PG_BIN
describe.skipIf(!bin)('full-cluster authentication on an isolated real PostgreSQL cluster', () => {
  let root, socket, port, admin, state, url, started = false
  const osUser = userInfo().username
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cluster-test-')); socket = join(root, 's'); await mkdir(socket)
    const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port; await new Promise(resolve => server.close(resolve))
    await command(join(bin, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '-U', 'fixture_owner', '--no-locale', '--encoding=UTF8'])
    await writeFile(join(root, 'data/postgresql.auto.conf'), `listen_addresses='localhost'\nport=${port}\nunix_socket_directories='${socket}'\n`)
    await writeFile(join(root, 'data/pg_hba.conf'), base)
    await command(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'postgres.log'), '-w', 'start']); started = true
    admin = new pg.Client({ host: socket, port, database: 'postgres', user: 'fixture_owner' }); await admin.connect()
    await admin.query(`CREATE ROLE "${osUser}" LOGIN SUPERUSER`)
    await admin.query(`CREATE ROLE app_role LOGIN PASSWORD '${scramVerifier('synthetic-current')}'`)
    await admin.query(`CREATE ROLE dormant_role LOGIN PASSWORD '${scramVerifier('synthetic-dormant')}'`)
    await admin.query('CREATE DATABASE appdb OWNER app_role')
    const backup = join(root, 'hba.before'); await writeFile(backup, base)
    state = { hba: join(root, 'data/pg_hba.conf'), backup, originalSha256: await checksum(backup), scratch: join(root, 'writes'), socket,
      admin: { host: socket, port, user: osUser, database: 'postgres' }, adminDatabases: ['postgres', 'appdb'],
      passwordConsumers: [{ role: 'app_role', database: 'appdb', service: 'fixture' }],
      roles: [{ role: osUser, database: 'postgres' }, { role: 'app_role', database: 'appdb' }, { role: 'dormant_role', database: 'postgres' }],
    }
    url = `postgresql://app_role:synthetic-current@localhost:${port}/appdb`
  }, 30000)
  afterAll(async () => {
    await admin?.end()
    if (started) await command(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop'])
    if (root) console.log(`Stopped full-cluster fixture retained: ${root}`)
  })
  it('accepts matching OS admin and current application passwords, rejects incorrect credentials for every role', async () => {
    let persistedBefore = false
    await applyCluster(state, admin, () => verifyCluster(state, () => url), async s => { persistedBefore = s.appliedSha256.length === 64 && await readFile(s.hba, 'utf8') === base })
    expect(persistedBefore).toBe(true)
    expect(state.verification.peer).toHaveLength(2)
    expect(state.verification.passwords).toHaveLength(3)
    expect(state.verification.negatives).toHaveLength(8)
    await restoreHba(state, admin); expect(await readFile(state.hba, 'utf8')).toBe(base)
  })
  it('peer rejects claiming a superuser name different from the real OS username', async () => {
    const other = { ...state, admin: { ...state.admin, user: 'fixture_owner' } }
    await applyCluster(other, admin, async () => {
      const claimed = new pg.Client(other.admin)
      try { await expect(claimed.connect()).rejects.toMatchObject({ code: '28000' }) }
      finally { await claimed.end().catch(() => {}) }
      return { osIdentityMismatchRejected: true }
    })
    await restoreHba(other, admin)
  })
  it('rolls back and reloads on a post-reload consumer refusal', async () => {
    await expect(applyCluster(state, admin, async () => { throw new Error('synthetic refusal') })).rejects.toThrow('HBA restored')
    expect(state.status).toBe('rolled_back'); expect(await readFile(state.hba, 'utf8')).toBe(base)
    const c = new pg.Client({ ...state.admin, host: '127.0.0.1', password: 'wrong' }); await c.connect(); await c.query('SELECT 1'); await c.end()
  })
  it('refuses a corrupt backup before changing authentication', async () => {
    const backup = join(root, 'bad'); await writeFile(backup, 'corrupt')
    await expect(applyCluster({ ...state, backup }, admin, async () => {})).rejects.toThrow('checksum')
    expect(await readFile(state.hba, 'utf8')).toBe(base)
  })
})
