import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateDatabaseUrl } from './database-credentials.mjs'
import { resolveDatabaseUrl } from './database-url.mjs'

/** Fresh installations only: exclusive create also prevents overwriting a symlink. */
export function prepareEnvironment(directory = '.') {
  const template = readFileSync(resolve(directory, '.env.example'), 'utf8')
  const password = randomBytes(32).toString('hex')
  const content = template.replace(/^POSTGRES_PASSWORD=$/m, `POSTGRES_PASSWORD=${password}`)
    .replaceAll('CHANGE_ME_DB_PASSWORD', password)
  try {
    writeFileSync(resolve(directory, '.env'), content, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw new Error('Could not create .env; check directory permissions.')
  }
}

/** Provision using the SAME URL as migrations; existing roles are never altered. */
export async function prepareDatabase(env = process.env, run = spawnSync) {
  const value = resolveDatabaseUrl(env)
  if (!value) throw new Error('Set DATABASE_URL or its Keychain selector before database setup.')
  validateDatabaseUrl(value)
  const { default: pg } = await import('pg')
  const target = new pg.Client({ connectionString: value }).connectionParameters
  const { host, port, user, database, password } = target
  if (![user, database].every(name => /^[a-z_][a-z0-9_]*$/.test(name))) {
    throw new Error('Automatic setup requires simple PostgreSQL role/database names; provision this database manually.')
  }
  const base = ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', String(port), '-At']
  function query(sql, asTarget = false, adminDatabase = 'postgres') {
    const args = [...base, '-U', asTarget ? user : (env.PGUSER || 'postgres'), '-d', asTarget ? database : adminDatabase]
    const result = run('psql', args, {
      input: sql + '\n', encoding: 'utf8', timeout: 30_000,
      env: { ...env, PGCONNECT_TIMEOUT: '5', ...(asTarget ? { PGPASSWORD: password } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // psql errors can contain the SQL/password: never forward stdout/stderr on failure.
    if (result.error || result.status !== 0) {
      throw new Error(asTarget
        ? 'Database login failed. Existing role passwords are never changed; set DATABASE_URL to the existing credentials before retrying.'
        : 'PostgreSQL setup failed. Check administrator access (PGUSER, default postgres), then retry. No existing role password was changed.')
    }
    return result.stdout.trim()
  }
  if (query(`SELECT 1 FROM pg_roles WHERE rolname='${user}'`) !== '1') {
    // SQL goes on stdin, never argv. Escape a caller-supplied existing URL password too.
    const literal = password.replaceAll("'", "''")
    query(`SET standard_conforming_strings = on; CREATE USER "${user}" WITH PASSWORD '${literal}';`)
  }
  if (query(`SELECT 1 FROM pg_database WHERE datname='${database}'`) !== '1') {
    query(`CREATE DATABASE "${database}" OWNER "${user}";`)
  }
  query('SELECT 1', true)
  query('CREATE EXTENSION IF NOT EXISTS vector;', false, database)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'env') {
      console.log(prepareEnvironment() ? 'Created owner-only .env with a random database password (not printed).' : 'Existing .env preserved; no credentials changed.')
    } else if (process.argv[2] === 'database') {
      await prepareDatabase()
      console.log('Database credentials verified; existing role passwords preserved.')
    } else {
      throw new Error('Usage: node scripts/setup.mjs env|database')
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
