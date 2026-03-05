import { pgTable, uuid, text, varchar, timestamp, real, index, primaryKey, customType } from 'drizzle-orm/pg-core'

const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return 'vector(1536)'
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`
  },
  fromDriver(value: unknown): number[] {
    const str = String(value)
    return str
      .slice(1, -1)
      .split(',')
      .map(Number)
  },
})

export const thoughts = pgTable(
  'thoughts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    content: text('content').notNull(),
    contentType: varchar('content_type', { length: 20 }).default('thought'),
    source: varchar('source', { length: 50 }).notNull(),
    sourceRef: text('source_ref'),

    title: text('title'),
    tags: text('tags').array(),
    topics: text('topics').array(),
    sentiment: varchar('sentiment', { length: 20 }),

    embedding: vector('embedding'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    thoughtAt: timestamp('thought_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),

    weight: real('weight').default(1.0),
    compostedAt: timestamp('composted_at', { withTimezone: true }),
    epistemicStatus: varchar('epistemic_status', { length: 20 }),

    obsidianPath: text('obsidian_path'),
    obsidianHash: text('obsidian_hash'),
  },
  (table) => [
    index('idx_thoughts_tags').using('gin', table.tags),
    index('idx_thoughts_source').on(table.source),
    index('idx_thoughts_created').on(table.createdAt),
    index('idx_thoughts_type').on(table.contentType),
  ],
)

export const dismissedPairs = pgTable(
  'dismissed_pairs',
  {
    idA: uuid('id_a').notNull(),
    idB: uuid('id_b').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.idA, table.idB] }),
  ],
)

export type ThoughtRecord = typeof thoughts.$inferSelect
export type NewThoughtRecord = typeof thoughts.$inferInsert
