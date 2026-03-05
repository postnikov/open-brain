import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, extname, basename } from 'node:path'
import { sql } from 'drizzle-orm'
import type { CapturePipeline } from '../pipeline/capture.js'
import type { ThoughtsRepository } from '../repository/types.js'
import type { Database } from '../db/connection.js'
import { logger } from '../shared/logger.js'

const CONCURRENCY = 3

export interface ImportFile {
  readonly name: string
  readonly content: string
  readonly tags?: readonly string[]
}

export interface ImportProgress {
  readonly running: boolean
  readonly processed: number
  readonly total: number
  readonly skipped: number
  readonly errors: readonly string[]
  readonly lastFile?: string
}

export interface VaultFile {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly modified: string
}

export interface ImportService {
  readonly importFiles: (files: readonly ImportFile[], source: string) => Promise<void>
  readonly scanVault: (vaultPath: string) => Promise<readonly VaultFile[]>
  readonly importVaultFiles: (vaultPath: string, relativePaths: readonly string[]) => Promise<void>
  readonly getProgress: () => ImportProgress
}

function contentHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex').slice(0, 16)
}

function truncateContent(text: string, maxWords: number): string {
  const words = text.split(/\s+/)
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(' ')
}

export function createImportService(
  db: Database,
  pipeline: CapturePipeline,
  repository: ThoughtsRepository,
): ImportService {
  let progress: ImportProgress = { running: false, processed: 0, total: 0, skipped: 0, errors: [] }

  async function getExistingHashes(): Promise<Set<string>> {
    const rows = await db.execute(sql`SELECT obsidian_hash FROM thoughts WHERE obsidian_hash IS NOT NULL`)
    return new Set(rows.rows.map((r) => r.obsidian_hash as string))
  }

  async function processFile(
    name: string,
    content: string,
    source: string,
    tags?: readonly string[],
    obsidianPath?: string,
    existingHashes?: Set<string>,
  ): Promise<boolean> {
    const hash = contentHash(content)

    if (existingHashes && existingHashes.has(hash)) {
      return false
    }

    const truncated = truncateContent(content, 8000)

    await pipeline.capture({
      content: truncated,
      source,
      tags,
    })

    if (obsidianPath) {
      const rows = await db.execute(sql`
        SELECT id FROM thoughts WHERE content = ${truncated} ORDER BY created_at DESC LIMIT 1
      `)
      if (rows.rows[0]) {
        await db.execute(sql`
          UPDATE thoughts SET obsidian_path = ${obsidianPath}, obsidian_hash = ${hash} WHERE id = ${rows.rows[0].id}
        `)
      }
    }

    return true
  }

  async function processBatch(
    items: readonly { name: string; content: string; source: string; tags?: readonly string[]; obsidianPath?: string }[],
    existingHashes: Set<string>,
  ): Promise<void> {
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY)
      await Promise.all(
        batch.map(async (item) => {
          try {
            const imported = await processFile(item.name, item.content, item.source, item.tags, item.obsidianPath, existingHashes)
            if (imported) {
              existingHashes.add(contentHash(item.content))
            } else {
              progress = { ...progress, skipped: progress.skipped + 1 }
            }
            progress = { ...progress, processed: progress.processed + 1, lastFile: item.name }
          } catch (error) {
            const msg = `${item.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
            logger.error({ err: error, file: item.name }, 'Import file failed')
            progress = { ...progress, processed: progress.processed + 1, errors: [...progress.errors, msg] }
          }
        }),
      )
    }
  }

  return {
    async importFiles(files, source): Promise<void> {
      if (progress.running) throw new Error('Import already in progress')

      progress = { running: true, processed: 0, total: files.length, skipped: 0, errors: [], lastFile: undefined }

      const existingHashes = await getExistingHashes()
      const items = files.map((f) => ({ name: f.name, content: f.content, source, tags: f.tags }))

      try {
        await processBatch(items, existingHashes)
      } finally {
        progress = { ...progress, running: false }
        logger.info({ processed: progress.processed, skipped: progress.skipped, errors: progress.errors.length }, 'File import complete')
      }
    },

    async scanVault(vaultPath): Promise<readonly VaultFile[]> {
      const results: VaultFile[] = []

      async function scan(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.')) continue
            await scan(fullPath)
          } else if (entry.isFile() && extname(entry.name) === '.md') {
            if (entry.name.endsWith('.excalidraw.md')) continue
            if (entry.name === '_Index.md') continue
            const stats = await stat(fullPath)
            results.push({
              path: relative(vaultPath, fullPath),
              name: basename(entry.name),
              size: stats.size,
              modified: stats.mtime.toISOString(),
            })
          }
        }
      }

      await scan(vaultPath)
      return results.sort((a, b) => a.path.localeCompare(b.path))
    },

    async importVaultFiles(vaultPath, relativePaths): Promise<void> {
      if (progress.running) throw new Error('Import already in progress')

      progress = { running: true, processed: 0, total: relativePaths.length, skipped: 0, errors: [], lastFile: undefined }

      const existingHashes = await getExistingHashes()
      const items: { name: string; content: string; source: string; obsidianPath: string }[] = []

      for (const relPath of relativePaths) {
        try {
          const fullPath = join(vaultPath, relPath)
          const content = await readFile(fullPath, 'utf-8')
          items.push({ name: relPath, content, source: 'obsidian', obsidianPath: relPath })
        } catch (error) {
          const msg = `${relPath}: ${error instanceof Error ? error.message : 'Read failed'}`
          progress = { ...progress, total: progress.total - 1, errors: [...progress.errors, msg] }
        }
      }

      try {
        await processBatch(items, existingHashes)
      } finally {
        progress = { ...progress, running: false }
        logger.info({ processed: progress.processed, skipped: progress.skipped, errors: progress.errors.length }, 'Vault import complete')
      }
    },

    getProgress(): ImportProgress {
      return progress
    },
  }
}
