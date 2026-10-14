import { describe, expect, it, vi } from 'vitest'
import { resolveOpenAIKey } from './openai-key.js'

describe('resolveOpenAIKey', () => {
  it('reads the Keychain service when configured, ignoring OPENAI_API_KEY', async () => {
    const keychain = vi.fn(async () => 'from-keychain')
    await expect(resolveOpenAIKey({ OPEN_BRAIN_OPENAI_KEYCHAIN_SERVICE: 'vibe/x/OPENAI_API_KEY', OPENAI_API_KEY: 'from-env' }, keychain)).resolves.toBe('from-keychain')
    expect(keychain).toHaveBeenCalledWith('vibe/x/OPENAI_API_KEY')
  })

  it('falls back to OPENAI_API_KEY without a Keychain service', async () => {
    const keychain = vi.fn(async () => 'unused')
    await expect(resolveOpenAIKey({ OPENAI_API_KEY: 'from-env' }, keychain)).resolves.toBe('from-env')
    expect(keychain).not.toHaveBeenCalled()
  })

  it('fails closed when the Keychain read fails, without trying the env key', async () => {
    const keychain = vi.fn(async () => { throw new Error('OpenAI API key unavailable or invalid in login Keychain') })
    await expect(resolveOpenAIKey({ OPEN_BRAIN_OPENAI_KEYCHAIN_SERVICE: 'svc', OPENAI_API_KEY: 'from-env' }, keychain)).rejects.toThrow('login Keychain')
  })

  it('fails when neither source is set', async () => {
    await expect(resolveOpenAIKey({}, vi.fn())).rejects.toThrow('OpenAI key missing')
  })
})
