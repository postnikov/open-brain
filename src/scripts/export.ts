import { loadConfig, getDatabaseUrl } from '../config/loader.js'
import { createDatabase } from '../db/connection.js'
import { createThoughtsRepository } from '../repository/thoughts.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const FORMAT = process.argv[2] ?? 'json'
const OUTPUT_DIR = process.argv[3] ?? join(process.cwd(), 'export')

async function exportThoughts(): Promise<void> {
  const config = await loadConfig()
  const { db, pool } = await createDatabase(getDatabaseUrl(config))
  const repository = createThoughtsRepository(db)

  const thoughts = await repository.findRecent(10000)

  await mkdir(OUTPUT_DIR, { recursive: true })

  if (FORMAT === 'json') {
    const data = thoughts.map((t) => ({
      id: t.id,
      content: t.content,
      title: t.title,
      content_type: t.contentType,
      source: t.source,
      tags: t.tags,
      topics: t.topics,
      sentiment: t.sentiment,
      created_at: t.createdAt?.toISOString() ?? null,
      thought_at: t.thoughtAt?.toISOString() ?? null,
    }))

    const path = join(OUTPUT_DIR, `open-brain-export-${new Date().toISOString().slice(0, 10)}.json`)
    await writeFile(path, JSON.stringify(data, null, 2))
    process.stderr.write(`Exported ${data.length} thoughts to ${path}\n`)
  }

  if (FORMAT === 'markdown') {
    for (const thought of thoughts) {
      const slug = (thought.title ?? thought.id)
        .replace(/[^a-zA-Z0-9а-яА-ЯёЁ\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 60)

      const frontmatter = [
        '---',
        `id: ${thought.id}`,
        `title: "${(thought.title ?? '').replace(/"/g, '\\"')}"`,
        `source: ${thought.source}`,
        `type: ${thought.contentType}`,
        `tags: [${(thought.tags ?? []).join(', ')}]`,
        `created: ${thought.createdAt?.toISOString() ?? ''}`,
        '---',
        '',
      ].join('\n')

      const path = join(OUTPUT_DIR, `${slug}.md`)
      await writeFile(path, frontmatter + thought.content)
    }
    process.stderr.write(`Exported ${thoughts.length} thoughts as markdown to ${OUTPUT_DIR}\n`)
  }

  await pool.end()
}

exportThoughts().catch((error) => {
  process.stderr.write(`Export failed: ${error instanceof Error ? error.message : 'unknown'}\n`)
  process.exit(1)
})
