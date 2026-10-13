-- Durable tier-intent column.
--
-- Demo tier intent previously lived ONLY in the volatile
-- flow_data.requestedTier blob: auto/pro eventually set users.tier and
-- live set account_mode, but demo had no durable backing column.
-- account_mode defaults to 'demo' for brand-new users (migration 001),
-- so it can't distinguish "explicitly picked demo" from "hasn't picked
-- yet" — which is why getRequestedTier() falls through to null when
-- flow_data.requestedTier is dropped.
--
-- Any flow_data overwrite that lost requestedTier therefore made
-- getRequestedTier() return null, whereShouldUserBe() route the user
-- back to WELCOME, and sceneRehydrateMw eject them from IQ_ACCOUNT_GATE
-- before their "Create my IQ Option account" tap was dispatched — the
-- callback hit a scene with no handler and the button silently did
-- nothing. This column is written at tier-pick and survives flow_data
-- churn, restoring the robustness the flow_stage-based reference had.
ALTER TABLE users
  ADD COLUMN requested_tier user_tier;

-- Backfill in-flight users from the legacy flow_data location so the
-- column is populated for anyone mid-onboarding at deploy time.
UPDATE users
SET requested_tier = (flow_data->>'requestedTier')::user_tier
WHERE flow_data->>'requestedTier' IN ('demo', 'auto', 'pro')
  AND requested_tier IS NULL;

-- Backfill live-mode users (past the deposit gate) whose flow_data may
-- have been cleared: their durable account_mode proves a paid tier was
-- chosen. Use their current tier when it's auto/pro, else default to
-- auto (the minimum live tier — matches getRequestedTier's failsafe).
UPDATE users
SET requested_tier = CASE WHEN tier IN ('auto', 'pro') THEN tier ELSE 'auto'::user_tier END
WHERE account_mode = 'live'
  AND requested_tier IS NULL;
