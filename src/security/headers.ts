import { readKeychainToken } from './keychain.js'

// stdout is a credential channel to the MCP client, never a diagnostic stream.
// Run with an absolute node/tsx path in both clients; do not run in a terminal.
try {
  const service = process.argv[2]
  if (!service || process.argv.length !== 3) throw new Error('Missing service')
  const token = await readKeychainToken(service)
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }) + '\n')
} catch {
  console.error('Open Brain auth helper failed; check login Keychain')
  process.exitCode = 1
}
