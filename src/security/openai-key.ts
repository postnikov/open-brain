import { readKeychainApiKey } from './keychain.js'

/**
 * OPEN_BRAIN_OPENAI_KEYCHAIN_SERVICE (a login Keychain service name) wins over
 * OPENAI_API_KEY: an interactive shell may export an unrelated global key.
 */
export async function resolveOpenAIKey(env: NodeJS.ProcessEnv = process.env, keychain = readKeychainApiKey): Promise<string> {
  const service = env.OPEN_BRAIN_OPENAI_KEYCHAIN_SERVICE
  if (service) return keychain(service)
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY
  throw new Error('OpenAI key missing: set OPEN_BRAIN_OPENAI_KEYCHAIN_SERVICE (login Keychain) or OPENAI_API_KEY')
}
