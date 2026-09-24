import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ageHours, atomicJson, checksum, verifyLatest, check, withLock, backup, restore, command } from './lib.mjs'
import pg from 'pg'
const bin = process.env.OPEN_BRAIN_TEST_PG_BIN

describe('backup safety gates', () => {
  it('rejects missing, incomplete, corrupt and stale backups; never trusts a marker alone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ob-backup-'))
    const c = { directory, maxBackupHours: 36, maxRestoreHours: 192 }
    await expect(verifyLatest(c)).rejects.toThrow()
    await writeFile(join(directory, 'open-brain-test.dump'), 'contents')
    const manifest = { file: 'open-brain-test.dump', bytes: 8, sha256: await checksum(join(directory, 'open-brain-test.dump')), completedAt: new Date().toISOString() }
    await atomicJson(join(directory, 'open-brain-test.json'), manifest)
    await expect(verifyLatest(c)).rejects.toThrow()
    await atomicJson(join(directory, 'latest.json'), { manifest: 'open-brain-test.json', sha256: manifest.sha256 })
    expect((await verifyLatest(c)).bytes).toBe(8)
    await expect(check(c)).rejects.toThrow() // No restore proof.
    await atomicJson(join(directory, 'restore-latest.json'), { status: 'verified', sha256: manifest.sha256, manifest: 'open-brain-test.json', completedAt: new Date().toISOString() })
    expect((await check(c)).status).toBe('ok')
    await atomicJson(join(directory, 'restore-latest.json'), { status: 'verified', sha256: manifest.sha256, manifest: 'open-brain-test.json', completedAt: '2020-01-01' })
    await expect(check(c)).rejects.toThrow('stale')
    await atomicJson(join(directory, 'open-brain-test.json'), { ...manifest, completedAt: '2020-01-01' })
    await expect(check(c)).rejects.toThrow('stale')
    await writeFile(join(directory, 'open-brain-test.dump'), 'corrupt!')
    await expect(verifyLatest(c)).rejects.toThrow('mismatch')
    expect(() => ageHours('garbage')).toThrow()
    expect(() => ageHours('3000-01-01')).toThrow()
    await rm(directory, { recursive: true })
  })
  it('refuses concurrent producers and leaves stale locks closed after a crash', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ob-lock-'))
    await withLock(d, 'backup', async () => { await expect(withLock(d, 'backup', async () => {})).rejects.toThrow('lock exists') })
    await mkdir(join(d, 'backup.lock'))
    await expect(withLock(d, 'backup', async () => {})).rejects.toThrow('lock exists')
    await rm(d, { recursive: true })
  })
})

describe.skipIf(!bin)('real PostgreSQL backup/restore (isolated synthetic cluster)', () => {
  it('round trips a consistent snapshot under writes, preserves last good on failures, and never deletes backups', async () => {
    const root = await mkdtemp('/tmp/ob-pg-')
    const data = join(root, 'data'), socket = join(root, 'socket')
    await mkdir(socket, { mode: 0o700 })
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG')))
    let client, writer, interval, writing = Promise.resolve(), started = false
    try {
      await command(join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'fixture', '--no-locale', '--encoding=UTF8'], env)
      await writeFile(join(data, 'postgresql.auto.conf'), `listen_addresses=''\nunix_socket_directories='${socket}'\n`)
      await command(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'log'), '-w', 'start'], env); started = true
      client = new pg.Client({ host: socket, user: 'fixture', database: 'postgres' }); await client.connect()
      await client.query('CREATE EXTENSION vector; CREATE TABLE thoughts(id serial PRIMARY KEY, embedding vector(3)); INSERT INTO thoughts(embedding) VALUES (\'[1,0,0]\'); CREATE TABLE stream(id serial PRIMARY KEY, content text)')
      const c = { directory: join(root, 'backups'), restoreDirectory: join(root, 'restores'), pgBin: bin, serverPlist: join(root, 'server.plist'), envFile: join(root, '.env'), appConfig: join(root, 'config.json'), minFreeBytes: 0, minBackupIntervalHours: 20, maxBackupHours: 36, maxRestoreHours: 192 }
      await writeFile(c.envFile, '')
      await writeFile(c.appConfig, JSON.stringify({ database: { host: socket, user: 'fixture', database: 'postgres' } }))
      await writeFile(c.serverPlist, JSON.stringify({ EnvironmentVariables: {} }))
      await command('/usr/bin/plutil', ['-convert', 'xml1', c.serverPlist])
      writer = new pg.Client({ host: socket, user: 'fixture', database: 'postgres' }); await writer.connect()
      interval = setInterval(() => { writing = writing.then(() => writer.query("INSERT INTO stream(content) VALUES ('synthetic')")) }, 10)
      const m = await backup(c)
      clearInterval(interval); interval = undefined; await writing
      expect(m.objects.tables.length).toBe(2)
      const r = await restore(c)
      expect(r.sha256).toBe(m.sha256)
      expect((await check(c)).status).toBe('ok')
      const marker = await readFile(join(c.directory, 'latest.json'), 'utf8')
      await expect(backup({ ...c, pgBin: '/no-such-bin' })).rejects.toThrow('failed')
      await expect(backup({ ...c, minFreeBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow('space')
      expect(await readFile(join(c.directory, 'latest.json'), 'utf8')).toBe(marker)
      expect((await stat(join(c.directory, m.file))).size).toBe(m.bytes)
      const failing = join(root, 'failing'); await mkdir(failing)
      await writeFile(join(failing, 'pg_dump'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 14.22"; exit 0; fi\nexit 7\n', { mode: 0o700 })
      await expect(backup({ ...c, pgBin: failing })).rejects.toThrow('failed')
      expect(await readFile(join(c.directory, 'latest.json'), 'utf8')).toBe(marker)
      const again = await backup(c)
      expect(again.file).not.toBe(m.file)
      expect((await stat(join(c.directory, m.file))).size).toBe(m.bytes)
      expect((await backup(c, { ifDue: true })).skipped).toBe(true)
    } finally {
      if (interval) clearInterval(interval)
      await writing
      await writer?.end(); await client?.end()
      if (started) await command(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], env)
      // Deliberately retain fixture clusters/evidence; no DROP and no production access.
      console.log(`Isolated fixture retained: ${root}`)
    }
  }, 120_000)
})
