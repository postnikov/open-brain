import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, relative } from 'node:path'
import { loadConfig, getDatabaseUrl } from '../config/loader.js'
import { createDatabase } from '../db/connection.js'
import { createThoughtsRepository } from '../repository/thoughts.js'
import { createEmbeddingService } from '../pipeline/embeddings.js'
import { createMetadataService } from '../pipeline/metadata.js'
import { createCapturePipeline } from '../pipeline/capture.js'
import { logger } from '../shared/logger.js'
import { sql } from 'drizzle-orm'
import { glob } from 'node:fs'

const VAULT_PATH = '/Users/admin/Kisadrakon'
const TARGET_FOLDER = process.argv[2] ?? 'Knowledge'
const FOLDER_PATH = `${VAULT_PATH}/${TARGET_FOLDER}`
const CONCURRENCY = 3
const SKIP_PATTERNS = [/\.excalidraw\.md$/, /_Index\.md$/]

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function truncateForEmbedding(text: string, maxTokens: number = 8000): string {
  const words = text.split(/\s+/)
  if (words.length <= maxTokens) return text
  return words.slice(0, maxTokens).join(' ')
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const files: string[] = []
    glob(`${dir}/**/*.md`, (err, matches) => {
      if (err) {
        reject(err)
        return
      }
      resolve(matches)
    })
  })
}

async function main(): Promise<void> {
  const config = await loadConfig()
  const databaseUrl = getDatabaseUrl(config)
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY required')

  const { db, pool } = await createDatabase(databaseUrl)
  const repository = createThoughtsRepository(db)
  const embeddingService = createEmbeddingService(apiKey, config.openai.embedding_model)
  const metadataService = createMetadataService(apiKey, config.openai.metadata_model)
  const pipeline = createCapturePipeline(embeddingService, metadataService, repository)

  const files = await findMarkdownFiles(FOLDER_PATH)
  const mdFiles = files.filter((f) => !SKIP_PATTERNS.some((p) => p.test(f)))

  process.stderr.write(`Found ${mdFiles.length} markdown files in ${FOLDER_PATH}\n`)

  const existingHashes = await db.execute(
    sql`SELECT obsidian_hash, obsidian_path FROM thoughts WHERE source = 'obsidian' AND obsidian_path IS NOT NULL`,
  )
  const hashSet = new Set(existingHashes.rows.map((r) => r.obsidian_hash as string))
  const pathSet = new Set(existingHashes.rows.map((r) => r.obsidian_path as string))

  let indexed = 0
  let skipped = 0
  let errors = 0

  async function processFile(filePath: string): Promise<void> {
    const relPath = relative(VAULT_PATH, filePath)

    try {
      const raw = await readFile(filePath, 'utf-8')
      const content = raw.trim()

      if (content.length < 20) {
        skipped++
        return
      }

      const hash = contentHash(content)

      if (hashSet.has(hash)) {
        skipped++
        return
      }

      if (pathSet.has(relPath)) {
        await db.execute(
          sql`DELETE FROM thoughts WHERE obsidian_path = ${relPath} AND source = 'obsidian'`,
        )
      }

      const textForAI = truncateForEmbedding(content)
      const title = basename(filePath, '.md')

      const [embedding, metadata] = await Promise.all([
        embeddingService.embed(textForAI),
        metadataService.extract(textForAI).catch(() => ({
          title,
          content_type: 'note' as const,
          tags: [TARGET_FOLDER.toLowerCase()],
          topics: [TARGET_FOLDER.toLowerCase()],
          sentiment: 'neutral' as const,
        })),
      ])

      await repository.create({
        content,
        source: 'obsidian',
        sourceRef: filePath,
        contentType: metadata.content_type,
        title: metadata.title,
        tags: metadata.tags,
        topics: metadata.topics,
        sentiment: metadata.sentiment,
        embedding: [...embedding],
        thoughtAt: undefined,
      })

      await db.execute(
        sql`UPDATE thoughts SET obsidian_path = ${relPath}, obsidian_hash = ${hash} WHERE source = 'obsidian' AND source_ref = ${filePath}`,
      )

      indexed++
      process.stderr.write(`[${indexed}/${mdFiles.length}] ${relPath}\n`)
    } catch (error) {
      errors++
      process.stderr.write(`ERROR: ${relPath} — ${error instanceof Error ? error.message : 'unknown'}\n`)
    }
  }

  for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
    const batch = mdFiles.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(processFile))
  }

  process.stderr.write(`\nDone! Indexed: ${indexed}, Skipped: ${skipped}, Errors: ${errors}\n`)
  await pool.end()
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : 'unknown'}\n`)
  process.exit(1)
})
