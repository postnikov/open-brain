#!/usr/bin/env npx tsx
import { Command } from 'commander'
import { loadConfig, getDatabaseUrl } from './config/loader.js'
import { createDatabase } from './db/connection.js'
import { createThoughtsRepository } from './repository/thoughts.js'
import { createEmbeddingService } from './pipeline/embeddings.js'
import { createMetadataService } from './pipeline/metadata.js'
import { createCapturePipeline } from './pipeline/capture.js'
import { createStreamRepository } from './stream/repository.js'
import { createDistillationRepository } from './distillation/repository.js'
import { createDistillationService } from './distillation/service.js'
import type { ThoughtsRepository } from './repository/types.js'
import type { EmbeddingService } from './pipeline/embeddings.js'
import type { CapturePipeline } from './pipeline/capture.js'
import type { StreamRepository } from './stream/types.js'
import type { DistillationService, DistillationRepository } from './distillation/types.js'
import type { AppConfig } from './config/schema.js'
import pg from 'pg'

interface Services {
  readonly repository: ThoughtsRepository
  readonly embeddingService: EmbeddingService
  readonly pipeline: CapturePipeline
  readonly streamRepository: StreamRepository
  readonly distillationService: DistillationService
  readonly distillationRepo: DistillationRepository
  readonly config: AppConfig
  readonly pool: pg.Pool
}

async function bootstrap(config: AppConfig): Promise<Services> {
  const databaseUrl = getDatabaseUrl(config)
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required')
  }

  const { db, pool } = await createDatabase(databaseUrl)
  const repository = createThoughtsRepository(db)
  const embeddingService = createEmbeddingService(apiKey, config.openai.embedding_model)
  const metadataService = createMetadataService(apiKey, config.openai.metadata_model)
  const pipeline = createCapturePipeline(embeddingService, metadataService, repository)
  const streamRepository = createStreamRepository(db, config.stream.ttl_days)
  const distillationRepo = createDistillationRepository(db)
  const distillationService = createDistillationService(
    streamRepository,
    pipeline,
    distillationRepo,
    {
      model: config.distillation.model,
      temperature: config.distillation.temperature,
      maxBlocksPerRun: config.distillation.max_blocks_per_run,
      minBlockLength: config.distillation.min_block_length,
    },
    apiKey,
  )

  return { repository, embeddingService, pipeline, streamRepository, distillationService, distillationRepo, config, pool }
}

const program = new Command()
  .name('brain')
  .description('Open Brain — personal thought capture and semantic search')
  .version('0.1.0')

program
  .command('save')
  .description('Save a thought')
  .argument('<content>', 'The thought content')
  .option('-s, --source <source>', 'Source', 'cli')
  .option('-t, --type <type>', 'Content type')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(async (content: string, opts: { source: string; type?: string; tags?: string }) => {
    const config = await loadConfig()
    const { pipeline, pool } = await bootstrap(config)

    try {
      const { thought } = await pipeline.capture({
        content,
        source: opts.source,
        contentType: opts.type,
        tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()) : undefined,
      })

      process.stdout.write(`Saved: ${thought.title}\n`)
      process.stdout.write(`ID: ${thought.id}\n`)
      process.stdout.write(`Tags: ${thought.tags?.join(', ') ?? 'none'}\n`)
      process.stdout.write(`Topics: ${thought.topics?.join(', ') ?? 'none'}\n`)
      process.stdout.write(`Type: ${thought.contentType}\n`)
    } finally {
      await pool.end()
    }
  })

program
  .command('search')
  .description('Semantic search')
  .argument('<query>', 'Search query')
  .option('-l, --limit <n>', 'Max results', '10')
  .option('-m, --min-similarity <n>', 'Min similarity', '0.3')
  .action(async (query: string, opts: { limit: string; minSimilarity: string }) => {
    const config = await loadConfig()
    const { embeddingService, repository, pool } = await bootstrap(config)

    try {
      const embedding = await embeddingService.embed(query)
      const results = await repository.search(embedding, parseInt(opts.limit, 10), parseFloat(opts.minSimilarity))

      if (results.length === 0) {
        process.stdout.write('No results found.\n')
        return
      }

      for (const { thought, similarity } of results) {
        process.stdout.write(`\n[${(similarity * 100).toFixed(1)}%] ${thought.title ?? 'Untitled'}\n`)
        process.stdout.write(`  ${thought.content.slice(0, 120)}${thought.content.length > 120 ? '...' : ''}\n`)
        process.stdout.write(`  Tags: ${thought.tags?.join(', ') ?? '-'} | Source: ${thought.source}\n`)
      }
    } finally {
      await pool.end()
    }
  })

