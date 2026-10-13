-- Achievement-state routing refactor (Phase 0): add the three columns
-- that turn flow_stage from "source of truth" into an analytics hint.
-- Each column is monotonic — once set, stays set (except via explicit
-- admin reset) — so routing decisions derived from them can't roll
-- backward when async events (postbacks, session expiry) lag.

ALTER TABLE users
  -- Set the first time the user passes CHANNEL_GATE_LAUNCH. Without
  -- this column, channel-gate passage is only recorded by flow_stage
  -- moving past CHANNEL_GATE, which the new routing model can't read.
  ADD COLUMN channel_joined_at TIMESTAMPTZ,
  -- Set the first time we observe the user has funded their IQ
  -- account: either from an Affstore FTD/redeposit postback, from the
  -- balance-poll worker crossing threshold, or from the manual
  -- "I've deposited" button being verified. Population is additive
  -- across all three paths so a postback delay doesn't strand a user
  -- who already deposited (their button-tap will set it instead).
  ADD COLUMN first_deposit_at TIMESTAMPTZ,
  -- Terminal lockout marker for NON_PARTNER_REJECT and SUPPORT_HANDOFF.
  -- The new routing function short-circuits to NON_PARTNER_REJECT
  -- whenever this is non-null, regardless of other flags. Cleared
  -- only via admin reset.
  ADD COLUMN lockout_reason TEXT;

-- Filter aggregations on locked-out users (admin reports, retention
-- math). Partial so the bulk of rows (non-locked) don't bloat it.
CREATE INDEX idx_users_lockout_reason ON users(lockout_reason)
  WHERE lockout_reason IS NOT NULL;

-- Backfill: assume any user past CHANNEL_GATE/WELCOME in the legacy
-- flow_stage already joined the channel. Conservative — uses
-- updated_at as the timestamp because we don't have the original
-- join event recorded anywhere.
UPDATE users
SET channel_joined_at = updated_at
WHERE flow_stage IS NOT NULL
  AND UPPER(flow_stage) NOT IN ('CHANNEL_GATE', 'WELCOME')
  AND channel_joined_at IS NULL;

-- Backfill: derive first_deposit_at from the earliest FTD/redeposit
-- postback we have on file for this user's IQ trader id. iq_postbacks
-- only goes back as far as we've been listening — older deposits
-- without postback rows get caught by the second backfill below.
UPDATE users u
SET first_deposit_at = sub.first_ftd_at
FROM (
  SELECT trader_id, MIN(received_at) AS first_ftd_at
  FROM iq_postbacks
  WHERE event_type IN ('ftd', 'redeposit')
    AND trader_id IS NOT NULL
  GROUP BY trader_id
) sub
WHERE u.iq_trader_id = sub.trader_id
  AND u.first_deposit_at IS NULL;

-- Second backfill: catch users with cached balance above the minimum
-- threshold who don't have a postback row (the postback channel
-- started after they deposited, or it was a manual admin activation).
-- 10 USD is the conservative floor used by depositActivation's auto
-- tier; users below that didn't reach DEPOSIT_GATE confirmation.
UPDATE users
SET first_deposit_at = updated_at
WHERE first_deposit_at IS NULL
  AND iq_balance_cached IS NOT NULL
  AND iq_balance_cached >= 10
  AND agreement_accepted = true;

-- Backfill: existing NON_PARTNER_REJECT users get retroactively
-- locked out so the new routing function refuses to let them past.
-- Without this, they'd keep being routed by the new model based on
-- whatever achievements they have, ignoring the stuck state the old
-- model left them in.
UPDATE users
SET lockout_reason = 'non_partner'
WHERE flow_stage IS NOT NULL
  AND UPPER(flow_stage) = 'NON_PARTNER_REJECT'
  AND lockout_reason IS NULL;

-- Reconcile: users who self-reported "I've signed up" (which sets
-- flow_data.iqAccountConfirmed=true) without the Affstore postback
-- ever landing — their iq_account_confirmed_at column is NULL even
-- though they completed the gate. Backfill the column from the
-- flow_data flag so the new derivation function reads it correctly.
-- COALESCE keeps any already-set column value.
UPDATE users
SET iq_account_confirmed_at = COALESCE(iq_account_confirmed_at, updated_at)
WHERE (flow_data->>'iqAccountConfirmed')::boolean IS TRUE
  AND iq_account_confirmed_at IS NULL;
