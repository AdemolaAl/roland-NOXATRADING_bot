-- Per-click attribution rows minted whenever the bot renders the IQ
-- Option signup URL. The 'click_id' is embedded in the URL as a query
-- param; Affstore echoes it back on the registration S2S postback, which
-- lets us atomically match the post-signup callback to the original
-- Telegram user without ever asking the user for their IQ ID.
--
-- One row per render. Unmatched rows pile up forever — they're cheap
-- and feed funnel analytics ("how many clicks never registered").
CREATE TABLE click_attributions (
  click_id           TEXT PRIMARY KEY,
  -- FK uses default ON DELETE behaviour (NO ACTION). Roland never
  -- hard-deletes users — moderation uses users.status='suspended'.
  -- If that ever changes, switch to ON DELETE SET NULL to preserve
  -- funnel rows after a purge.
  telegram_id        BIGINT NOT NULL REFERENCES users(telegram_id),
  -- 'auto' | 'pro' | 'unknown'. Recorded at mint time from flow_data
  -- so the post-signup DM can route the user back to the right scene
  -- (tokenRequest if they picked a tier already, loginEmail otherwise).
  tier_intent        VARCHAR(16) NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Populated atomically by the first registration postback that wins
  -- the race. Frozen once set (markMatched uses WHERE matched_at IS NULL).
  matched_at         TIMESTAMPTZ,
  matched_trader_id  VARCHAR(64),
  matched_via        VARCHAR(16)   -- 's2s' | 'manual'
);

-- For analytics dashboards: count unmatched rows older than N hours.
CREATE INDEX idx_click_attributions_unmatched
  ON click_attributions(created_at)
  WHERE matched_at IS NULL;

-- For admin spelunking: "show all click attempts for a telegram_id".
CREATE INDEX idx_click_attributions_telegram
  ON click_attributions(telegram_id);
