-- Additive durable distillation migration. Rehearse on an isolated restore first.
BEGIN;
SET LOCAL lock_timeout = '10s';
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
ALTER TABLE distillation_retry_jobs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE distillation_retry_jobs ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false;
ALTER TABLE distillation_retry_jobs ADD COLUMN IF NOT EXISTS last_error text;
CREATE INDEX IF NOT EXISTS idx_retry_due ON distillation_retry_jobs(next_attempt_at) WHERE state <> 'complete' AND NOT blocked;
CREATE TABLE IF NOT EXISTS distillation_ai_calls (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES distillation_retry_jobs(id),
  phase text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'unknown',
  tokens integer,
  estimated_cost double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_distillation_ai_job ON distillation_ai_calls(job_id);

-- Row locks serialize reservations with deletes/pins; old clients cannot bypass this.
CREATE OR REPLACE FUNCTION protect_stream_distillation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(OLD.session_id,OLD.block_number,OLD.content,OLD.topic,OLD.participants,OLD.source_client)
       IS DISTINCT FROM ROW(NEW.session_id,NEW.block_number,NEW.content,NEW.topic,NEW.participants,NEW.source_client) THEN
      RAISE EXCEPTION 'Stream input is immutable; use a new block_number';
    END IF;
    IF OLD.pinned IS DISTINCT FROM NEW.pinned AND EXISTS (
      SELECT 1 FROM distillation_retry_inputs i JOIN distillation_retry_jobs j ON j.id=i.job_id
      WHERE i.block_id=OLD.id AND j.state <> 'complete'
    ) THEN RAISE EXCEPTION 'Stream block is reserved by unfinished distillation'; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM distillation_retry_inputs i JOIN distillation_retry_jobs j ON j.id=i.job_id
    WHERE i.block_id=OLD.id AND j.state='complete'
  ) THEN RAISE EXCEPTION 'Stream deletion requires durable completed distillation'; END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS protect_stream_distillation ON stream;
CREATE TRIGGER protect_stream_distillation BEFORE UPDATE OR DELETE ON stream
FOR EACH ROW EXECUTE FUNCTION protect_stream_distillation();
COMMIT;
