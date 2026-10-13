-- Up Migration
CREATE TYPE broadcast_status AS ENUM ('pending', 'sending', 'sent', 'cancelled', 'failed');

CREATE TABLE broadcasts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_admin_id  BIGINT NOT NULL REFERENCES admins(telegram_id),
  segment              VARCHAR(32) NOT NULL,
  recipient_count      INT NOT NULL,
  message_text         TEXT NOT NULL,
  scheduled_for        TIMESTAMPTZ,
  status               broadcast_status NOT NULL DEFAULT 'pending',
  delivered_count      INT NOT NULL DEFAULT 0,
  failed_count         INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at              TIMESTAMPTZ
);

CREATE INDEX idx_broadcasts_scheduled ON broadcasts(scheduled_for) WHERE status = 'pending';

CREATE TABLE system_state (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  paused_all      BOOLEAN NOT NULL DEFAULT false,
  paused_auto     BOOLEAN NOT NULL DEFAULT false,
  paused_pro      BOOLEAN NOT NULL DEFAULT false,
  updated_by      BIGINT REFERENCES admins(telegram_id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Down Migration
DROP TABLE system_state;
DROP TABLE broadcasts;
DROP TYPE broadcast_status;
