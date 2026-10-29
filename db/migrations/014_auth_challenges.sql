-- One-time codes and tokens for email verification, sign-in step-up, password reset, email change and
-- sensitive actions, plus remembered ("trusted") devices.
--
-- Only an HMAC of each code/token is stored (secret_hash); the plaintext is emailed once and never
-- kept or logged. A challenge is bound to its user, its purpose and (for email codes) the address it
-- was sent to. At most one live (unconsumed, unsuperseded) challenge exists per (user, purpose):
-- issuing a new one supersedes the previous one. Attempts are counted in the row; a challenge that
-- reaches max_attempts can no longer be used. Rollback: DROP TABLE trusted_devices, auth_challenges.
CREATE TABLE IF NOT EXISTS auth_challenges (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose varchar(30) NOT NULL
        CHECK (purpose IN ('verify_email', 'login_step_up', 'password_reset', 'email_change', 'sensitive_action')),
    kind varchar(5) NOT NULL CHECK (kind IN ('otp', 'token')),
    email varchar(254),
    context jsonb NOT NULL DEFAULT '{}'::jsonb,
    secret_hash char(64) NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    superseded_at timestamptz,
    request_ip_hash char(64),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_challenges_live
    ON auth_challenges (user_id, purpose) WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_challenges_token
    ON auth_challenges (secret_hash) WHERE kind = 'token';
CREATE INDEX IF NOT EXISTS idx_auth_challenges_user_purpose_created
    ON auth_challenges (user_id, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges (expires_at);

CREATE TABLE IF NOT EXISTS trusted_devices (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash char(64) NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices (user_id);
