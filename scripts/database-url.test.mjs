import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { resolveDatabaseUrl } from './database-url.mjs'
import { sourceConnection } from './backup/lib.mjs'
import { getDatabaseUrl } from '../src/config/loader.ts'

const service = 'vibe/fixture/DATABASE_URL'
const url = 'postgresql://fixture:synthetic-value@localhost/fixture'
const roots = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'db-url-')); roots.push(root)
  return root
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('database credential selection', () => {
  it('chooses Keychain over stale inherited DATABASE_URL', () => {
    const read = vi.fn(() => url)
    expect(resolveDatabaseUrl({ OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE: service, DATABASE_URL: 'stale' }, read)).toBe(url)
    expect(read).toHaveBeenCalledWith(service)
  })
  it.each(['', 'bad service', 'bad\nservice'])('rejects invalid service before reading: %j', value => {
    const read = vi.fn()
    expect(() => resolveDatabaseUrl({ OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE: value }, read)).toThrow('service name')
    expect(read).not.toHaveBeenCalled()
  })
  it.each(['', 'https://localhost', 'postgresql://', url + '\n'])('rejects malformed Keychain result without fallback: %j', value => {
    expect(() => resolveDatabaseUrl({ OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE: service, DATABASE_URL: url }, () => value)).toThrow('unavailable or invalid')
  })
  it('suppresses secret-bearing exceptions and never falls back', () => {
    expect(() => resolveDatabaseUrl({ OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE: service, DATABASE_URL: url }, () => { throw new Error(url) })).toThrow(/^DATABASE_URL unavailable or invalid in login Keychain$/)
  })
  it('preserves explicit portable URL and config mode without a Keychain selector', () => {
    const read = vi.fn()
    expect(resolveDatabaseUrl({ DATABASE_URL: url }, read)).toBe(url)
    expect(resolveDatabaseUrl({}, read)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
  it('config loader and real secret subprocess use owner helper, suppress stderr on failure', async () => {
    const home = await fixture()
    await mkdir(join(home, '.local/bin'), { recursive: true })
    const helper = join(home, '.local/bin/secret')
    await writeFile(helper, `#!/bin/sh\n[ "$1" = get ] && [ "$2" = '${service}' ] || exit 9\nprintf '%s\\n' '${url}'\n`, { mode: 0o700 })
    vi.stubEnv('HOME', home)
    vi.stubEnv('OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE', service)
    vi.stubEnv('DATABASE_URL', 'inherited-stale')
    expect(getDatabaseUrl({ database: {} })).toBe(url)
    await writeFile(helper, `#!/bin/sh\nprintf '%s\\n' '${url}' >&2\nexit 3\n`)
    expect(() => getDatabaseUrl({ database: {} })).toThrow(/^DATABASE_URL unavailable or invalid in login Keychain$/)
  })
})

describe('backup connection sources', () => {
  async function config() {
    const root = await fixture()
    return { serverPlist: join(root, 'server.plist'), envFile: join(root, '.env'), appConfig: join(root, 'config.json') }
  }
  it('resolves plist selector without .env or config (nightly launchd path)', async () => {
    const c = await config()
    await writeFile(c.serverPlist, JSON.stringify({ EnvironmentVariables: { OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE: service } }))
    vi.stubEnv('DATABASE_URL', 'must-not-be-used')
    const client = await sourceConnection(c, () => url)
    expect(client.connectionParameters.database).toBe('fixture')
    expect(client.connectionParameters.password).toBe('synthetic-value')
  })
  it('resolves dotenv selector and honors plist selector precedence', async () => {
    const c = await config()
    await writeFile(c.envFile, `OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE=${service}\nDATABASE_URL=stale\n`)
    await writeFile(c.serverPlist, JSON.stringify({ EnvironmentVariables: {} }))
    const read = vi.fn(() => url)
    await sourceConnection(c, read)
    expect(read).toHaveBeenLastCalledWith(service)
    await writeFile(c.serverPlist, JSON.stringify({ EnvironmentVariables: { OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE: 'vibe/plist/DATABASE_URL' } }))
    await sourceConnection(c, read)
    expect(read).toHaveBeenLastCalledWith('vibe/plist/DATABASE_URL')
  })
  it('fails closed before trying an otherwise valid app-config fallback', async () => {
    const c = await config()
    await writeFile(c.serverPlist, JSON.stringify({ EnvironmentVariables: { OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE: service } }))
    await writeFile(c.appConfig, JSON.stringify({ database: { host: 'localhost', user: 'fallback', database: 'wrong' } }))
    await expect(sourceConnection(c, () => { throw new Error(url) })).rejects.toThrow(/^DATABASE_URL unavailable or invalid in login Keychain$/)
  })
})

it('stdio maintenance preserves selector and disables maintenance tasks without starting services', async () => {
  const root = await fixture()
  const plist = join(root, 'server.plist')
  const repo = process.cwd()
  await writeFile(plist, JSON.stringify({ ProgramArguments: ['/bin/bash', join(repo, 'ops/launch-server.sh')], EnvironmentVariables: { OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE: service } }))
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', plist])
  execFileSync('python3', ['-c', `
import os, runpy, sys
from unittest.mock import patch
def capture(binary, args, env):
    assert args[-1] == sys.argv[2] + '/src/index.ts'
    assert env['OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE'] == '${service}'
    assert env['OPEN_BRAIN_MAINTENANCE'] == '1'
with patch('os.execve', side_effect=capture):
    runpy.run_path(sys.argv[2] + '/ops/stdio-maintenance.py', run_name='__main__')
`, plist, repo], { stdio: ['ignore', 'pipe', 'pipe'] })
})

it('compose app excludes the Mac Keychain selector before migration and server startup', async () => {
  const root = await fixture()
  await writeFile(join(root, 'node'), '#!/bin/sh\n[ -z "${OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE+x}" ] || exit 33\n[ -n "$DATABASE_URL" ] || exit 34\necho fixture-node\n', { mode: 0o700 })
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8')
  const command = compose.match(/command: >\s+sh -c "([\s\S]*?)"/)[1]
  const output = execFileSync('/bin/sh', ['-c', command], {
    env: { PATH: root, DATABASE_URL: url, OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE: service },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(output).toBe('fixture-node\nfixture-node\n')
})
