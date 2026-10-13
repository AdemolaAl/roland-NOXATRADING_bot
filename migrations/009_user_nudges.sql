-- Up Migration
-- Track inactivity-nudge state per user so the worker can escalate cadence
-- (1h → 6h → 24h → 72h → stop) and respect opt-outs.
ALTER TABLE users
  ADD COLUMN nudge_count       INT NOT NULL DEFAULT 0,
  ADD COLUMN nudges_paused_at  TIMESTAMPTZ;

-- Down Migration
ALTER TABLE users
  DROP COLUMN nudges_paused_at,
  DROP COLUMN nudge_count;
