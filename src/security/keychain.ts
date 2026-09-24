import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)

/** Values never go into argv, files or error messages. Login Keychain only. */
export async function readKeychainToken(service: string): Promise<string> {
  if (!/^[A-Za-z0-9_./-]+$/.test(service)) throw new Error('Invalid Keychain service name')
  try {
    const { stdout } = await exec('/usr/bin/security', [
      'find-generic-password', '-a', userInfo().username, '-s', service,
      '-w', join(homedir(), 'Library/Keychains/login.keychain-db'),
    ], { timeout: 5000, maxBuffer: 1024 })
    const token = stdout.trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid token')
    return token
  } catch {
    throw new Error('HTTP token unavailable or invalid in login Keychain')
  }
}
