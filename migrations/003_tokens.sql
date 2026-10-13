-- Up Migration
CREATE TYPE token_request_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE unlock_tokens (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     VARCHAR(32) UNIQUE NOT NULL,
  tier                     user_tier NOT NULL CHECK (tier IN ('auto', 'pro')),
  bound_iq_user_id         VARCHAR(64) NOT NULL,
  issued_by_admin_id       BIGINT NOT NULL,
  issued_to_telegram_id    BIGINT,
  redeemed_at              TIMESTAMPTZ,
  revoked_at               TIMESTAMPTZ,
  revoked_by_admin_id      BIGINT,
  revoke_reason            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tokens_bound_iq ON unlock_tokens(bound_iq_user_id);
CREATE INDEX idx_tokens_unredeemed ON unlock_tokens(created_at) WHERE redeemed_at IS NULL;

CREATE TABLE token_requests (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_telegram_id         BIGINT NOT NULL REFERENCES users(telegram_id),
  requested_tier           user_tier NOT NULL CHECK (requested_tier IN ('auto', 'pro')),
  iq_user_id               VARCHAR(64),
  reason                   TEXT,
  status                   token_request_status NOT NULL DEFAULT 'pending',
  approved_by_admin_id     BIGINT,
  issued_token_id          UUID REFERENCES unlock_tokens(id),
  rejection_reason         TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ
);

CREATE INDEX idx_requests_pending ON token_requests(created_at) WHERE status = 'pending';

-- Down Migration
DROP TABLE token_requests;
DROP TABLE unlock_tokens;
DROP TYPE token_request_status;
