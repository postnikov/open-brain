import { sql, desc, eq, and, gte, lte, isNull, inArray, type SQL } from 'drizzle-orm'
import { thoughts, dismissedPairs } from '../db/schema.js'
import type { Database } from '../db/connection.js'
import { memoryStatus, type Thought, type CreateThoughtInput, type UpdateThoughtInput, type SearchFilters, type SearchResult, type ThoughtStats, type DuplicatePair, type OrphanTag, type ThoughtsRepository, type MemoryTier, type RecallPointer, type SupersedeInput, type TierPolicy, type TierRefresh } from './types.js'
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
    tier: row.tier as MemoryTier,
    supersedes: row.supersedes,
    supersededBy: row.supersededBy,
    supersededAt: row.supersededAt,
    supersedeReason: row.supersedeReason,
    validTo: row.validTo,
    openCount: row.openCount,
    lastOpenedAt: row.lastOpenedAt,
  }
}

const date = (v: unknown): Date | null => (v ? new Date(v as string) : null)

/** Default visibility: not replaced and still valid. Raw SQL callers use the same predicate. */
const LIVE_SQL = sql.raw('superseded_by IS NULL AND (valid_to IS NULL OR valid_to > NOW())')
const liveFor = (alias: string) => sql.raw(`${alias}.superseded_by IS NULL AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > NOW())`)

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
    tier: ((row.tier as string) ?? 'pointer') as MemoryTier,
    supersedes: (row.supersedes as string | null) ?? null,
    supersededBy: (row.superseded_by as string | null) ?? null,
    supersededAt: date(row.superseded_at),
    supersedeReason: (row.supersede_reason as string | null) ?? null,
    validTo: date(row.valid_to),
    openCount: Number(row.open_count ?? 0),
    lastOpenedAt: date(row.last_opened_at),
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
  if (!filters?.includeInactive) {
    conditions.push(LIVE_SQL)
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
            validTo: input.validTo ?? null,
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

    async createSuperseding(input: CreateThoughtInput, supersede: SupersedeInput): Promise<Thought> {
      try {
        return await db.transaction(async (tx) => {
          // Row lock: two concurrent replacements of the same thought cannot both win.
          const old = await tx.execute(sql`SELECT id, superseded_by FROM thoughts WHERE id = ${supersede.supersedes} FOR UPDATE`)
          const target = old.rows[0]
          if (!target) throw new DatabaseError(`Thought ${supersede.supersedes} not found`)
          if (target.superseded_by) throw new DatabaseError(`Thought ${supersede.supersedes} is already superseded by ${String(target.superseded_by)}; supersede the newer one`)
          const [row] = await tx.insert(thoughts).values({
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
            validTo: input.validTo ?? null,
            supersedes: supersede.supersedes,
          }).returning()
          if (!row) throw new DatabaseError('Insert returned no rows')
          await tx.update(thoughts).set({
            supersededBy: row.id,
            supersededAt: sql`NOW()`,
            supersedeReason: supersede.reason ?? null,
            updatedAt: sql`NOW()`,
          }).where(eq(thoughts.id, supersede.supersedes))
          return toThought(row)
        })
      } catch (error) {
        if (error instanceof DatabaseError) throw error
        throw new DatabaseError('Failed to create superseding thought', error)
      }
    },

    async unsupersede(id: string): Promise<Thought | null> {
      try {
        const [row] = await db.update(thoughts)
          .set({ supersededBy: null, supersededAt: null, supersedeReason: null, updatedAt: sql`NOW()` })
          .where(eq(thoughts.id, id))
          .returning()
        return row ? toThought(row) : null
      } catch (error) {
        throw new DatabaseError('Failed to restore superseded thought', error)
      }
    },

    async recall(embedding, limit, minSimilarity, hotBoost, includeInactive = false): Promise<readonly RecallPointer[]> {
      try {
        const vectorStr = `[${[...embedding].join(',')}]`
        const live = includeInactive ? sql`TRUE` : LIVE_SQL
        // Pointers only: the text column is never selected here.
        const rows = await db.execute(sql`
          SELECT id, title, thought_at, created_at, content_type, tier, source, source_ref, superseded_by, valid_to,
            (1 - (embedding <=> ${vectorStr}::vector)) * COALESCE(weight, 1.0) AS similarity,
            (1 - (embedding <=> ${vectorStr}::vector)) * COALESCE(weight, 1.0) + CASE WHEN tier = 'hot' THEN ${hotBoost}::float8 ELSE 0 END AS ranked
          FROM thoughts
          WHERE composted_at IS NULL AND embedding IS NOT NULL AND ${live}
            AND (1 - (embedding <=> ${vectorStr}::vector)) * COALESCE(weight, 1.0) >= ${minSimilarity}
          ORDER BY ranked DESC
          LIMIT ${limit}
        `)
        return rows.rows.map((row: Record<string, unknown>) => ({
          id: row.id as string,
          title: row.title as string | null,
          date: date(row.thought_at) ?? date(row.created_at),
          contentType: (row.content_type as string) ?? 'thought',
          tier: row.tier as MemoryTier,
          source: row.source as string,
          sourceRef: row.source_ref as string,
          status: memoryStatus({ supersededBy: row.superseded_by as string | null, validTo: date(row.valid_to) }),
          score: Number(row.ranked),
        }))
      } catch (error) {
        throw new DatabaseError('Failed to recall thoughts', error)
      }
    },

    async open(ids: readonly string[]): Promise<readonly Thought[]> {
      if (ids.length === 0) return []
      try {
        const rows = await db.update(thoughts)
          .set({ openCount: sql`${thoughts.openCount} + 1`, lastOpenedAt: sql`NOW()` })
          .where(inArray(thoughts.id, [...ids]))
          .returning()
        const byId = new Map(rows.map((r) => [r.id, toThought(r)]))
        return ids.flatMap((id) => byId.get(id) ?? [])
      } catch (error) {
        throw new DatabaseError('Failed to open thoughts', error)
      }
    },

    async refreshTiers(policy: TierPolicy): Promise<TierRefresh> {
      try {
        // Nightly consolidation (Max 2026-10-08, q3): tier and replacement candidates are
        // decided here, never at write time. Source copies keep their tier.
        const promoted = await db.execute(sql`
          UPDATE thoughts SET tier = 'hot'
          WHERE tier = 'pointer' AND open_count >= ${policy.hotMinOpens}
            AND last_opened_at > NOW() - INTERVAL '1 day' * ${policy.hotWindowDays}
          RETURNING id`)
        const demoted = await db.execute(sql`
          UPDATE thoughts SET tier = 'pointer'
          WHERE tier = 'hot' AND (last_opened_at IS NULL OR last_opened_at < NOW() - INTERVAL '1 day' * ${policy.coolAfterDays})
          RETURNING id`)
        // A distilled "contradiction" may replace an older thought. Only a person or an explicit
        // supersede call decides that; consolidation just marks the candidate for review.
        const tagged = await db.execute(sql`
          UPDATE thoughts SET tags = array_append(COALESCE(tags, ARRAY[]::text[]), 'supersede-candidate')
          WHERE content_type = 'contradiction' AND supersedes IS NULL AND superseded_by IS NULL
            AND NOT ('supersede-candidate' = ANY(COALESCE(tags, ARRAY[]::text[])))
          RETURNING id`)
        return { promoted: promoted.rows.length, demoted: demoted.rows.length, candidatesTagged: tagged.rows.length }
      } catch (error) {
        throw new DatabaseError('Failed to refresh memory tiers', error)
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
            AND ${liveFor('t')}
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
        const activeFilter = sql`WHERE composted_at IS NULL AND ${LIVE_SQL}`

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
          WHERE composted_at IS NULL AND ${LIVE_SQL}
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

    async findOrphanTags(): Promise<readonly OrphanTag[]> {
      try {
        const rows = await db.execute(sql`
          SELECT o.tag, t.*
          FROM (
            SELECT tag, (array_agg(id))[1] AS thought_id
            FROM thoughts, unnest(tags) AS tag
            WHERE composted_at IS NULL AND ${LIVE_SQL}
            GROUP BY tag
            HAVING count(*) = 1
          ) o
          JOIN thoughts t ON t.id = o.thought_id
          ORDER BY o.tag
        `)

        return rows.rows.map((row) => ({
          tag: row.tag as string,
          thought: rawRowToThought(row),
        }))
      } catch (error) {
        throw new DatabaseError('Failed to find orphan tags', error)
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
          ...(input.title !== undefined && { title: input.title }),
          ...(input.tags !== undefined && { tags: [...input.tags] }),
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
          .where(and(eq(thoughts.epistemicStatus, status), isNull(thoughts.compostedAt), LIVE_SQL))
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
            LIVE_SQL,
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
          WHERE composted_at IS NULL AND ${LIVE_SQL}
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
            to_jsonb(a) - 'embedding' AS a,
            to_jsonb(b) - 'embedding' AS b,
            (1 - (a.embedding <=> b.embedding)) as similarity
          FROM thoughts a
          JOIN thoughts b ON a.id < b.id
          WHERE a.composted_at IS NULL AND b.composted_at IS NULL
            AND ${liveFor('a')} AND ${liveFor('b')}
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
          thoughtA: rawRowToThought(row.a as Record<string, unknown>),
          thoughtB: rawRowToThought(row.b as Record<string, unknown>),
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

        // Merge never deletes: the removed duplicate is marked as replaced by the kept one.
        return await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(thoughts)
            .set({
              tags: mergedTags.length > 0 ? mergedTags : null,
              topics: mergedTopics.length > 0 ? mergedTopics : null,
              updatedAt: sql`NOW()`,
            })
            .where(eq(thoughts.id, keepId))
            .returning()
          await tx.update(thoughts)
            .set({ supersededBy: keepId, supersededAt: sql`NOW()`, supersedeReason: 'merged duplicate', updatedAt: sql`NOW()` })
            .where(eq(thoughts.id, removeId))
          return updated ? toThought(updated) : null
        })
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
