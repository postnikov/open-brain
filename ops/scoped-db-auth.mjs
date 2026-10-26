// Explicit operator action: restrict one database/role pair, preserving all other HBA rules.
import { randomBytes, createHash } from 'node:crypto'
import { readFile, writeFile, stat, rename, mkdtemp, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { checksum, atomicJson, withLock, privateDirectory } from '../scripts/backup/lib.mjs'
import { readDatabaseSecret } from '../scripts/database-url.mjs'

const marker = '# Open-Brain scoped SCRAM'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export function scopedHba(original, database, role) {
  if (![database, role].every(s => /^[a-z_][a-z_0-9]*$/.test(s))) throw new Error('Invalid scope')
  if (original.includes(marker)) throw new Error('Scoped rules already present')
  return `${marker}\nlocal ${database} ${role} scram-sha-256\nhost ${database} ${role} 127.0.0.1/32 scram-sha-256\nhost ${database} ${role} ::1/128 scram-sha-256\n\n${original}`
}

export async function replaceHba(path, contents, scratch) {
  await privateDirectory(scratch)
  const mode = (await stat(path)).mode & 0o777
  const dir = await mkdtemp(join(scratch, 'hba-write-'))
  const tmp = join(dir, 'pg_hba.conf')
  await writeFile(tmp, contents, { mode })
  try { await rename(tmp, path) } finally { await rmdir(dir).catch(() => {}) }
}

export async function reloadHba(admin) {
  const before = (await admin.query('SELECT pg_conf_load_time()::text AS time')).rows[0].time
  if (!(await admin.query('SELECT pg_reload_conf() AS ok')).rows[0].ok) throw new Error('Reload refused')
  for (let i = 0; i < 50; i++) {
    await pause(100)
    if ((await admin.query('SELECT pg_conf_load_time()::text AS time')).rows[0].time !== before) return
  }
  throw new Error('Reload acknowledgement timed out')
}

export async function validateHba(admin, database, role) {
  const rows = (await admin.query('SELECT type,database,user_name,address,auth_method,error FROM pg_hba_file_rules ORDER BY line_number')).rows
  if (rows.some(r => r.error)) throw new Error('HBA parser rejected configuration')
  const expected = [['local', null], ['host', '127.0.0.1'], ['host', '::1']]
  for (let i = 0; i < 3; i++) {
    const r = rows[i]
    if (!r || r.type !== expected[i][0] || r.address !== expected[i][1] || r.auth_method !== 'scram-sha-256' || JSON.stringify(r.database) !== JSON.stringify([database]) || JSON.stringify(r.user_name) !== JSON.stringify([role])) throw new Error('Scoped HBA order mismatch')
  }
  return rows.length
}

export function routeUrl(url, route, socket) {
  const u = new URL(url)
  u.searchParams.delete('host')
  u.hostname = route === 'ipv6' ? '[::1]' : route === 'ipv4' ? '127.0.0.1' : 'localhost'
  if (route === 'local') u.searchParams.set('host', socket)
  // Installed pg-connection-string leaves brackets in URL.hostname. Its explicit
  // host parameter supplies the socket/DNS layer with the bare IPv6 address.
  if (route === 'ipv6') u.searchParams.set('host', '::1')
  return u.href
}

async function probe(url, rejectExpected) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 })
  try {
    await c.connect()
    if (rejectExpected) throw new Error('Invalid credential accepted')
    await c.query('BEGIN READ ONLY')
    await c.query("SET LOCAL statement_timeout='5s'")
    await c.query('SELECT 1')
    await c.query('ROLLBACK')
    return true
  } catch (error) {
    if (rejectExpected && error.code === '28P01') return true
    throw new Error(rejectExpected ? 'Negative authentication probe failed' : 'Current credential connection failed')
  } finally { await c.end().catch(() => {}) }
}

export async function authMatrix(current, old, socket) {
  const incorrect = new URL(current); incorrect.password = randomBytes(32).toString('hex')
  const result = []
  for (const route of ['local', 'ipv4', 'ipv6']) {
    result.push({ route,
      currentAccepted: await probe(routeUrl(current, route, socket), false),
      oldRejected: await probe(routeUrl(old, route, socket), true),
      incorrectRejected: await probe(routeUrl(incorrect.href, route, socket), true),
    })
  }
  return result
}

