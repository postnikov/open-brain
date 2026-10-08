-- Rollback for memory-tiers.sql. Returns legacy rows to their pre-migration NULL source_ref
-- (only values carrying the migration's own markers) and drops the new constraints, so the
-- previous code can run. Columns stay: old code ignores them and their data is kept.
-- Vault path repair is rolled back separately from its evidence file (ops/memory-db.mjs).
-- Supersede/valid_to marks made after the migration are kept in columns but become
-- invisible to old code — inspect before relying on this rollback after real use.
SET LOCAL lock_timeout = '10s';
LOCK TABLE thoughts IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_source_ref_required;
ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_tier_check;
UPDATE thoughts SET source_ref = NULL WHERE source_ref = 'unattributed:' || source;
UPDATE thoughts SET source_ref = NULL
WHERE source = 'distillation' AND source_ref LIKE '{"distillation_run_id"%' AND source_ref LIKE '%"legacy" : true}';
