-- Up Migration
CREATE TYPE user_tier AS ENUM ('demo', 'auto', 'pro');
CREATE TYPE user_account_mode AS ENUM ('demo', 'live');
CREATE TYPE user_status AS ENUM ('active', 'paused', 'suspended', 'force_demo');
CREATE TYPE timeframe AS ENUM ('30s', '1m', '2m', '5m');

CREATE TABLE users (
  telegram_id              BIGINT PRIMARY KEY,
  telegram_username        VARCHAR(64),
  iq_user_id               VARCHAR(64),
  iq_email                 VARCHAR(255),
  iq_session_token         TEXT,
  iq_session_expires_at    TIMESTAMPTZ,
  iq_balance_cached        DECIMAL(12,2),
  iq_balance_cached_at     TIMESTAMPTZ,
  partner_code_verified    BOOLEAN NOT NULL DEFAULT false,
  tier                     user_tier NOT NULL DEFAULT 'demo',
  account_mode             user_account_mode NOT NULL DEFAULT 'demo',
  agreement_accepted       BOOLEAN NOT NULL DEFAULT false,
  timeframe                timeframe,
  base_stake               DECIMAL(10,2),
  live_win_count           INT NOT NULL DEFAULT 0,
  status                   user_status NOT NULL DEFAULT 'active',
  suspension_reason        TEXT,
  flow_stage               VARCHAR(64) NOT NULL DEFAULT 'welcome',
  flow_data                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_last_activity ON users(last_activity);
CREATE INDEX idx_users_tier_status ON users(tier, status);

-- Down Migration
DROP TABLE users;
DROP TYPE timeframe;
DROP TYPE user_status;
DROP TYPE user_account_mode;
DROP TYPE user_tier;