program
  .command('recent')
  .description('Show recent thoughts')
  .option('-l, --limit <n>', 'Number of thoughts', '20')
  .option('-s, --source <source>', 'Filter by source')
  .action(async (opts: { limit: string; source?: string }) => {
    const config = await loadConfig()
    const { repository, pool } = await bootstrap(config)

    try {
      const thoughts = await repository.findRecent(parseInt(opts.limit, 10), {
        source: opts.source,
      })

      if (thoughts.length === 0) {
        process.stdout.write('No thoughts found.\n')
        return
      }

      for (const thought of thoughts) {
        const date = thought.createdAt?.toLocaleDateString() ?? '?'
        process.stdout.write(`\n[${date}] ${thought.title ?? 'Untitled'}\n`)
        process.stdout.write(`  ${thought.content.slice(0, 120)}${thought.content.length > 120 ? '...' : ''}\n`)
        process.stdout.write(`  Tags: ${thought.tags?.join(', ') ?? '-'} | Source: ${thought.source}\n`)
      }
    } finally {
      await pool.end()
    }
  })

program
  .command('stats')
  .description('Show database statistics')
  .action(async () => {
    const config = await loadConfig()
    const { repository, pool } = await bootstrap(config)

    try {
      const stats = await repository.getStats()

      process.stdout.write(`\nOpen Brain Statistics\n`)
      process.stdout.write(`${'='.repeat(30)}\n`)
      process.stdout.write(`Total thoughts: ${stats.total}\n`)
      process.stdout.write(`Last 7 days: ${stats.last7Days}\n`)
      process.stdout.write(`Last 30 days: ${stats.last30Days}\n`)

      if (stats.bySource.size > 0) {
        process.stdout.write(`\nBy Source:\n`)
        for (const [source, count] of stats.bySource) {
          process.stdout.write(`  ${source}: ${count}\n`)
        }
      }

      if (stats.byType.size > 0) {
        process.stdout.write(`\nBy Type:\n`)
        for (const [type, count] of stats.byType) {
          process.stdout.write(`  ${type}: ${count}\n`)
        }
      }
    } finally {
      await pool.end()
    }
  })

program
  .command('tags')
  .description('List all tags with counts')
  .action(async () => {
    const config = await loadConfig()
    const { repository, pool } = await bootstrap(config)

    try {
      const tags = await repository.listTags()

      if (tags.size === 0) {
        process.stdout.write('No tags found.\n')
        return
      }

      process.stdout.write(`\nTags (${tags.size} unique)\n`)
      process.stdout.write(`${'='.repeat(30)}\n`)
      for (const [tag, count] of tags) {
        process.stdout.write(`  ${tag}: ${count}\n`)
      }
    } finally {
      await pool.end()
    }
  })

program
  .command('tag-rename')
  .description('Rename or merge a tag')
  .argument('<old>', 'Tag to rename')
  .argument('<new>', 'New tag name')
  .action(async (oldTag: string, newTag: string) => {
    const config = await loadConfig()
    const { repository, pool } = await bootstrap(config)

    try {
      const affected = await repository.renameTag(oldTag, newTag)
      process.stdout.write(`Renamed "${oldTag}" → "${newTag}" (${affected} thoughts affected)\n`)
    } finally {
      await pool.end()
    }
  })

program
  .command('delete')
  .description('Delete a thought by ID')
  .argument('<id>', 'Thought UUID')
  .action(async (id: string) => {
    const config = await loadConfig()
    const { repository, pool } = await bootstrap(config)

    try {
      const thought = await repository.findById(id)
      if (!thought) {
        process.stdout.write(`Thought ${id} not found.\n`)
        return
      }

      await repository.deleteById(id)
      process.stdout.write(`Deleted: ${thought.title ?? 'Untitled'} (${id})\n`)
    } finally {
      await pool.end()
    }
  })

program
  .command('stream')
  .description('Show recent stream blocks')
  .option('-l, --limit <n>', 'Number of blocks', '20')
  .option('-s, --session <id>', 'Filter by session ID')
  .option('--status <status>', 'Filter: pending, distilled, pinned')
  .action(async (opts: { limit: string; session?: string; status?: string }) => {
    const config = await loadConfig()
    const { streamRepository, pool } = await bootstrap(config)

    try {
      const blocks = await streamRepository.findRecent(parseInt(opts.limit, 10), {
        sessionId: opts.session,
        status: opts.status as 'pending' | 'distilled' | 'pinned' | undefined,
      })

      if (blocks.length === 0) {
        process.stdout.write('No stream blocks found.\n')
        return
      }

      for (const block of blocks) {
        const date = block.createdAt?.toLocaleDateString() ?? '?'
        const status = block.distilledAt ? 'distilled' : block.pinned ? 'pinned' : 'pending'
        process.stdout.write(`\n[${date}] [${status}] Session: ${block.sessionId} #${block.blockNumber}\n`)
        if (block.topic) process.stdout.write(`  Topic: ${block.topic}\n`)
        process.stdout.write(`  ${block.content.slice(0, 120)}${block.content.length > 120 ? '...' : ''}\n`)
        if (block.participants) process.stdout.write(`  Participants: ${block.participants.join(', ')}\n`)
      }
    } finally {
      await pool.end()
    }
  })

