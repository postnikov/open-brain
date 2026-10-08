import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'

const MAX_SOURCE_BYTES = 4 * 1024 * 1024

function hash16(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

function filePath(ref: string): string | null {
  if (ref.startsWith('~/')) return homedir() + ref.slice(1)
  return ref.startsWith('/') ? ref : null
}

/**
 * Compact, human-actionable form of a source reference for pointer lists:
 * file paths relative to home, distillation batches as `session:<id> +N · run:<id8>`.
 */
export function shortRef(ref: string): string {
  const path = filePath(ref)
  if (path) {
    const home = homedir()
    return path.startsWith(home + '/') ? '~' + path.slice(home.length) : path
  }
  if (ref.startsWith('{')) {
    try {
      const parsed = JSON.parse(ref) as { session_ids?: string[]; distillation_run_id?: string; legacy?: boolean }
      const run = parsed.distillation_run_id ? `run:${parsed.distillation_run_id.slice(0, 8)}` : ''
      const sessions = parsed.session_ids ?? []
      const session = sessions.length > 0 ? `session:${sessions[0]}${sessions.length > 1 ? ` +${sessions.length - 1}` : ''}` : ''
      return [session, run, parsed.legacy ? 'legacy' : ''].filter(Boolean).join(' · ') || ref.slice(0, 80)
    } catch { /* Not JSON: fall through to the raw value. */ }
  }
  return ref.length > 120 ? ref.slice(0, 117) + '...' : ref
}

export interface SourceState {
  /** The referenced file exists now; null when the reference is not a file. */
  readonly sourceLive: boolean | null
  /** The file differs from the stored copy; null when unknown or not a file. */
  readonly sourceChanged: boolean | null
}

/**
 * Vault is the source of truth (Max 2026-10-08, q2): for file references report whether the
 * file still exists and whether it changed since the copy was stored. Only booleans leave
 * this function — never the file text.
 */
export async function sourceState(ref: string, storedContent: string): Promise<SourceState> {
  const path = filePath(ref)
  if (!path) return { sourceLive: null, sourceChanged: null }
  try {
    const info = await stat(path)
    if (!info.isFile()) return { sourceLive: false, sourceChanged: null }
    if (info.size > MAX_SOURCE_BYTES) return { sourceLive: true, sourceChanged: null }
    const current = await readFile(path, 'utf8')
    return { sourceLive: true, sourceChanged: hash16(current) !== hash16(storedContent) }
  } catch {
    return { sourceLive: false, sourceChanged: null }
  }
}
