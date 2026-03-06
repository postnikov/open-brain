import { sql, desc, eq, and, gte, lte, isNull, type SQL } from 'drizzle-orm'
import { thoughts, dismissedPairs } from '../db/schema.js'
import type { Database } from '../db/connection.js'
import type { Thought, CreateThoughtInput, UpdateThoughtInput, SearchFilters, SearchResult, ThoughtStats, DuplicatePair, ThoughtsRepository } from './types.js'
import { DatabaseError } from '../shared/errors.js'

function toThought(row: typeof thoughts.$inferSelect): Thought {
  return {
    id: row.id,
    content: row.content,
    contentType: row.contentType ?? 'thought',
    source: row.source,
    sourceRef: row.sourceRef,
    title: row.title,
    tags: row.tags,
    topics: row.topics,
    sentiment: row.sentiment,
    weight: row.weight ?? 1.0,
    compostedAt: row.compostedAt,
    epistemicStatus: row.epistemicStatus,
    createdAt: row.createdAt,
    thoughtAt: row.thoughtAt,
    updatedAt: row.updatedAt,
  }
}

function rawRowToThought(row: Record<string, unknown>): Thought {
  return {
    id: row.id as string,
    content: row.content as string,
    contentType: (row.content_type as string) ?? 'thought',
    source: row.source as string,
    sourceRef: row.source_ref as string | null,
    title: row.title as string | null,
    tags: row.tags as string[] | null,
    topics: row.topics as string[] | null,
    sentiment: row.sentiment as string | null,
    weight: (row.weight as number) ?? 1.0,
    compostedAt: row.composted_at ? new Date(row.composted_at as string) : null,
    epistemicStatus: row.epistemic_status as string | null,
    createdAt: row.created_at ? new Date(row.created_at as string) : null,
    thoughtAt: row.thought_at ? new Date(row.thought_at as string) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at as string) : null,
  }
}

function buildFilters(filters?: SearchFilters): SQL[] {
  const conditions: SQL[] = []

  if (filters?.source) {
    conditions.push(eq(thoughts.source, filters.source))
  }
  if (filters?.contentType) {
    conditions.push(eq(thoughts.contentType, filters.contentType))
  }
  if (filters?.fromDate) {
    conditions.push(gte(thoughts.createdAt, filters.fromDate))
  }
  if (filters?.toDate) {
    conditions.push(lte(thoughts.createdAt, filters.toDate))
  }
  if (filters?.tags && filters.tags.length > 0) {
    const tagParams = sql.join(
      filters.tags.map((t) => sql`${t}`),
      sql`,`,
    )
    conditions.push(sql`${thoughts.tags} && ARRAY[${tagParams}]::text[]`)
  }
  if (filters?.epistemicStatus) {
    conditions.push(eq(thoughts.epistemicStatus, filters.epistemicStatus))
  }

  return conditions
}