program
  .command('distill')
  .description('Run distillation — extract thoughts from stream blocks')
  .action(async () => {
    const config = await loadConfig()
    const { distillationService, pool } = await bootstrap(config)

    try {
      process.stdout.write('Starting distillation...\n')
      const result = await distillationService.run('cli')

      process.stdout.write(`\nDistillation Complete\n`)
      process.stdout.write(`${'='.repeat(30)}\n`)
      process.stdout.write(`Status: ${result.status}\n`)
      process.stdout.write(`Blocks processed: ${result.blocksProcessed}\n`)
      process.stdout.write(`Sessions: ${result.sessionsProcessed}\n`)
      process.stdout.write(`Thoughts created: ${result.thoughtsCreated}\n`)
      process.stdout.write(`Blocks skipped: ${result.blocksSkipped}\n`)
      process.stdout.write(`Tokens used: ${result.tokensUsed}\n`)
      process.stdout.write(`Estimated cost: $${result.estimatedCost.toFixed(6)}\n`)
      process.stdout.write(`Duration: ${result.durationMs}ms\n`)

      if (result.errorMessage) {
        process.stdout.write(`Error: ${result.errorMessage}\n`)
      }
    } finally {
      await pool.end()
    }
  })

program
  .command('status')
  .description('Show consolidated brain status')
  .action(async () => {
    const config = await loadConfig()
    const { repository, streamRepository, distillationRepo, pool, config: appConfig } = await bootstrap(config)

    try {
      const [thoughtStats, streamStats, recentRuns, expiringBlocks] = await Promise.all([
        repository.getStats(),
        streamRepository.getStats(),
        distillationRepo.getRecentRuns(10),
        streamRepository.findExpiringBlocks(3),
      ])

      const lastRun = recentRuns[0] ?? null
      const now = Date.now()
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
      const weeklyThoughts = recentRuns
        .filter((r) => r.createdAt && r.createdAt.getTime() > sevenDaysAgo)
        .reduce((sum, r) => sum + r.thoughtsCreated, 0)

      // Compute next cron from config schedule
      const parts = appConfig.distillation.schedule.split(' ')
      const cronHour = parseInt(parts[1] ?? '3', 10)
      const cronMinute = parseInt(parts[0] ?? '0', 10)
      const nextCron = new Date()
      nextCron.setHours(cronHour, cronMinute, 0, 0)
      if (nextCron.getTime() <= now) nextCron.setDate(nextCron.getDate() + 1)

      process.stdout.write(`\nOpen Brain Status\n`)
      process.stdout.write(`${'='.repeat(40)}\n`)

      process.stdout.write(`\nStream\n`)
      process.stdout.write(`  Blocks: ${streamStats.totalBlocks} (${streamStats.pendingBlocks} pending, ${streamStats.distilledBlocks} distilled, ${streamStats.pinnedBlocks} pinned)\n`)
      process.stdout.write(`  Expiring in 3 days: ${expiringBlocks.length}\n`)

      process.stdout.write(`\nDistillation\n`)
      if (lastRun) {
        const agoMs = now - (lastRun.createdAt?.getTime() ?? now)
        const agoHours = Math.round(agoMs / (1000 * 60 * 60))
        process.stdout.write(`  Last run: ${agoHours}h ago (${lastRun.trigger}, ${lastRun.thoughtsCreated} thoughts, $${lastRun.estimatedCost.toFixed(6)})\n`)
      } else {
        process.stdout.write(`  Last run: never\n`)
      }
      process.stdout.write(`  Next cron: ${nextCron.toLocaleTimeString()}\n`)
      process.stdout.write(`  Weekly thoughts extracted: ${weeklyThoughts}\n`)

      process.stdout.write(`\nThoughts\n`)
      process.stdout.write(`  Total: ${thoughtStats.total}\n`)
      process.stdout.write(`  Last 7 days: ${thoughtStats.last7Days}\n`)
      process.stdout.write(`  Last 30 days: ${thoughtStats.last30Days}\n`)

      if (thoughtStats.bySource.size > 0) {
        process.stdout.write(`\n  By source:\n`)
        for (const [source, count] of thoughtStats.bySource) {
          process.stdout.write(`    ${source}: ${count}\n`)
        }
      }
    } finally {
      await pool.end()
    }
  })

program.parseAsync().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : 'Unknown error'}\n`)
  process.exit(1)
})
