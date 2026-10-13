-- Additive columns for the S2S webhook ingestion path. Existing
-- channel-sourced rows keep working (source defaults to 'channel',
-- clickid stays NULL — they were collected before clickid existed).
ALTER TABLE iq_postbacks
  ADD COLUMN clickid             TEXT,
  ADD COLUMN source              TEXT NOT NULL DEFAULT 'channel',
  ADD COLUMN s2s_idempotency_key TEXT;

-- Dedup retries from Affstore. Affstore's event_id is globally unique
-- per delivery, so the UNIQUE index makes the INSERT a no-op on retries.
-- Partial so legacy (channel-sourced) rows without an event_id can
-- coexist without conflict.
CREATE UNIQUE INDEX iq_postbacks_s2s_idem_idx
  ON iq_postbacks(s2s_idempotency_key)
  WHERE s2s_idempotency_key IS NOT NULL;

-- For attribution: lookup-by-clickid is the path we hit on every
-- registration postback. Partial so rows without a clickid (FTD/
-- redeposit postbacks that don't carry one) don't waste index space.
CREATE INDEX iq_postbacks_clickid_idx
  ON iq_postbacks(clickid)
  WHERE clickid IS NOT NULL;
