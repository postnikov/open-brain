import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, copyFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { parse } from 'dotenv'
import { prepareEnvironment, prepareDatabase } from './setup.mjs'
import { validateDatabaseUrl } from './database-credentials.mjs'
import { DEFAULT_CONFIG } from '../src/config/defaults.ts'
import { configSchema } from '../src/config/schema.ts'
import { getDatabaseUrl } from '../src/config/loader.ts'

const repo = new URL('../', import.meta.url).pathname
const roots = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'setup-')); roots.push(root)
  await copyFile(join(repo, '.env.example'), join(root, '.env.example'))
  return root
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('new-install credentials', () => {
  it('generates distinct 256-bit passwords, matching URLs and owner-only files', async () => {
    const a = await fixture(), b = await fixture()
    expect(prepareEnvironment(a)).toBe(true)
    expect(prepareEnvironment(b)).toBe(true)
    const first = parse(await readFile(join(a, '.env')))
    const second = parse(await readFile(join(b, '.env')))
    expect(/^[0-9a-f]{64}$/.test(first.POSTGRES_PASSWORD)).toBe(true)
    expect(first.POSTGRES_PASSWORD === second.POSTGRES_PASSWORD).toBe(false)
    expect(new URL(first.DATABASE_URL).password === first.POSTGRES_PASSWORD).toBe(true)
    expect((await stat(join(a, '.env'))).mode & 0o777).toBe(0o600)
    expect(validateDatabaseUrl(first.DATABASE_URL) === first.DATABASE_URL).toBe(true)
  })
  it('preserves existing files byte for byte and does not follow symlinks', async () => {
    const root = await fixture(), target = join(root, 'existing')
    const content = '# existing custom credentials\nDATABASE_URL=postgresql://fixture:synthetic@localhost/fixture\n'
    await writeFile(join(root, '.env'), content, { mode: 0o600 })
    expect(prepareEnvironment(root)).toBe(false)
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(content)
    const other = await fixture()
    await writeFile(target, content)
    await symlink(target, join(other, '.env'))
    expect(prepareEnvironment(other)).toBe(false)
    expect(await readFile(target, 'utf8')).toBe(content)
  })
})

describe('application fails before connecting without explicit credentials', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('has no password in defaults or generated config; config-only startup fails clearly', () => {
    vi.stubEnv('OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE', undefined)
    vi.stubEnv('DATABASE_URL', undefined)
    expect(DEFAULT_CONFIG.database.password).toBeUndefined()
    expect(configSchema.parse({}).database.password).toBeUndefined()
    expect(() => getDatabaseUrl(DEFAULT_CONFIG)).toThrow('Database password is required')
  })
  it('the real stdio entry exits with an actionable error and writes no default password', async () => {
    const root = await fixture()
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), join(repo, 'src/index.ts')], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Database password is required')
    expect(JSON.parse(await readFile(join(root, '.open-brain/config.json'), 'utf8')).database.password).toBeUndefined()
  })
  it.each(['', ' ', 'CHANGE_ME_DB_PASSWORD'])('rejects absent/blank/placeholder URL passwords (%j)', password => {
    vi.stubEnv('OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE', undefined)
    vi.stubEnv('DATABASE_URL', `postgresql://fixture:${encodeURIComponent(password)}@localhost/fixture`)
    expect(() => getDatabaseUrl(DEFAULT_CONFIG)).toThrow('Database password is required')
  })
  it('rejects missing authority credentials and empty overriding password parameters', () => {
    expect(() => validateDatabaseUrl('postgresql://fixture@localhost/fixture')).toThrow('password is required')
    expect(() => validateDatabaseUrl('postgresql://fixture:synthetic@localhost/fixture?password=')).toThrow('password is required')
    expect(() => validateDatabaseUrl('postgresql://fixture:synthetic@localhost/fixture?password=synthetic&password=CHANGE_ME_DB_PASSWORD')).toThrow('password is required')
  })
  it('keeps configured credentials and encodes reserved characters', () => {
    vi.stubEnv('OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE', undefined)
    vi.stubEnv('DATABASE_URL', undefined)
    const password = 'synthetic:@/ %#'
    const url = new URL(getDatabaseUrl({ ...DEFAULT_CONFIG, database: { ...DEFAULT_CONFIG.database, password } }))
    expect(decodeURIComponent(url.password)).toBe(password)
    const explicit = 'postgresql://fixture:synthetic@localhost/fixture'
    vi.stubEnv('DATABASE_URL', explicit)
    expect(getDatabaseUrl(DEFAULT_CONFIG)).toBe(explicit)
  })
  it.each(['postgresql://fixture:synthetic@', 'https://fixture:synthetic@localhost', 'postgresql://fixture:%zz@localhost/fixture'])('sanitizes malformed URLs', value => {
    expect(() => validateDatabaseUrl(value)).toThrow(/^Invalid DATABASE_URL\./)
  })
})

