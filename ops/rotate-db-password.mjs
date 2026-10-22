// Explicit operator action. Values remain in memory/Keychain; state is metadata only.
import { randomBytes, randomUUID, createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { readDatabaseSecret } from '../scripts/database-url.mjs'
import { readConfig, backup, verifyLatest, command, atomicJson, privateDirectory, withLock } from '../scripts/backup/lib.mjs'

export function scramVerifier(password, salt = randomBytes(16)) {
  // Generated passwords are ASCII; no SASLprep transformation is needed.
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256')
  const hmac = text => createHmac('sha256', salted).update(text).digest()
  const stored = createHash('sha256').update(hmac('Client Key')).digest('base64')
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${hmac('Server Key').toString('base64')}`
}

export function writeSecret(service, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(homedir(), '.local/bin/secret'), ['set', service, '--tier', '1'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { HOME: homedir(), PATH: '/usr/bin:/bin:/opt/homebrew/bin', ...(process.env.USER ? { USER: process.env.USER } : {}) },
    })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Keychain writer timed out')) }, 15000)
    child.on('error', () => { clearTimeout(timer); reject(new Error('Keychain writer failed')) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Keychain writer failed')) })
    child.stdin.on('error', () => {})
    child.stdin.end(value)
  })
}

async function writeVerified(service, value, writer, reader) {
  await writer(service, value)
  if (reader(service) !== value) throw new Error('Keychain read-back mismatch')
}

function client(url) { return new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 }) }
function password(url) { return decodeURIComponent(new URL(url).password) }
function identity(url) { const u = new URL(url); u.password = ''; return u.href }

export async function loggingPreflight(c) {
  const rows = (await c.query("SELECT name, setting FROM pg_settings WHERE name IN ('log_statement','log_min_duration_statement','log_min_duration_sample','log_parameter_max_length_on_error')")).rows
  const settings = Object.fromEntries(rows.map(r => [r.name, r.setting]))
  if (settings.log_statement !== 'none' || settings.log_min_duration_statement !== '-1' || settings.log_min_duration_sample !== '-1' || settings.log_parameter_max_length_on_error !== '0') {
    throw new Error('Database statement/parameter logging is not safe for rotation')
  }
  const extra = (await c.query("SELECT current_setting('pgaudit.log',true) AS audit, current_setting('auto_explain.log_min_duration',true) AS explain")).rows[0]
  if (extra.audit && extra.audit !== 'none' || extra.explain && extra.explain !== '-1') throw new Error('Database extension logging needs review')
}

export async function setOwnPassword(c, value) {
  // The plaintext never becomes SQL. The verifier is a bound parameter, not SQL
  // text; the transaction-local setting disappears at COMMIT/ROLLBACK.
  await c.query('BEGIN')
  try {
    await c.query("SELECT set_config('open_brain.rotation_verifier',$1,true)", [scramVerifier(value)])
    await c.query(`DO $rotation$ BEGIN
      EXECUTE format('ALTER ROLE %I PASSWORD %L', current_user, current_setting('open_brain.rotation_verifier'));
    END $rotation$`)
    await c.query('COMMIT')
  } catch {
    await c.query('ROLLBACK').catch(() => {})
    throw new Error('Role password update failed')
  }
}

export async function probe(url) {
  const c = client(url)
  try { await c.connect(); await c.query('BEGIN READ ONLY'); await c.query("SET LOCAL statement_timeout='10s'"); await c.query('SELECT 1'); await c.query('ROLLBACK') }
  finally { await c.end().catch(() => {}) }
}

export async function rotatePassword({ service, rollbackService, stateFile, beforeBackup, reader = readDatabaseSecret, writer = writeSecret }) {
  const oldUrl = reader(service)
  const c = client(oldUrl)
  let touched = false
  const state = { version: 1, service, rollbackService, beforeBackup, startedAt: new Date().toISOString(), status: 'preflight' }
  try {
    await c.connect(); await loggingPreflight(c)
    state.role = (await c.query('SELECT current_user AS role')).rows[0].role
    // Observe existing authentication policy without changing HBA/roles beyond
    // this role's password. Trust/peer routes cannot prove credential revocation.
    const invalid = new URL(oldUrl); invalid.password = randomBytes(32).toString('hex')
    let rejected = false
    try { await probe(invalid.href) } catch (error) { if (error.code === '28P01') rejected = true; else throw new Error('Authentication preflight failed') }
    state.passwordAuthEnforced = rejected
    await writeVerified(rollbackService, oldUrl, writer, reader)
    state.status = 'rollback_saved'; await atomicJson(stateFile, state)
    const next = new URL(oldUrl)
    next.password = randomBytes(48).toString('base64url')
    touched = true
    await writeVerified(service, next.href, writer, reader)
    state.status = 'keychain_updated'; await atomicJson(stateFile, state)
    await setOwnPassword(c, password(next.href))
    state.status = 'role_updated'; await atomicJson(stateFile, state)
    await probe(next.href)
    rejected = false
    try { await probe(oldUrl) } catch (error) { if (error.code === '28P01') rejected = true; else throw new Error('Old credential verification failed') }
    if (state.passwordAuthEnforced && !rejected) throw new Error('Old credential still authenticates')
    state.status = 'password_rotated'; state.oldPasswordRejected = rejected
    await atomicJson(stateFile, state)
    return state
  } catch (error) {
    if (touched) {
      try {
        // Existing authenticated session survives ALTER ROLE; restore it first.
        // Also covers an ambiguous COMMIT response: never overwrite the only
        // candidate credential until restoring the role has been confirmed.
        await setOwnPassword(c, password(oldUrl))
        await writeVerified(service, oldUrl, writer, reader)
        await probe(oldUrl)
        state.status = 'rolled_back_after_failure'
      } catch { state.status = 'recovery_required' }
    } else state.status = 'preflight_failed'
    await atomicJson(stateFile, state)
    // Only our fixed operational messages, never pg errors or URLs.
    throw new Error(`Rotation stopped (${state.status}); inspect state and run rollback if required`)
  } finally { await c.end().catch(() => {}) }
}

export async function rollbackPassword(stateFile, { reader = readDatabaseSecret, writer = writeSecret } = {}) {
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  const oldUrl = reader(state.rollbackService), current = reader(state.service)
  if (identity(oldUrl) !== identity(current)) throw new Error('Rollback connection identity mismatch')
  let c = client(current)
  try { await c.connect() }
  catch { await c.end().catch(() => {}); c = client(oldUrl); await c.connect() }
  try {
    await loggingPreflight(c)
    const role = (await c.query('SELECT current_user AS role')).rows[0].role
    if (role !== state.role) throw new Error('Rollback role mismatch')
    await setOwnPassword(c, password(oldUrl))
    await writeVerified(state.service, oldUrl, writer, reader)
    await probe(oldUrl)
    state.status = 'rolled_back'; state.rolledBackAt = new Date().toISOString()
    await atomicJson(stateFile, state)
    return state
  } finally { await c.end().catch(() => {}) }
}

async function main() {
  const [action, production, flag, statePath, ...extra] = process.argv.slice(2)
  if (!['apply','rollback'].includes(action) || production !== '--production' || flag !== '--state' || !statePath || extra.length) throw new Error('Usage: apply|rollback --production --state <private-json-path>')
  const root = join(homedir(), '.open-brain/rotations'), stateFile = resolve(statePath)
  if (!stateFile.startsWith(root + '/')) throw new Error('State must be under ~/.open-brain/rotations')
  await privateDirectory(root)
  await withLock(root, 'db-password-rotation', async () => {
    const config = await readConfig()
    const plist = JSON.parse(await command('/usr/bin/plutil', ['-convert','json','-o','-',config.serverPlist]))
    if (plist.Label !== 'com.open-brain.server') throw new Error('Unexpected server job')
    const service = plist.EnvironmentVariables?.OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE
    if (!service || !/^[A-Za-z0-9_./-]+$/.test(service)) throw new Error('Missing Keychain selector')
    let state
    if (action === 'apply') {
      try { await access(stateFile); throw new Error('State already exists; inspect it before another attempt') }
      catch (e) { if (e.code !== 'ENOENT') throw e }
      const before = await backup(config)
      await verifyLatest(config)
      await command(join(config.pgBin, 'pg_restore'), ['--list',join(config.directory,before.file)])
      state = await rotatePassword({ service, rollbackService: service + '-ROLLBACK-' + randomUUID(), stateFile,
        beforeBackup: { file: before.file, sha256: before.sha256, bytes: before.bytes } })
      await atomicJson(stateFile, state)
    } else state = await rollbackPassword(stateFile)
    await command('/bin/launchctl', ['kickstart','-k',`gui/${process.getuid()}/${plist.Label}`])
    const after = await backup(config)
    await verifyLatest(config)
    state.afterBackup = { file: after.file, sha256: after.sha256, bytes: after.bytes }
    state.serverRestartRequested = true
    await atomicJson(stateFile, state)
    console.log(JSON.stringify({ status: state.status, beforeBackup: state.beforeBackup, afterBackup: state.afterBackup, passwordAuthEnforced: state.passwordAuthEnforced, oldPasswordRejected: state.oldPasswordRejected, stateFile }))
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077)
  main().catch(() => { console.error('Database password operation stopped; inspect private state. Credential details suppressed.'); process.exitCode = 1 })
}
