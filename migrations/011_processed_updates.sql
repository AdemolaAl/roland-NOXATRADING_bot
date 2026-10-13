-- Up Migration
-- Track Telegram update IDs we've already processed. Webhooks have at-least-once
-- delivery semantics: Telegram retries 5xx responses with backoff for ~24h. Without
-- this table, a handler that side-effects (places a trade, sends a message) and
-- then 5xx's would re-execute the side effect on every retry. Insert with
-- ON CONFLICT DO NOTHING and check rowCount: 1 = first delivery, 0 = duplicate.
CREATE TABLE processed_updates (
  update_id BIGINT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Used by the periodic cleanup job (future work) to prune rows older than
-- the Telegram retry window. Without an index a DELETE WHERE processed_at < ...
-- would scan the whole table.
CREATE INDEX idx_processed_updates_processed_at ON processed_updates (processed_at);

-- Down Migration
DROP INDEX IF EXISTS idx_processed_updates_processed_at;
DROP TABLE IF EXISTS processed_updates;
