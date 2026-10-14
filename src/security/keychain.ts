import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)

/** Values never go into argv, files or error messages. Login Keychain only. */
async function readKeychainValue(service: string, valid: RegExp, what: string): Promise<string> {
  if (!/^[A-Za-z0-9_./-]+$/.test(service)) throw new Error('Invalid Keychain service name')
  try {
    const { stdout } = await exec('/usr/bin/security', [
      'find-generic-password', '-a', userInfo().username, '-s', service,
      '-w', join(homedir(), 'Library/Keychains/login.keychain-db'),
    ], { timeout: 5000, maxBuffer: 1024 })
    const value = stdout.trim()
    if (!valid.test(value)) throw new Error('Invalid value')
    return value
  } catch {
    throw new Error(`${what} unavailable or invalid in login Keychain`)
  }
}

export function readKeychainToken(service: string): Promise<string> {
  return readKeychainValue(service, /^[a-f0-9]{64}$/, 'HTTP token')
}

/** Any printable single-line key; the OpenAI client rejects a wrong one itself. */
export function readKeychainApiKey(service: string): Promise<string> {
  return readKeychainValue(service, /^[\x21-\x7e]{20,512}$/, 'OpenAI API key')
}
