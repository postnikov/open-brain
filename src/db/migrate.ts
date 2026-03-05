import pg from 'pg'
import pgvector from 'pgvector/pg'
import { logger } from '../shared/logger.js'
import { loadConfig, getDatabaseUrl } from '../config/loader.js'

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS thoughts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  content_type  VARCHAR(20) DEFAULT 'thought',
  source        VARCHAR(50) NOT NULL,
  source_ref    TEXT,

  title         TEXT,
  tags          TEXT[],
  topics        TEXT[],
  sentiment     VARCHAR(20),

  embedding     vector(1536),

  created_at    TIMESTAMPTZ DEFAULT NOW(),
  thought_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  obsidian_path TEXT,
  obsidian_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_thoughts_tags ON thoughts USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_thoughts_source ON thoughts (source);
CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_type ON thoughts (content_type);
`

const HNSW_INDEX_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_thoughts_embedding_hnsw'
  ) THEN
    CREATE INDEX idx_thoughts_embedding_hnsw
    ON thoughts USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
  END IF;
END
$$;
`

const WAVE2_SQL = `
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS weight REAL DEFAULT 1.0;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS composted_at TIMESTAMPTZ;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS epistemic_status VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_thoughts_composted ON thoughts (composted_at) WHERE composted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_epistemic ON thoughts (epistemic_status) WHERE epistemic_status IS NOT NULL;
`

const ACTIVITY_LOG_SQL = `
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name VARCHAR(100) NOT NULL,
  client_name VARCHAR(255),
  client_version VARCHAR(50),
  session_id VARCHAR(36),
  status VARCHAR(20) NOT NULL DEFAULT 'success',
  duration_ms INTEGER,
  input_summary TEXT,
  output_summary TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_tool ON activity_log (tool_name);
CREATE INDEX IF NOT EXISTS idx_activity_client ON activity_log (client_name);
`

const DISMISSED_PAIRS_SQL = `
CREATE TABLE IF NOT EXISTS dismissed_pairs (
  id_a UUID NOT NULL,
  id_b UUID NOT NULL,
  dismissed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id_a, id_b)
);
`

async function migrate(): Promise<void> {
  const config = await loadConfig()
  const url = getDatabaseUrl(config)

  const pool = new pg.Pool({ connectionString: url })

  const client = await pool.connect()

  try {
    await pgvector.registerTypes(client)
    logger.info('Running migrations...')

    await client.query(MIGRATION_SQL)
    logger.info('Base schema created')

    await client.query(HNSW_INDEX_SQL)
    logger.info('HNSW vector index created')

    await client.query(WAVE2_SQL)
    logger.info('Wave 2 columns added (weight, composted_at, epistemic_status)')

    await client.query(DISMISSED_PAIRS_SQL)
    logger.info('Dismissed pairs table created')

    await client.query(ACTIVITY_LOG_SQL)
    logger.info('Activity log table created')

    logger.info('Migrations complete')
  } catch (error) {
    logger.error({ err: error }, 'Migration failed')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

migrate().catch((error) => {
  logger.error({ error }, 'Migration script failed')
  process.exit(1)
})