export function createThoughtsRepository(db: Database): ThoughtsRepository {
  return {
    async create(input: CreateThoughtInput): Promise<Thought> {
      try {
        const [row] = await db
          .insert(thoughts)
          .values({
            content: input.content,
            source: input.source,
            contentType: input.contentType ?? 'thought',
            sourceRef: input.sourceRef ?? null,
            title: input.title ?? null,
            tags: input.tags ? [...input.tags] : null,
            topics: input.topics ? [...input.topics] : null,
            sentiment: input.sentiment ?? null,
            embedding: input.embedding ? [...input.embedding] : null,
            thoughtAt: input.thoughtAt ?? null,
            contentHash: input.contentHash ?? null,
          })
          .returning()

        if (!row) {
          throw new DatabaseError('Insert returned no rows')
        }

        return toThought(row)
      } catch (error) {
        if (error instanceof DatabaseError) throw error
        throw new DatabaseError('Failed to create thought', error)
      }
    },

    async search(
      embedding: readonly number[],
      limit: number,
      minSimilarity: number,
      filters?: SearchFilters,
    ): Promise<readonly SearchResult[]> {
      try {
        const vectorStr = `[${[...embedding].join(',')}]`
        const conditions = buildFilters(filters)
        conditions.push(sql`composted_at IS NULL`)

        const whereClause = sql`WHERE ${and(...conditions)} AND (1 - (${thoughts.embedding} <=> ${vectorStr}::vector)) * COALESCE(weight, 1.0) >= ${minSimilarity}`

        const rows = await db.execute(sql`
          SELECT *,
            (1 - (${thoughts.embedding} <=> ${vectorStr}::vector)) * COALESCE(weight, 1.0) as similarity
          FROM thoughts
          ${whereClause}
          ORDER BY similarity DESC
          LIMIT ${limit}
        `)

        return rows.rows.map((row: Record<string, unknown>) => ({
          thought: rawRowToThought(row),
          similarity: row.similarity as number,
        }))
      } catch (error) {
        throw new DatabaseError('Failed to search thoughts', error)
      }
    },

    async findRecent(limit: number, filters?: SearchFilters): Promise<readonly Thought[]> {
      try {
        const conditions = buildFilters(filters)
        conditions.push(isNull(thoughts.compostedAt))

        const rows = await db
          .select()
          .from(thoughts)
          .where(and(...conditions))
          .orderBy(desc(thoughts.createdAt))
          .limit(limit)

        return rows.map(toThought)
      } catch (error) {
        throw new DatabaseError('Failed to find recent thoughts', error)
      }
    },

    async findById(id: string): Promise<Thought | null> {
      try {
        const [row] = await db.select().from(thoughts).where(eq(thoughts.id, id)).limit(1)
        return row ? toThought(row) : null
      } catch (error) {
        throw new DatabaseError('Failed to find thought by ID', error)
      }
    },

    async findRelated(id: string, limit: number): Promise<readonly SearchResult[]> {
      try {
        const rows = await db.execute(sql`
          SELECT t.*,
            (1 - (t.embedding <=> source.embedding)) as similarity
          FROM thoughts t, thoughts source
          WHERE source.id = ${id}
            AND t.id != ${id}
            AND t.embedding IS NOT NULL
            AND source.embedding IS NOT NULL
            AND t.composted_at IS NULL
          ORDER BY similarity DESC
          LIMIT ${limit}
        `)

        return rows.rows.map((row: Record<string, unknown>) => ({
          thought: rawRowToThought(row),
          similarity: row.similarity as number,
        }))
      } catch (error) {
        throw new DatabaseError('Failed to find related thoughts', error)
      }
    },

    async getStats(): Promise<ThoughtStats> {
      try {
        const now = new Date()
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        const activeFilter = sql`WHERE composted_at IS NULL`

        const [totalResult, sourceRows, typeRows, last7Result, last30Result] = await Promise.all([
          db.execute(sql`SELECT count(*) as count FROM thoughts ${activeFilter}`),
          db.execute(sql`SELECT source, count(*) as count FROM thoughts ${activeFilter} GROUP BY source`),
          db.execute(sql`SELECT content_type, count(*) as count FROM thoughts ${activeFilter} GROUP BY content_type`),
          db.execute(sql`SELECT count(*) as count FROM thoughts ${activeFilter} AND created_at >= ${sevenDaysAgo}`),
          db.execute(sql`SELECT count(*) as count FROM thoughts ${activeFilter} AND created_at >= ${thirtyDaysAgo}`),
        ])

        const bySource = new Map<string, number>()
        for (const row of sourceRows.rows) {
          bySource.set(row.source as string, Number(row.count))
        }

        const byType = new Map<string, number>()
        for (const row of typeRows.rows) {
          byType.set(row.content_type as string, Number(row.count))
        }

        return {
          total: Number(totalResult.rows[0]?.count ?? 0),
          bySource,
          byType,
          last7Days: Number(last7Result.rows[0]?.count ?? 0),
          last30Days: Number(last30Result.rows[0]?.count ?? 0),
        }
      } catch (error) {
        throw new DatabaseError('Failed to get stats', error)
      }
    },

    async listTags(): Promise<ReadonlyMap<string, number>> {
      try {
        const rows = await db.execute(sql`
          SELECT tag, count(*) as count
          FROM thoughts, unnest(tags) as tag
          WHERE composted_at IS NULL
          GROUP BY tag
          ORDER BY count DESC
        `)

        const result = new Map<string, number>()
        for (const row of rows.rows) {
          result.set(row.tag as string, Number(row.count))
        }
        return result
      } catch (error) {
        throw new DatabaseError('Failed to list tags', error)
      }
    },

    async renameTag(oldTag: string, newTag: string): Promise<number> {
      try {
        const result = await db.execute(sql`
          UPDATE thoughts
          SET tags = array_replace(tags, ${oldTag}, ${newTag}),
              updated_at = NOW()
          WHERE ${oldTag} = ANY(tags)
          RETURNING id
        `)
        return result.rows.length
      } catch (error) {
        throw new DatabaseError('Failed to rename tag', error)
      }
    },

    async deleteById(id: string): Promise<boolean> {
      try {
        const result = await db.delete(thoughts).where(eq(thoughts.id, id)).returning({ id: thoughts.id })
        return result.length > 0
      } catch (error) {
        throw new DatabaseError('Failed to delete thought', error)
      }
    },

    async update(id: string, input: UpdateThoughtInput): Promise<Thought | null> {
      try {
        const updates = {
          updatedAt: sql`NOW()`,
          ...(input.content !== undefined && { content: input.content }),
          ...(input.title !== undefined && { title: input.title }),
          ...(input.tags !== undefined && { tags: [...input.tags] }),
          ...(input.embedding !== undefined && { embedding: [...input.embedding] }),
          ...(input.weight !== undefined && { weight: input.weight }),
          ...(input.epistemicStatus !== undefined && { epistemicStatus: input.epistemicStatus }),
        }

        const [row] = await db
          .update(thoughts)
          .set(updates)
          .where(eq(thoughts.id, id))
          .returning()

        return row ? toThought(row) : null
      } catch (error) {
        throw new DatabaseError('Failed to update thought', error)
      }
    },

    async removeTagFromThought(thoughtId: string, tag: string): Promise<boolean> {
      try {
        const result = await db.execute(sql`
          UPDATE thoughts
          SET tags = array_remove(tags, ${tag}),
              updated_at = NOW()
          WHERE id = ${thoughtId}
            AND ${tag} = ANY(tags)
          RETURNING id
        `)
        return result.rows.length > 0
      } catch (error) {
        throw new DatabaseError('Failed to remove tag from thought', error)
      }
    },

    async findByTag(tag: string): Promise<readonly Thought[]> {
      try {
        const rows = await db
          .select()
          .from(thoughts)
          .where(sql`${tag} = ANY(${thoughts.tags})`)
          .orderBy(desc(thoughts.createdAt))
        return rows.map(toThought)
      } catch (error) {
        throw new DatabaseError('Failed to find thoughts by tag', error)
      }
    },

    async compost(id: string): Promise<Thought | null> {
      try {
        const [row] = await db
          .update(thoughts)
          .set({ compostedAt: sql`NOW()`, updatedAt: sql`NOW()` })
          .where(eq(thoughts.id, id))
          .returning()
        return row ? toThought(row) : null
      } catch (error) {
        throw new DatabaseError('Failed to compost thought', error)
      }
    },

    async uncompost(id: string): Promise<Thought | null> {
      try {
        const [row] = await db
          .update(thoughts)
          .set({ compostedAt: null, updatedAt: sql`NOW()` })
          .where(eq(thoughts.id, id))
          .returning()
        return row ? toThought(row) : null
      } catch (error) {
        throw new DatabaseError('Failed to restore thought', error)
      }
    },

    async findComposted(): Promise<readonly Thought[]> {
      try {
        const rows = await db
          .select()
          .from(thoughts)
          .where(sql`${thoughts.compostedAt} IS NOT NULL`)
          .orderBy(desc(thoughts.compostedAt))
        return rows.map(toThought)
      } catch (error) {
        throw new DatabaseError('Failed to find composted thoughts', error)
      }
    },

    async cleanupCompost(days: number): Promise<number> {
      try {
        const result = await db
          .delete(thoughts)
          .where(sql`${thoughts.compostedAt} IS NOT NULL AND ${thoughts.compostedAt} < NOW() - INTERVAL '1 day' * ${days}`)
          .returning({ id: thoughts.id })
        return result.length
      } catch (error) {
        throw new DatabaseError('Failed to cleanup compost', error)
      }
    },

    async findByEpistemicStatus(status: string, limit: number): Promise<readonly Thought[]> {
      try {
        const rows = await db
          .select()
          .from(thoughts)
          .where(and(eq(thoughts.epistemicStatus, status), isNull(thoughts.compostedAt)))
          .orderBy(desc(thoughts.createdAt))
          .limit(limit)
        return rows.map(toThought)
      } catch (error) {
        throw new DatabaseError('Failed to find thoughts by epistemic status', error)
      }
    },

    async findForReview(daysAgo: number, limit: number): Promise<readonly Thought[]> {
      try {
        const now = new Date()
        const from = new Date(now.getTime() - (daysAgo + 1) * 24 * 60 * 60 * 1000)
        const to = new Date(now.getTime() - (daysAgo - 1) * 24 * 60 * 60 * 1000)

        const rows = await db
          .select()
          .from(thoughts)
          .where(and(
            isNull(thoughts.compostedAt),
            gte(thoughts.createdAt, from),
            lte(thoughts.createdAt, to),
          ))
          .orderBy(desc(thoughts.createdAt))
          .limit(limit)
        return rows.map(toThought)
      } catch (error) {
        throw new DatabaseError('Failed to find thoughts for review', error)
      }
    },

    async searchTimeline(
      embedding: readonly number[],
      limit: number,
      minSimilarity: number,
    ): Promise<readonly SearchResult[]> {
      try {
        const vectorStr = `[${[...embedding].join(',')}]`

        const rows = await db.execute(sql`
          SELECT *,
            (1 - (${thoughts.embedding} <=> ${vectorStr}::vector)) * COALESCE(weight, 1.0) as similarity
          FROM thoughts
          WHERE composted_at IS NULL
            AND (1 - (${thoughts.embedding} <=> ${vectorStr}::vector)) * COALESCE(weight, 1.0) >= ${minSimilarity}
          ORDER BY created_at ASC
          LIMIT ${limit}
        `)

        return rows.rows.map((row: Record<string, unknown>) => ({
          thought: rawRowToThought(row),
          similarity: row.similarity as number,
        }))
      } catch (error) {
        throw new DatabaseError('Failed to search timeline', error)
      }
    },

    async addTagToThoughts(ids: readonly string[], tag: string): Promise<number> {
      try {
        const result = await db.execute(sql`
          UPDATE thoughts
          SET tags = CASE
              WHEN tags IS NULL THEN ARRAY[${tag}]
              WHEN ${tag} = ANY(tags) THEN tags
              ELSE array_append(tags, ${tag})
            END,
            updated_at = NOW()
          WHERE id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`,`)}]::uuid[])
          RETURNING id
        `)
        return result.rows.length
      } catch (error) {
        throw new DatabaseError('Failed to add tag to thoughts', error)
      }
    },

    async findDuplicates(minSimilarity: number, limit: number): Promise<readonly DuplicatePair[]> {
      try {
        const rows = await db.execute(sql`
          SELECT
            a.id as a_id, a.content as a_content, a.content_type as a_content_type,
            a.source as a_source, a.source_ref as a_source_ref, a.title as a_title,
            a.tags as a_tags, a.topics as a_topics, a.sentiment as a_sentiment,
            a.weight as a_weight, a.composted_at as a_composted_at,
            a.epistemic_status as a_epistemic_status,
            a.created_at as a_created_at, a.thought_at as a_thought_at, a.updated_at as a_updated_at,
            b.id as b_id, b.content as b_content, b.content_type as b_content_type,
            b.source as b_source, b.source_ref as b_source_ref, b.title as b_title,
            b.tags as b_tags, b.topics as b_topics, b.sentiment as b_sentiment,
            b.weight as b_weight, b.composted_at as b_composted_at,
            b.epistemic_status as b_epistemic_status,
            b.created_at as b_created_at, b.thought_at as b_thought_at, b.updated_at as b_updated_at,
            (1 - (a.embedding <=> b.embedding)) as similarity
          FROM thoughts a
          JOIN thoughts b ON a.id < b.id
          WHERE a.composted_at IS NULL AND b.composted_at IS NULL
            AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
            AND (1 - (a.embedding <=> b.embedding)) > ${minSimilarity}
            AND NOT EXISTS (
              SELECT 1 FROM dismissed_pairs d
              WHERE d.id_a = a.id AND d.id_b = b.id
            )
          ORDER BY similarity DESC
          LIMIT ${limit}
        `)

        return rows.rows.map((row: Record<string, unknown>) => ({
          thoughtA: {
            id: row.a_id as string,
            content: row.a_content as string,
            contentType: (row.a_content_type as string) ?? 'thought',
            source: row.a_source as string,
            sourceRef: row.a_source_ref as string | null,
            title: row.a_title as string | null,
            tags: row.a_tags as string[] | null,
            topics: row.a_topics as string[] | null,
            sentiment: row.a_sentiment as string | null,
            weight: (row.a_weight as number) ?? 1.0,
            compostedAt: row.a_composted_at ? new Date(row.a_composted_at as string) : null,
            epistemicStatus: row.a_epistemic_status as string | null,
            createdAt: row.a_created_at ? new Date(row.a_created_at as string) : null,
            thoughtAt: row.a_thought_at ? new Date(row.a_thought_at as string) : null,
            updatedAt: row.a_updated_at ? new Date(row.a_updated_at as string) : null,
          },
          thoughtB: {
            id: row.b_id as string,
            content: row.b_content as string,
            contentType: (row.b_content_type as string) ?? 'thought',
            source: row.b_source as string,
            sourceRef: row.b_source_ref as string | null,
            title: row.b_title as string | null,
            tags: row.b_tags as string[] | null,
            topics: row.b_topics as string[] | null,
            sentiment: row.b_sentiment as string | null,
            weight: (row.b_weight as number) ?? 1.0,
            compostedAt: row.b_composted_at ? new Date(row.b_composted_at as string) : null,
            epistemicStatus: row.b_epistemic_status as string | null,
            createdAt: row.b_created_at ? new Date(row.b_created_at as string) : null,
            thoughtAt: row.b_thought_at ? new Date(row.b_thought_at as string) : null,
            updatedAt: row.b_updated_at ? new Date(row.b_updated_at as string) : null,
          },
          similarity: row.similarity as number,
        }))
      } catch (error) {
        throw new DatabaseError('Failed to find duplicates', error)
      }
    },

    async mergeThoughts(keepId: string, removeId: string): Promise<Thought | null> {
      try {
        const [keep, remove] = await Promise.all([
          db.select().from(thoughts).where(eq(thoughts.id, keepId)).limit(1),
          db.select().from(thoughts).where(eq(thoughts.id, removeId)).limit(1),
        ])
        if (!keep[0] || !remove[0]) return null

        const keepRow = keep[0]
        const removeRow = remove[0]

        const mergedTags = [...new Set([
          ...(keepRow.tags ?? []),
          ...(removeRow.tags ?? []),
        ])]
        const mergedTopics = [...new Set([
          ...(keepRow.topics ?? []),
          ...(removeRow.topics ?? []),
        ])]

        const [updated] = await db
          .update(thoughts)
          .set({
            tags: mergedTags.length > 0 ? mergedTags : null,
            topics: mergedTopics.length > 0 ? mergedTopics : null,
            updatedAt: sql`NOW()`,
          })
          .where(eq(thoughts.id, keepId))
          .returning()

        await db.delete(thoughts).where(eq(thoughts.id, removeId))

        return updated ? toThought(updated) : null
      } catch (error) {
        throw new DatabaseError('Failed to merge thoughts', error)
      }
    },

    async dismissPair(idA: string, idB: string): Promise<void> {
      try {
        const [first, second] = idA < idB ? [idA, idB] : [idB, idA]
        await db.insert(dismissedPairs).values({ idA: first, idB: second }).onConflictDoNothing()
      } catch (error) {
        throw new DatabaseError('Failed to dismiss pair', error)
      }
    },
  }
}
