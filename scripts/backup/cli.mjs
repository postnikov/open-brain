import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { readConfig, backup, check, restore, atomicJson } from './lib.mjs'
process.umask(0o077)
let c
try {
  c = await readConfig()
  const action = process.argv[2]
  const fn = { backup, check, restore }[action]
  if (!fn) throw new Error('Usage: cli.mjs backup|check|restore [--if-due]')
  const result = await fn(c, { ifDue: process.argv.includes('--if-due') })
  if (action === 'check') await atomicJson(join(c.directory, 'watchdog.json'), { status: 'ok', checkedAt: new Date().toISOString() })
  console.log(JSON.stringify(result))
} catch (error) {
  // Never serialize PostgreSQL errors/configuration, which can include credentials.
  const reason = error instanceof Error && !error.code ? error.message : 'Operation failed; inspect local configuration and backup files'
  if (c && process.argv[2] === 'check') {
    const path = join(c.directory, 'watchdog.json')
    let previous; try { previous = JSON.parse(await readFile(path, 'utf8')) } catch {}
    await atomicJson(path, { status: 'error', reason, checkedAt: new Date().toISOString(), firstFailedAt: previous?.firstFailedAt || new Date().toISOString() }).catch(() => {})
    if (previous?.reason !== reason) console.error(`OPEN BRAIN BACKUP ALERT: ${reason}`)
  } else console.error(reason)
  process.exitCode = 1
}
