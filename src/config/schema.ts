import { z } from 'zod'

export const databaseConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().default('open_brain'),
  user: z.string().default('open_brain'),
  password: z.string().default('open_brain_local'),
})

export const openaiConfigSchema = z.object({
  embedding_model: z.string().default('text-embedding-3-small'),
  metadata_model: z.string().default('gpt-4o-mini'),
})

export const captureConfigSchema = z.object({
  auto_tag: z.boolean().default(true),
  auto_title: z.boolean().default(true),
})

export const streamConfigSchema = z.object({
  ttl_days: z.number().int().min(1).max(365).default(30),
  cleanup_on_startup: z.boolean().default(true),
})

export const distillationConfigSchema = z.object({
  retry_base_ms: z.number().int().min(1000).default(60_000),
  retry_max_ms: z.number().int().min(1000).default(3_600_000),
  retry_max_attempts: z.number().int().min(1).max(100).default(8),
  retry_poll_ms: z.number().int().min(1000).default(60_000),
  enabled: z.boolean().default(true),
  schedule: z.string().default('0 3 * * *'),
  model: z.string().default('gpt-4o-mini'),
  temperature: z.number().min(0).max(2).default(0.3),
  max_blocks_per_run: z.number().int().min(1).max(1000).default(200),
  min_block_length: z.number().int().min(0).max(10000).default(50),
})

// Two-step recall and tiering (memory consilium 2026-09-28, Max answers 2026-10-08).
export const memoryConfigSchema = z.object({
  // false: a missing source_ref is stored as `unattributed:<source>` and reported back;
  // true: brain_save rejects it. Flip after clients (Codex snippet, facade) pass it.
  require_source_ref: z.boolean().default(false),
  recall_limit: z.number().int().min(1).max(10).default(8),
  recall_min_similarity: z.number().min(0).max(1).default(0.35),
  hot_boost: z.number().min(0).max(0.5).default(0.05),
  hot_min_opens: z.number().int().min(1).default(2),
  hot_window_days: z.number().int().min(1).default(14),
  cool_after_days: z.number().int().min(1).default(30),
  tier_refresh_hours: z.number().int().min(1).max(168).default(24),
})

export const configSchema = z.object({
  database: databaseConfigSchema.default({}),
  openai: openaiConfigSchema.default({}),
  capture: captureConfigSchema.default({}),
  stream: streamConfigSchema.default({}),
  distillation: distillationConfigSchema.default({}),
  memory: memoryConfigSchema.default({}),
})

export type AppConfig = z.infer<typeof configSchema>
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>
export type OpenAIConfig = z.infer<typeof openaiConfigSchema>