export async function restoreHba(state, admin) {
  if (await checksum(state.backup) !== state.originalSha256) throw new Error('Backup checksum mismatch')
  const liveHash = await checksum(state.hba)
  if (![state.originalSha256, state.appliedSha256].includes(liveHash)) throw new Error('HBA changed outside this operation')
  await replaceHba(state.hba, await readFile(state.backup), state.scratch)
  await reloadHba(admin)
  if (await checksum(state.hba) !== state.originalSha256) throw new Error('Rollback verification failed')
  state.status = 'rolled_back'; state.rolledBackAt = new Date().toISOString()
  return state
}

export async function applyHba(state, admin, verify, persist = async () => {}) {
  if (await checksum(state.backup) !== state.originalSha256 || await checksum(state.hba) !== state.originalSha256) throw new Error('Initial HBA checksum mismatch')
  const original = await readFile(state.hba, 'utf8')
  const next = scopedHba(original, state.database, state.role)
  state.appliedSha256 = createHash('sha256').update(next).digest('hex')
  state.status = 'applying'
  await persist(state) // A crash after replacement must still leave a usable rollback command.
  let changed = false
  try {
    await replaceHba(state.hba, next, state.scratch); changed = true
    if (await checksum(state.hba) !== state.appliedSha256) throw new Error('Applied HBA checksum mismatch')
    await validateHba(admin, state.database, state.role)
    await reloadHba(admin)
    state.reloadedAt = new Date().toISOString()
    state.verification = await verify()
    state.status = 'scram_enforced'
    return state
  } catch {
    if (changed) {
      try { await restoreHba(state, admin) }
      catch { state.status = 'recovery_required'; throw new Error('HBA operation failed; recovery required') }
    }
    throw new Error(changed ? 'HBA operation failed; original rules restored' : 'HBA operation failed before change')
  }
}

async function main() {
  const [action, production, flag, path, ...extra] = process.argv.slice(2)
  if (!['apply', 'rollback', 'verify'].includes(action) || production !== '--production' || flag !== '--state' || !path || extra.length) throw new Error('Invalid operator arguments')
  const root = join(homedir(), '.open-brain/rotations'), stateFile = resolve(path)
  if (!stateFile.startsWith(root + '/')) throw new Error('Invalid state path')
  await withLock(root, 'scoped-db-auth', async () => {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    if (state.database !== 'open_brain' || state.role !== 'open_brain') throw new Error('Unexpected production scope')
    const admin = new pg.Client({ ...state.admin, connectionTimeoutMillis: 5000 })
    try {
      await admin.connect()
      await admin.query("SET statement_timeout='10s'")
      const actual = (await admin.query('SHOW hba_file')).rows[0].hba_file
      if (actual !== state.hba) throw new Error('Unexpected cluster')
      const verify = async () => {
        await validateHba(admin, state.database, state.role)
        const rotation = JSON.parse(await readFile(state.rotationState, 'utf8'))
        const current = readDatabaseSecret(rotation.service), old = readDatabaseSecret(rotation.rollbackService)
        for (const url of [current, old]) {
          const u = new URL(url)
          if (u.pathname !== '/' + state.database || decodeURIComponent(u.username) !== state.role) throw new Error('Credential scope mismatch')
        }
        return authMatrix(current, old, state.socket)
      }
      if (action === 'apply') {
        if (state.status !== 'prepared') throw new Error('State is not prepared')
        // Read credentials before touching HBA, so an unavailable Keychain is a preflight failure.
        const rotation = JSON.parse(await readFile(state.rotationState, 'utf8'))
        readDatabaseSecret(rotation.service); readDatabaseSecret(rotation.rollbackService)
        await applyHba(state, admin, verify, value => atomicJson(stateFile, value))
      } else if (action === 'rollback') await restoreHba(state, admin)
      else state.verification = await verify()
      await atomicJson(stateFile, state)
      console.log(JSON.stringify({ status: state.status, reloadedAt: state.reloadedAt, verification: state.verification, stateFile }))
    } catch {
      await atomicJson(stateFile, state)
      throw new Error('Scoped HBA operation stopped; inspect private state')
    } finally { await admin.end().catch(() => {}) }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077)
  main().catch(() => { console.error('Scoped HBA operation stopped; details suppressed.'); process.exitCode = 1 })
}
