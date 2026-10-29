-- Replay protection for retried form submissions (for example creating an organization twice).
-- A client sends an Idempotency-Key header; the first request stores its response here in the same
-- transaction as its effects, and a retry with the same key returns that stored response instead of
-- doing the work again. Rows older than a day are deleted opportunistically by the application.
-- Rollback: DROP TABLE idempotency_keys.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope varchar(40) NOT NULL,
    key varchar(100) NOT NULL,
    request_hash char(64) NOT NULL,
    status_code integer,
    response_body jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, scope, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys (created_at);