describe('database setup', () => {
  const password = "synthetic-'value"
  const env = { DATABASE_URL: `postgresql://fixture:${encodeURIComponent(password)}@localhost:55432/fixture`, PGUSER: 'installer' }
  it('uses the configured password on stdin/env, never argv, and verifies before extension/migrations', async () => {
    const calls = []
    // Retain only synthetic SQL, argv and booleans, never a subprocess environment.
    const run = (binary, args, options) => {
      calls.push({ binary, args, sql: options.input, targetPasswordMatches: options.env.PGPASSWORD === password })
      return { status: 0, stdout: options.input.startsWith('SELECT 1 FROM') ? '' : '1' }
    }
    await prepareDatabase(env, run)
    expect(calls.some(c => c.sql.includes("WITH PASSWORD 'synthetic-''value'"))).toBe(true)
    expect(calls.every(c => !c.args.some(a => a.includes(password)))).toBe(true)
    expect(calls.find(c => c.sql === 'SELECT 1\n').targetPasswordMatches).toBe(true)
    expect(calls.at(-1).args.slice(-2)).toEqual(['-d', 'fixture'])
    expect(calls.at(-1).sql).toContain('CREATE EXTENSION')
  })
  it('never alters an existing role or recreates an existing database', async () => {
    const statements = []
    await prepareDatabase(env, (_binary, _args, options) => {
      statements.push(options.input); return { status: 0, stdout: '1' }
    })
    expect(statements.some(s => /CREATE USER|ALTER|CREATE DATABASE/.test(s))).toBe(false)
  })
  it('stops immediately on admin failure, without printing SQL-bearing errors', async () => {
    let calls = 0
    await expect(prepareDatabase(env, () => {
      calls++; return { status: 1, stderr: password, stdout: password }
    })).rejects.toThrow(/^PostgreSQL setup failed\./)
    expect(calls).toBe(1)
  })
  it('fails mismatched existing credentials without attempting rotation or extensions', async () => {
    const statements = []
    await expect(prepareDatabase(env, (_binary, _args, options) => {
      statements.push(options.input)
      return { status: options.input === 'SELECT 1\n' ? 1 : 0, stdout: '1', stderr: password }
    })).rejects.toThrow('Existing role passwords are never changed')
    expect(statements.some(s => /ALTER|CREATE/.test(s))).toBe(false)
  })
  it('does not invoke psql when a password is missing', async () => {
    const run = vi.fn()
    await expect(prepareDatabase({ DATABASE_URL: 'postgresql://fixture@localhost/fixture' }, run)).rejects.toThrow('password is required')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('setup.sh entry', () => {
  async function shellFixture() {
    const root = await fixture()
    await mkdir(join(root, 'scripts'))
    for (const name of ['setup.mjs', 'database-credentials.mjs', 'database-url.mjs']) {
      await copyFile(join(repo, 'scripts', name), join(root, 'scripts', name))
    }
    await copyFile(join(repo, 'setup.sh'), join(root, 'setup.sh'))
    await symlink(join(repo, 'node_modules'), join(root, 'node_modules'))
    await mkdir(join(root, 'bin'))
    await symlink(process.execPath, join(root, 'bin', 'node'))
    return root
  }
  function shell(root, args = []) {
    return spawnSync('/bin/bash', [join(root, 'setup.sh'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { HOME: root, PATH: `${root}/bin:/usr/bin:/bin`, TMPDIR: root },
    })
  }
  it('--env-only works without npm or PostgreSQL, prints no generated credentials, and is idempotent', async () => {
    const root = await shellFixture()
    const first = shell(root, ['--env-only'])
    expect(first.status, first.stderr).toBe(0)
    const bytes = await readFile(join(root, '.env'), 'utf8')
    const password = parse(bytes).POSTGRES_PASSWORD
    expect((first.stdout + first.stderr).includes(password)).toBe(false)
    expect(shell(root, ['--env-only']).status).toBe(0)
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(bytes)
  })
  it('returns failure and never says Setup complete after a migration error', async () => {
    const root = await shellFixture()
    await writeFile(join(root, 'bin', 'psql'), '#!/bin/sh\ncat >/dev/null\necho 1\n', { mode: 0o700 })
    await writeFile(join(root, 'bin', 'npm'), '#!/bin/sh\n[ "$1" = install ] && exit 0\nexit 29\n', { mode: 0o700 })
    const result = shell(root)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('setup is incomplete')
    expect(result.stdout).not.toContain('Setup complete!')
  })
})

describe.skipIf(!process.env.OPEN_BRAIN_TEST_PG_BIN)('setup against isolated PostgreSQL with SCRAM', () => {
  it('creates a fresh database, reuses credentials, and rejects a wrong password without rotation', async () => {
    const root = await fixture(), socket = join(root, 'socket'), data = join(root, 'data')
    const bin = process.env.OPEN_BRAIN_TEST_PG_BIN
    await mkdir(socket)
    const env = { HOME: root, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root, PGUSER: 'fixture' }
    function pgRun(name, args) {
      const result = spawnSync(join(bin, name), args, { env, encoding: 'utf8', timeout: 30_000 })
      if (result.status !== 0) throw new Error(`Isolated PostgreSQL ${name} failed (status ${result.status})`)
    }
    pgRun('initdb', ['-D', data, '-A', 'trust', '-U', 'fixture', '--no-locale', '--encoding=UTF8'])
    await writeFile(join(data, 'postgresql.auto.conf'), `listen_addresses=''\nunix_socket_directories='${socket}'\npassword_encryption='scram-sha-256'\n`)
    await writeFile(join(data, 'pg_hba.conf'), 'local all open_brain scram-sha-256\nlocal all all trust\n')
    pgRun('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-w', 'start'])
    try {
      prepareEnvironment(root)
      const credentials = parse(await readFile(join(root, '.env')))
      const url = new URL(credentials.DATABASE_URL)
      url.searchParams.set('host', socket)
      const configured = { ...env, DATABASE_URL: url.href }
      await prepareDatabase(configured)
      await prepareDatabase(configured)
      url.password = 'synthetic-wrong-password'
      await expect(prepareDatabase({ ...env, DATABASE_URL: url.href })).rejects.toThrow('Database login failed')
      // If the wrong-password attempt rotated anything, this real SCRAM login fails.
      await prepareDatabase(configured)
    } finally {
      pgRun('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
    }
  }, 60_000)
})
