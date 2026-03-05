import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { CapturePipeline } from '../pipeline/capture.js'
import type { EmbeddingService } from '../pipeline/embeddings.js'
import type { ThoughtsRepository, SearchFilters } from '../repository/types.js'
import { logger } from '../shared/logger.js'

export function registerTools(
  server: McpServer,
  pipeline: CapturePipeline,
  embeddingService: EmbeddingService,
  repository: ThoughtsRepository,
): void {
  server.registerTool(
    'brain_save',
    {
      description: 'Save a thought, idea, or note. Automatically generates embeddings, extracts title, tags, topics, and sentiment.',
      inputSchema: {
        content: z.string().min(1).describe('The thought or note content to save'),
        source: z.string().default('api').describe('Source: api, cli, telegram, obsidian'),
        content_type: z.string().optional().describe('Type: thought, note, idea, question, observation, decision'),
        tags: z.array(z.string()).optional().describe('Manual tags (auto-extracted if empty)'),
        thought_at: z.string().optional().describe('When the thought occurred (ISO date)'),
      },
    },
    async (args) => {
      try {
        const { thought } = await pipeline.capture({
          content: args.content,
          source: args.source,
          contentType: args.content_type,
          tags: args.tags,
          thoughtAt: args.thought_at ? new Date(args.thought_at) : undefined,
        })

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                id: thought.id,
                title: thought.title,
                tags: thought.tags,
                topics: thought.topics,
                content_type: thought.contentType,
                sentiment: thought.sentiment,
              }, null, 2),
            },
          ],
        }
      } catch (error) {
        logger.error({ err: error }, 'brain_save failed')
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'brain_search',
    {
      description: 'Semantic search across all saved thoughts. Find related ideas by meaning, not just keywords.',
      inputSchema: {
        query: z.string().min(1).describe('Semantic search query'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
        min_similarity: z.number().min(0).max(1).default(0.3).describe('Minimum cosine similarity'),
        source: z.string().optional().describe('Filter by source'),
        content_type: z.string().optional().describe('Filter by content type'),
        tags: z.array(z.string()).optional().describe('Filter by tags (ANY match)'),
        from_date: z.string().optional().describe('Filter: from date (ISO)'),
        to_date: z.string().optional().describe('Filter: to date (ISO)'),
      },
    },
    async (args) => {
      try {
        const embedding = await embeddingService.embed(args.query)

        const filters: SearchFilters = {
          source: args.source,
          contentType: args.content_type,
          tags: args.tags,
          fromDate: args.from_date ? new Date(args.from_date) : undefined,
          toDate: args.to_date ? new Date(args.to_date) : undefined,
        }

        const results = await repository.search(embedding, args.limit, args.min_similarity, filters)

        const response = {
          results: results.map((r) => ({
            id: r.thought.id,
            content: r.thought.content,
            title: r.thought.title,
            tags: r.thought.tags,
            similarity: Math.round(r.similarity * 1000) / 1000,
            source: r.thought.source,
            created_at: r.thought.createdAt?.toISOString() ?? null,
          })),
          total: results.length,
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        }
      } catch (error) {
        logger.error({ err: error }, 'brain_search failed')
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'brain_recent',
    {
      description: 'Get the most recently saved thoughts. Optionally filter by source or content type.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('Number of recent thoughts'),
        source: z.string().optional().describe('Filter by source'),
        content_type: z.string().optional().describe('Filter by content type'),
      },
    },
    async (args) => {
      try {
        const thoughts = await repository.findRecent(args.limit, {
          source: args.source,
          contentType: args.content_type,
        })

        const response = {
          thoughts: thoughts.map((t) => ({
            id: t.id,
            content: t.content,
            title: t.title,
            tags: t.tags,
            source: t.source,
            content_type: t.contentType,
            created_at: t.createdAt?.toISOString() ?? null,
          })),
          total: thoughts.length,
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        }
      } catch (error) {
        logger.error({ err: error }, 'brain_recent failed')
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'brain_related',
    {
      description: 'Find thoughts semantically related to a given thought by its ID. Uses the stored embedding to find similar entries without an extra API call.',
      inputSchema: {
        thought_id: z.string().uuid().describe('UUID of the thought to find related entries for'),
        limit: z.number().int().min(1).max(20).default(5).describe('Max related thoughts to return'),
      },
    },
    async (args) => {
      try {
        const source = await repository.findById(args.thought_id)
        if (!source) {
          return {
            content: [{ type: 'text' as const, text: `Thought ${args.thought_id} not found` }],
            isError: true,
          }
        }

        const results = await repository.findRelated(args.thought_id, args.limit)

        const response = {
          source: {
            id: source.id,
            title: source.title,
            tags: source.tags,
          },
          related: results.map((r) => ({
            id: r.thought.id,
            content: r.thought.content,
            title: r.thought.title,
            tags: r.thought.tags,
            similarity: Math.round(r.similarity * 1000) / 1000,
            source: r.thought.source,
            created_at: r.thought.createdAt?.toISOString() ?? null,
          })),
          total: results.length,
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        }
      } catch (error) {
        logger.error({ err: error }, 'brain_related failed')
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'brain_stats',
    {
      description: 'Get statistics about the thought database: total count, breakdown by source/type, activity over 7/30 days.',
    },
    async () => {
      try {
        const stats = await repository.getStats()

        const response = {
          total: stats.total,
          by_source: Object.fromEntries(stats.bySource),
          by_type: Object.fromEntries(stats.byType),
          last_7_days: stats.last7Days,
          last_30_days: stats.last30Days,
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        }
      } catch (error) {
        logger.error({ err: error }, 'brain_stats failed')
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'brain_tags',
    {
      description: 'List all tags with their usage counts, sorted by frequency.',
    },
    async () => {
      try {
        const tags = await repository.listTags()

        const response = {
          tags: Array.from(tags.entries()).map(([tag, count]) => ({ tag, count })),
          total_unique: tags.size,
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        }
      } catch (error) {
        logger.error({ err: error }, 'brain_tags failed')
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'brain_tag_rename',
    {
      description: 'Rename or merge a tag across all thoughts. If new_tag already exists on some thoughts, the tags are merged (no duplicates).',
      inputSchema: {
        old_tag: z.string().min(1).describe('Tag to rename'),
        new_tag: z.string().min(1).describe('New tag name (or existing tag to merge into)'),
      },
    },
    async (args) => {
      try {
        const affected = await repository.renameTag(args.old_tag, args.new_tag)

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              renamed: args.old_tag,
              to: args.new_tag,
              thoughts_affected: affected,
            }, null, 2),
          }],
        }
      } catch (error) {
        logger.error({ err: error }, 'brain_tag_rename failed')
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'brain_delete',
    {
      description: 'Delete a thought by its UUID. Returns whether the thought was found and deleted.',
      inputSchema: {
        thought_id: z.string().uuid().describe('UUID of the thought to delete'),
      },
    },
    async (args) => {
      try {
        const thought = await repository.findById(args.thought_id)
        if (!thought) {
          return {
            content: [{ type: 'text' as const, text: `Thought ${args.thought_id} not found` }],
            isError: true,
          }
        }

        await repository.deleteById(args.thought_id)

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              deleted: true,
              id: thought.id,
              title: thought.title,
            }, null, 2),
          }],
        }
      } catch (error) {
        logger.error({ err: error }, 'brain_delete failed')
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        }
      }
    },
  )

  logger.info('All MCP tools registered')
}
