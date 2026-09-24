import { readFile, writeFile, mkdir, open, rename, stat, statfs, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import pg from 'pg'
import { parse } from 'dotenv'
const exec = promisify(execFile)
export const quote = s => '"' + s.replaceAll('"', '""') + '"'
export async function command(bin, args, env = process.env) {
  try { return (await exec(bin, args, { env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })).stdout }
  catch { throw new Error(`${basename(bin)} failed (details suppressed to protect credentials)` ) }
}
export async function readConfig(path = process.env.OPEN_BRAIN_BACKUP_CONFIG || join(homedir(), '.open-brain/backup.json')) {
  const c = JSON.parse(await readFile(path, 'utf8'))
  for (const key of ['directory', 'pgBin', 'serverPlist', 'envFile', 'appConfig', 'restoreDirectory']) {
    if (typeof c[key] !== 'string' || !c[key].startsWith('/')) throw new Error(`Invalid absolute path: ${key}`)
  }
  for (const key of ['maxBackupHours', 'maxRestoreHours', 'minFreeBytes', 'minBackupIntervalHours']) {
    if (!Number.isFinite(c[key]) || c[key] < 0) throw new Error(`Invalid threshold: ${key}`)
  }
  return c
}
export async function sourceConnection(c) {
  // Same precedence as launchd server + dotenv/config. No permissive config fallback.
  const plist = JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', c.serverPlist]))
  const env = { ...parse(await readFile(c.envFile)), ...plist.EnvironmentVariables }
  if (env.DATABASE_URL) return new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10_000 })
  const { database } = JSON.parse(await readFile(c.appConfig, 'utf8'))
  if (!database?.database || !database?.user || !database?.host) throw new Error('Missing explicit database config')
  return new pg.Client({ ...database, connectionTimeoutMillis: 10_000 })
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await stat(path)
  if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('Directory must be owner-only (0700)')
}
export async function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = await open(tmp, 'wx', 0o600)
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync() } finally { await fd.close() }
  await rename(tmp, path)
  const dir = await open(dirname(path), 'r'); try { await dir.sync() } finally { await dir.close() }
}
export async function withLock(directory, name, fn) {
  await privateDirectory(directory)
  const path = join(directory, `${name}.lock`)
  try { await mkdir(path, { mode: 0o700 }) } catch { throw new Error(`${name} lock exists; inspect owner before recovery`) }
  try {
    await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 })
    return await fn()
  } finally { await rm(path, { recursive: true }) }
}
export async function libpqEnv(client, directory) {
  const p = client.connectionParameters
  if (!['localhost', '127.0.0.1', '::1'].includes(p.host) && !p.host.startsWith('/')) throw new Error('Local database required')
  if (p.ssl) throw new Error('SSL connection needs an explicit libpq configuration')
  const passfile = join(directory, `.pgpass-${randomUUID()}`)
  const escape = s => String(s).replaceAll('\\', '\\\\').replaceAll(':', '\\:')
  await writeFile(passfile, [p.host, p.port, p.database, p.user, p.password ?? ''].map(escape).join(':') + '\n', { mode: 0o600, flag: 'wx' })
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG') && k !== 'DATABASE_URL'))
  return { passfile, env: { ...env, PGHOST: p.host, PGPORT: String(p.port), PGDATABASE: p.database, PGUSER: p.user, PGPASSFILE: passfile, PGCONNECT_TIMEOUT: '10', PGOPTIONS: '-c statement_timeout=600000 -c lock_timeout=10000' } }
}
export async function inventory(client) {
  const tables = (await client.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1,2`)).rows
  for (const t of tables) t.rows = (await client.query(`SELECT count(*)::text AS n FROM ${quote(t.schema)}.${quote(t.name)}`)).rows[0].n
  const indexes = (await client.query(`SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3`)).rows
  const constraints = (await client.query(`SELECT n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition,k.convalidated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3`)).rows
  const extensions = (await client.query('SELECT extname,extversion FROM pg_extension ORDER BY extname')).rows
  const sequences = (await client.query(`SELECT sequence_schema,sequence_name,data_type FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`)).rows
  return { tables, indexes, constraints, extensions, sequences }
}
export async function checksum(file) { return createHash('sha256').update(await readFile(file)).digest('hex') }
export async function verifyLatest(c) {
  const latest = JSON.parse(await readFile(join(c.directory, 'latest.json'), 'utf8'))
  if (!/^open-brain-[\w-]+\.json$/.test(latest.manifest)) throw new Error('Invalid manifest path')
  const m = JSON.parse(await readFile(join(c.directory, latest.manifest), 'utf8'))
  if (!/^open-brain-[\w-]+\.dump$/.test(m.file)) throw new Error('Invalid dump path')
  const file = join(c.directory, m.file)
  if (!m.completedAt || m.bytes <= 0 || (await stat(file)).size !== m.bytes || await checksum(file) !== m.sha256 || latest.sha256 !== m.sha256) throw new Error('Backup checksum/manifest mismatch')
  return m
}
export function ageHours(date, now = Date.now()) {
  const ms = Date.parse(date)
  if (!Number.isFinite(ms) || ms > now + 60_000) throw new Error('Invalid/future timestamp')
  return (now - ms) / 3_600_000
}
export async function backup(c, { ifDue = false } = {}) {
  return withLock(c.directory, 'backup', async () => {
    if (ifDue) {
      try { const m = await verifyLatest(c); if (ageHours(m.completedAt) < c.minBackupIntervalHours) return { skipped: true, file: m.file } } catch { /* Missing or corrupt copy must be replaced. */ }
    }
    const space = await statfs(c.directory)
    if (space.bavail * space.bsize < c.minFreeBytes) throw new Error('Insufficient free space')
    const client = await sourceConnection(c)
    const startedAt = new Date().toISOString()
    const name = `open-brain-${startedAt.replace(/[^0-9TZ]/g, '')}-${randomUUID()}`
    const tmp = join(c.directory, `.${name}.tmp`)
    let credentials
    try {
      await client.connect()
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout='10min'")
      await client.query("SET LOCAL idle_in_transaction_session_timeout='15min'")
      const server = (await client.query("SELECT current_database() AS database, current_setting('server_version') AS version, current_setting('server_version_num')::int AS version_num, pg_export_snapshot() AS snapshot")).rows[0]
      const version = (await command(join(c.pgBin, 'pg_dump'), ['--version'])).trim()
      const major = Number(version.match(/PostgreSQL\) (\d+)/)?.[1])
      if (!major || major < Math.floor(server.version_num / 10000)) throw new Error('pg_dump is older than server')
      const objects = await inventory(client)
      credentials = await libpqEnv(client, c.directory)
      await command(join(c.pgBin, 'pg_dump'), ['--format=custom', '--lock-wait-timeout=10000', `--snapshot=${server.snapshot}`, `--file=${tmp}`], credentials.env)
      const size = (await stat(tmp)).size
      if (!size) throw new Error('Empty dump')
      const toc = await command(join(c.pgBin, 'pg_restore'), ['--list', tmp], credentials.env)
      for (const t of objects.tables) {
        if (!toc.includes(`TABLE ${t.schema} ${t.name} `)) throw new Error('Dump missing table')
      }
      await client.query('COMMIT')
      const file = `${name}.dump`
      const fd = await open(tmp, 'r+'); try { await fd.sync() } finally { await fd.close() }
      await rename(tmp, join(c.directory, file))
      const manifest = { version: 1, file, startedAt, completedAt: new Date().toISOString(), bytes: size, sha256: await checksum(join(c.directory, file)), database: server.database, serverVersion: server.version, dumpVersion: version, objects }
      await atomicJson(join(c.directory, `${name}.json`), manifest)
      await atomicJson(join(c.directory, 'latest.json'), { manifest: `${name}.json`, sha256: manifest.sha256 })
      return manifest
    } finally {
      await client.end().catch(() => {})
      if (credentials) await rm(credentials.passfile, { force: true })
      await rm(tmp, { force: true })
    }
  })
}
export async function check(c) {
  const m = await verifyLatest(c)
  if (ageHours(m.completedAt) > c.maxBackupHours) throw new Error('Backup is stale')
  const r = JSON.parse(await readFile(join(c.directory, 'restore-latest.json'), 'utf8'))
  if (r.status !== 'verified' || !/^[a-f0-9]{64}$/.test(r.sha256) || ageHours(r.completedAt) > c.maxRestoreHours) throw new Error('Restore verification is missing/stale')
  const verified = JSON.parse(await readFile(join(c.directory, r.manifest), 'utf8'))
  if (verified.sha256 !== r.sha256 || await checksum(join(c.directory, verified.file)) !== r.sha256) throw new Error('Verified restore archive is corrupt')
  return { status: 'ok', backup: m.file, backupAgeHours: ageHours(m.completedAt), restoreAgeHours: ageHours(r.completedAt) }
}
export async function restore(c, { ifDue = false } = {}) {
  return withLock(c.directory, 'restore', async () => {
    if (ifDue) {
      try { const r = JSON.parse(await readFile(join(c.directory, 'restore-latest.json'), 'utf8')); if (r.status === 'verified' && ageHours(r.completedAt) < 7 * 24) { await check(c); return { skipped: true } } } catch { /* Drill required. */ }
    }
    const m = await verifyLatest(c)
    await privateDirectory(c.restoreDirectory)
    const name = `check-${randomUUID()}`
    const root = join(c.restoreDirectory, name)
    await privateDirectory(root)
    const data = join(root, 'data'), socket = join(root, 'socket')
    await privateDirectory(socket)
    // A separate, new cluster, Unix socket only. No production DSN accepted.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG') && k !== 'DATABASE_URL'))
    const startedAt = new Date().toISOString()
    let started = false, client
    try {
      await command(join(c.pgBin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale', '--encoding=UTF8', '-U', 'restore_admin'], env)
      await writeFile(join(data, 'postgresql.auto.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket.replaceAll("'", "''")}'\nunix_socket_permissions = 0700\nport = 5432\n`, { mode: 0o600 })
      await command(join(c.pgBin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', 'start'], env)
      started = true
      client = new pg.Client({ host: socket, port: 5432, database: 'postgres', user: 'restore_admin' })
      await client.connect()
      await client.query('CREATE DATABASE open_brain_restorecheck TEMPLATE template0')
      await client.end(); client = undefined
      await command(join(c.pgBin, 'pg_restore'), ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--dbname=open_brain_restorecheck', join(c.directory, m.file)], { ...env, PGHOST: socket, PGPORT: '5432', PGUSER: 'restore_admin', PGCONNECT_TIMEOUT: '10' })
      client = new pg.Client({ host: socket, port: 5432, database: 'open_brain_restorecheck', user: 'restore_admin' })
      await client.connect()
      const actual = await inventory(client)
      if (JSON.stringify(actual) !== JSON.stringify(m.objects)) throw new Error('Restored inventory/counts differ from snapshot')
      const vector = (await client.query("SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector AS distance")).rows[0]
      if (vector.distance !== 0) throw new Error('Vector query failed')
      if (actual.tables.some(t => t.schema === 'public' && t.name === 'thoughts')) {
        await client.query('SELECT id FROM thoughts WHERE embedding IS NOT NULL ORDER BY embedding <=> (SELECT embedding FROM thoughts WHERE embedding IS NOT NULL LIMIT 1) LIMIT 3')
      }
      const result = { status: 'verified', sha256: m.sha256, manifest: m.file.replace(/\.dump$/, '.json'), startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), cluster: root, objects: actual }
      await atomicJson(join(root, 'result.json'), result)
      await atomicJson(join(c.directory, 'restore-latest.json'), result)
      return result
    } finally {
      await client?.end().catch(() => {})
      if (started) await command(join(c.pgBin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], env)
    }
  })
}
