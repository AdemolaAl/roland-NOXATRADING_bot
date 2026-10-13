-- Up Migration
CREATE TABLE funnel_events (
  id                  BIGSERIAL PRIMARY KEY,
  user_telegram_id    BIGINT NOT NULL REFERENCES users(telegram_id),
  event_type          VARCHAR(32) NOT NULL,
  payload             JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_funnel_user_type ON funnel_events(user_telegram_id, event_type);
CREATE INDEX idx_funnel_created ON funnel_events(created_at);

-- Down Migration
DROP TABLE funnel_events;
