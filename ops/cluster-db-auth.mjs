// Explicit local-cluster operation; no data/schema changes and no privileged OS actions.
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { checksum, atomicJson, withLock } from '../scripts/backup/lib.mjs'
import { readDatabaseSecret } from '../scripts/database-url.mjs'
import { replaceHba, reloadHba, restoreHba, routeUrl } from './scoped-db-auth.mjs'

export function clusterHba(original, adminRole) {
  if (!/^[a-z_][a-z_0-9]*$/.test(adminRole)) throw new Error('Invalid admin role')
  let replaced = 0
  const lines = original.split('\n').flatMap(line => {
    if (!line.trim() || line.trimStart().startsWith('#')) return [line]
    const fields = line.trim().split(/\s+/)
    const method = fields[0] === 'local' ? 3 : 4
    if (fields[method] !== 'trust') {
      if (fields[method] !== 'scram-sha-256') throw new Error('Unreviewed HBA method')
      return [line]
    }
    if (!['local', 'host'].includes(fields[0]) || !['all', 'replication'].includes(fields[1]) || fields[2] !== 'all' || fields.length !== method + 1 || fields[0] === 'host' && !['127.0.0.1/32', '::1/128'].includes(fields[3])) throw new Error('Unreviewed trust rule')
    replaced++
    const result = []
    if (fields[0] === 'local') result.push(`local ${fields[1]} ${adminRole} peer`)
    fields[method] = 'scram-sha-256'; result.push(fields.join(' '))
    return result
  })
  if (replaced !== 6) throw new Error('Unexpected trust rule count')
  return '# Cluster authentication: peer for matching OS admin, SCRAM otherwise\n' + lines.join('\n')
}

export async function validateCluster(admin, adminRole) {
  const rows = (await admin.query('SELECT type,database,user_name,address,netmask,auth_method,options,error FROM pg_hba_file_rules ORDER BY line_number')).rows
  if (rows.some(r => r.error || r.options?.length)) throw new Error('HBA parser/options rejected')
  for (const r of rows) {
    if (r.type === 'local') {
      if (r.auth_method === 'peer') {
        if (JSON.stringify(r.user_name) !== JSON.stringify([adminRole])) throw new Error('Peer scope mismatch')
      } else if (r.auth_method !== 'scram-sha-256') throw new Error('Unsafe local authentication')
    } else if (r.type !== 'host' || r.auth_method !== 'scram-sha-256') throw new Error('Unsafe network authentication')
  }
  if (!rows.some(r => r.type === 'local' && r.auth_method === 'peer' && JSON.stringify(r.database) === '["all"]')) throw new Error('Missing admin peer rule')
  return rows.length
}

async function probe(params, reject = false) {
  const c = new pg.Client({ ...params, connectionTimeoutMillis: 3000 })
  try {
    await c.connect()
    if (reject) throw new Error('Unexpected authentication success')
    await c.query('BEGIN READ ONLY'); await c.query("SET LOCAL statement_timeout='5s'")
    const identity = (await c.query('SELECT current_user AS role,current_database() AS database')).rows[0]
    await c.query('ROLLBACK'); return { accepted: true, ...identity }
  } catch (error) {
    if (reject && ['28P01', '28000'].includes(error.code)) return { rejected: true, sqlstate: error.code }
    throw new Error(reject ? 'Negative authentication probe failed' : 'Consumer authentication probe failed')
  } finally { await c.end().catch(() => {}) }
}

export async function verifyCluster(state, reader = readDatabaseSecret) {
  const result = { peer: [], passwords: [], negatives: [] }
  for (const database of state.adminDatabases) result.peer.push(await probe({ ...state.admin, database }))
  for (const entry of state.passwordConsumers) {
    const url = reader(entry.service)
    const parsed = new URL(url)
    if (parsed.hostname !== 'localhost' || Number(parsed.port || 5432) !== state.admin.port || decodeURIComponent(parsed.username) !== entry.role || parsed.pathname !== '/' + entry.database) throw new Error('Credential target mismatch')
    for (const route of ['local', 'ipv4', 'ipv6']) {
      result.passwords.push({ route, role: entry.role, ...await probe({ connectionString: routeUrl(url, route, state.socket) }) })
    }
  }
  const invalid = randomBytes(32).toString('hex')
  for (const entry of state.roles) {
    for (const route of ['local', 'ipv4', 'ipv6']) {
      if (entry.role === state.admin.user && route === 'local') continue // Peer intentionally ignores a supplied password.
      const host = route === 'local' ? state.socket : route === 'ipv4' ? '127.0.0.1' : '::1'
      result.negatives.push({ route, role: entry.role, ...await probe({ host, port: state.admin.port, database: entry.database, user: entry.role, password: invalid }, true) })
    }
  }
  return result
}

export async function applyCluster(state, admin, verify, persist = async () => {}) {
  if (await checksum(state.backup) !== state.originalSha256 || await checksum(state.hba) !== state.originalSha256) throw new Error('HBA backup/current checksum mismatch')
  const next = clusterHba(await readFile(state.hba, 'utf8'), state.admin.user)
  state.appliedSha256 = createHash('sha256').update(next).digest('hex')
  state.status = 'applying'; await persist(state)
  let changed = false
  try {
    await replaceHba(state.hba, next, state.scratch); changed = true
    await validateCluster(admin, state.admin.user)
    await reloadHba(admin); state.reloadedAt = new Date().toISOString()
    state.verification = await verify(); state.status = 'cluster_auth_enforced'
    return state
  } catch {
    if (changed) {
      try { await restoreHba(state, admin) }
      catch { state.status = 'recovery_required'; throw new Error('Cluster authentication recovery required') }
    }
    throw new Error('Cluster authentication stopped; HBA restored if changed')
  }
}

async function main() {
  const [action, production, flag, path, ...extra] = process.argv.slice(2)
  if (!['apply', 'verify', 'rollback'].includes(action) || production !== '--production' || flag !== '--state' || !path || extra.length) throw new Error('Invalid operator arguments')
  const root = join(homedir(), '.open-brain/rotations'), stateFile = resolve(path)
  if (!stateFile.startsWith(root + '/')) throw new Error('Invalid state path')
  await withLock(root, 'cluster-db-auth', async () => {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    if (state.admin.user !== userInfo().username || state.admin.host !== state.socket || !state.socket.startsWith('/')) throw new Error('Admin must use its matching OS identity and Unix socket')
    const admin = new pg.Client({ ...state.admin, connectionTimeoutMillis: 3000 })
    try {
      await admin.connect(); await admin.query("SET statement_timeout='10s'")
      if ((await admin.query('SHOW hba_file')).rows[0].hba_file !== state.hba) throw new Error('Wrong cluster')
      const verify = async () => { await validateCluster(admin, state.admin.user); return verifyCluster(state) }
      if (action === 'apply') {
        if (state.status !== 'prepared') throw new Error('State not prepared')
        for (const item of state.passwordConsumers) readDatabaseSecret(item.service)
        await applyCluster(state, admin, verify, s => atomicJson(stateFile, s))
      } else if (action === 'rollback') await restoreHba(state, admin)
      else state.verification = await verify()
      await atomicJson(stateFile, state)
      console.log(JSON.stringify({ status: state.status, reloadedAt: state.reloadedAt, verification: state.verification, stateFile }))
    } catch {
      await atomicJson(stateFile, state)
      throw new Error('Cluster authentication stopped; inspect private state')
    } finally { await admin.end().catch(() => {}) }
  })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077)
  main().catch(() => { console.error('Cluster authentication operation stopped; details suppressed.'); process.exitCode = 1 })
}
