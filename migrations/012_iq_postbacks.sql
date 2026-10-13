-- Mirror of the Affstore Leads Report Telegram chat.
-- The bot listens for channel_post / message updates from that one
-- chat, parses the message text (Registration / FTD / re-deposit lines,
-- with optional amount + country + Link/afftrack), and inserts here.
-- Read at admin token-approval and the auto-verifier so trader
-- attribution is a local Postgres lookup, no external API.
CREATE TABLE iq_postbacks (
  id BIGSERIAL PRIMARY KEY,
  trader_id TEXT NOT NULL,
  -- 'registration' | 'ftd' | 'redeposit' | 'payout' | 'other'
  event_type TEXT NOT NULL,
  raw_event TEXT,
  amount NUMERIC,
  country_code TEXT,
  -- The 'Link:<afftrack>' field — sub-promoter / campaign owner.
  -- Roland's users carry 'roland'; sibling Uplivon funnels carry
  -- 'policee', 'VetraXpolycarp', 'Uplivonteam', etc. We persist all
  -- of them so admin views can attribute correctly; the auto-verifier
  -- still only auto-approves when afftrack === 'roland'.
  afftrack TEXT,
  raw_text TEXT,
  source_chat_id BIGINT,
  source_message_id BIGINT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Natural dedup: one postback row per Telegram message. If Telegram
-- redelivers the message (network blip on our side), the upsert is a
-- no-op rather than a duplicate row. Partial index allows manual
-- backfill rows without source coords.
CREATE UNIQUE INDEX iq_postbacks_source_msg_idx
  ON iq_postbacks(source_chat_id, source_message_id)
  WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL;

-- Hot path: admin lookup by trader_id, sub-millisecond at any scale.
CREATE INDEX iq_postbacks_trader_id_idx ON iq_postbacks(trader_id);

-- Per-afftrack filtering for sub-promoter attribution and analytics.
CREATE INDEX iq_postbacks_afftrack_idx ON iq_postbacks(afftrack)
  WHERE afftrack IS NOT NULL;

-- Filter aggregations by event_type (registration vs deposit branches).
CREATE INDEX iq_postbacks_event_type_idx ON iq_postbacks(event_type);

-- Track which token requests bypassed manual review. Keeps analytics
-- distinguishable: total requests vs auto-approved vs admin-approved.
-- Auto-approvals leave approved_by_admin_id NULL (no admin involved)
-- and set auto_approved=true.
ALTER TABLE token_requests
  ADD COLUMN auto_approved BOOLEAN NOT NULL DEFAULT false;

-- Make admin attribution nullable on unlock_tokens so auto-issued
-- tokens can record "no admin involved" without using a sentinel ID.
-- Existing rows are unaffected since they all have a real admin id
-- from manual issuance.
ALTER TABLE unlock_tokens
  ALTER COLUMN issued_by_admin_id DROP NOT NULL;
