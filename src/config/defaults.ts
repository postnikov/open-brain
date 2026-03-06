import type { AppConfig } from './schema.js'

export const DEFAULT_CONFIG: AppConfig = {
  database: {
    host: 'localhost',
    port: 5432,
    database: 'open_brain',
    user: 'open_brain',
    password: 'open_brain_local',
  },
  openai: {
    embedding_model: 'text-embedding-3-small',
    metadata_model: 'gpt-4o-mini',
  },
  capture: {
    auto_tag: true,
    auto_title: true,
  },
  stream: {
    ttl_days: 30,
    cleanup_on_startup: true,
  },
  distillation: {
    enabled: true,
    schedule: '0 3 * * *',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_blocks_per_run: 200,
    min_block_length: 50,
  },
}
