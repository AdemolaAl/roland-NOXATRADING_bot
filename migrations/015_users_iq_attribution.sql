-- IQ account confirmation from the affstore postback path. Distinct
-- from the existing iq_user_id column: that one is set after a
-- successful IQ Option API login (email/password). These three are set
-- the moment the registration postback lands — well before login.
-- Same underlying 7-9 digit identifier; keeping them separate makes
-- provenance obvious in logs and lets a future cross-check assert
-- iq_user_id == iq_trader_id after the user logs in.
ALTER TABLE users
  ADD COLUMN iq_trader_id            VARCHAR(64),
  ADD COLUMN iq_account_confirmed_at TIMESTAMPTZ,
  ADD COLUMN iq_promoter_link        TEXT;

CREATE INDEX idx_users_iq_trader_id ON users(iq_trader_id)
  WHERE iq_trader_id IS NOT NULL;
