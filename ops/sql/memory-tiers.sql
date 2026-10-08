-- Additive memory-tiers migration (2026-10): tier, explicit supersede chain, validity end,
-- open counters and a mandatory source reference. Existing values are never rewritten:
-- only NULL source_ref is filled, with markers that ops/sql/memory-tiers-rollback.sql can
-- recognise and clear. Vault path repair is separate (ops/memory-db.mjs repair-paths).
-- The caller owns the transaction: migrate.ts and memory-db.mjs wrap this file in BEGIN/COMMIT.
SET LOCAL lock_timeout = '10s';
-- Block concurrent writers (reads stay available) so the backfill and the constraint agree.
LOCK TABLE thoughts IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'pointer';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS supersedes uuid;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS superseded_by uuid;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS supersede_reason text;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS valid_to timestamptz;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS open_count integer NOT NULL DEFAULT 0;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS last_opened_at timestamptz;

-- Legacy distilled thoughts (before durable distillation) recover their run from the log.
UPDATE thoughts t
SET source_ref = json_build_object('distillation_run_id', l.id, 'legacy', true)::text
FROM (
  SELECT DISTINCT ON (tid) tid, id FROM distillation_log, unnest(thought_ids) AS tid ORDER BY tid, created_at
) l
WHERE t.source = 'distillation' AND (t.source_ref IS NULL OR t.source_ref = '') AND t.id::text = l.tid;
-- Everything else without a source is marked honestly instead of inventing one.
UPDATE thoughts SET source_ref = 'unattributed:' || source WHERE source_ref IS NULL OR source_ref = '';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thoughts_tier_check') THEN
    ALTER TABLE thoughts ADD CONSTRAINT thoughts_tier_check CHECK (tier IN ('hot', 'pointer', 'source'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thoughts_supersedes_fk') THEN
    ALTER TABLE thoughts ADD CONSTRAINT thoughts_supersedes_fk FOREIGN KEY (supersedes) REFERENCES thoughts(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thoughts_superseded_by_fk') THEN
    ALTER TABLE thoughts ADD CONSTRAINT thoughts_superseded_by_fk FOREIGN KEY (superseded_by) REFERENCES thoughts(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thoughts_source_ref_required') THEN
    ALTER TABLE thoughts ADD CONSTRAINT thoughts_source_ref_required CHECK (source_ref IS NOT NULL AND source_ref <> '');
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_thoughts_live ON thoughts (created_at DESC) WHERE superseded_by IS NULL AND composted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_superseded_by ON thoughts (superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_tier ON thoughts (tier);
-- Imported vault notes are full copies of a source; everything else starts as a pointer.
UPDATE thoughts SET tier = 'source' WHERE source = 'obsidian' AND tier = 'pointer';
