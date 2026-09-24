-- STAGED ONLY: apply to an isolated restore first. Not wired into production bootstrap.
BEGIN;
CREATE TABLE IF NOT EXISTS distillation_retry_jobs (
  id uuid PRIMARY KEY,
  input_snapshot jsonb NOT NULL,
  config_snapshot jsonb NOT NULL,
  extraction jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','partial','complete')),
  lease_owner uuid,
  lease_until timestamptz,
  generation bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS distillation_retry_inputs (
  block_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES distillation_retry_jobs(id),
  input_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retry_inputs_job ON distillation_retry_inputs(job_id);
CREATE TABLE IF NOT EXISTS distillation_retry_items (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES distillation_retry_jobs(id),
  item_index integer NOT NULL,
  payload jsonb NOT NULL,
  thought_id uuid, -- Durable outcome survives deliberate thought deletion.
  UNIQUE(job_id,item_index)
);
CREATE INDEX IF NOT EXISTS idx_retry_items_job ON distillation_retry_items(job_id);
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS distillation_item_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_distillation_item ON thoughts(distillation_item_id) WHERE distillation_item_id IS NOT NULL;
COMMIT;
