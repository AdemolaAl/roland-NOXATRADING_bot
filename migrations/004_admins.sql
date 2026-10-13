-- Up Migration
CREATE TYPE admin_role AS ENUM ('super_admin', 'admin');

CREATE TABLE admins (
  telegram_id      BIGINT PRIMARY KEY,
  username         VARCHAR(64),
  display_name     VARCHAR(128) NOT NULL,
  role             admin_role NOT NULL DEFAULT 'admin',
  added_by         BIGINT REFERENCES admins(telegram_id),
  added_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at       TIMESTAMPTZ
);

CREATE INDEX idx_admins_active ON admins(removed_at) WHERE removed_at IS NULL;

CREATE TABLE audit_log (
  id                  BIGSERIAL PRIMARY KEY,
  admin_telegram_id   BIGINT NOT NULL REFERENCES admins(telegram_id),
  action_type         VARCHAR(64) NOT NULL,
  target_type         VARCHAR(32),
  target_id           VARCHAR(64),
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_admin ON audit_log(admin_telegram_id, created_at DESC);

-- Down Migration
DROP TABLE audit_log;
DROP TABLE admins;
DROP TYPE admin_role;
