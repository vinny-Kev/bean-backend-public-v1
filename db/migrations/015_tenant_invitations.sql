-- Invitations to join an organization. The invitee proves control of the invited address (a verified
-- account whose email equals email_normalized) and presents the emailed token; only the token's HMAC
-- is stored. status moves pending -> accepted | revoked | expired, once. One pending invitation per
-- (tenant, email); sending again replaces it. Rollback: DROP TABLE tenant_invitations.
CREATE TABLE IF NOT EXISTS tenant_invitations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email_normalized varchar(254) NOT NULL,
    membership_role varchar(20) NOT NULL CHECK (membership_role IN ('owner', 'admin', 'member')),
    token_hash char(64) NOT NULL UNIQUE,
    invited_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    expires_at timestamptz NOT NULL,
    accepted_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (email_normalized = lower(email_normalized))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_invitations_pending
    ON tenant_invitations (tenant_id, email_normalized) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_email
    ON tenant_invitations (email_normalized) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant_created
    ON tenant_invitations (tenant_id, created_at DESC);
