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

export const configSchema = z.object({
  database: databaseConfigSchema.default({}),
  openai: openaiConfigSchema.default({}),
  capture: captureConfigSchema.default({}),
})

export type AppConfig = z.infer<typeof configSchema>
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>
export type OpenAIConfig = z.infer<typeof openaiConfigSchema>
