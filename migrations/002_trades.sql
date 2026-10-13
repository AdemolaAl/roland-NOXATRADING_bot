-- Up Migration
CREATE TYPE trade_direction AS ENUM ('call', 'put');
CREATE TYPE trade_outcome AS ENUM ('win', 'loss', 'aborted');

CREATE TABLE trades (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_telegram_id    BIGINT NOT NULL REFERENCES users(telegram_id),
  trade_num           INT NOT NULL,
  pair_code           VARCHAR(32) NOT NULL,
  pair_flag           VARCHAR(8) NOT NULL,
  direction           trade_direction NOT NULL,
  timeframe           timeframe NOT NULL,
  account_mode        user_account_mode NOT NULL,
  base_stake          DECIMAL(10,2) NOT NULL,
  gale_steps          JSONB NOT NULL DEFAULT '[]'::jsonb,
  final_outcome       trade_outcome,
  win_step            INT,
  net_result          DECIMAL(12,2),
  pro_session_id      UUID,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ
);

CREATE INDEX idx_trades_user_started ON trades(user_telegram_id, started_at DESC);
CREATE INDEX idx_trades_started_won ON trades(started_at) WHERE final_outcome = 'win';
CREATE INDEX idx_trades_pro_session ON trades(pro_session_id) WHERE pro_session_id IS NOT NULL;

-- Down Migration
DROP TABLE trades;
DROP TYPE trade_outcome;
DROP TYPE trade_direction;
