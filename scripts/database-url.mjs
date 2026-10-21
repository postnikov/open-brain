import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const unavailable = 'DATABASE_URL unavailable or invalid in login Keychain'

/** Capture secret stdout in memory only; never propagate subprocess output/errors. */
export function readDatabaseSecret(service) {
  try {
    return execFileSync(join(homedir(), '.local/bin/secret'), ['get', service], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(unavailable)
  }
}

/** An explicitly selected Keychain source wins and must never fall back. */
export function resolveDatabaseUrl(env = process.env, readSecret = readDatabaseSecret) {
  const service = env.OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE
  if (service !== undefined) {
    if (!/^[A-Za-z0-9_./-]+$/.test(service)) throw new Error('Invalid DATABASE_URL Keychain service name')
    try {
      const value = readSecret(service)
      const url = new URL(value)
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || /\s/.test(value)) throw new Error()
      return value
    } catch {
      throw new Error(unavailable)
    }
  }
  return env.DATABASE_URL || undefined
}
