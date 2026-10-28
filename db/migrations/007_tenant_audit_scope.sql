-- Audit isolation. audit_logs had no tenant column, so the only audit listing was
-- global and showed every tenant's history to any AUDIT_READ holder.
--
-- * audit_logs.tenant_id records the tenant an entry belongs to. Account-level
--   entries (logins) stay NULL. The foreign key has no ON DELETE action, so audit
--   history blocks a hard delete of its tenant (tenants are soft-deleted by status).
-- * PLATFORM_AUDIT_READ guards the global, cross-tenant views (GET /audit/all and
--   GET /integrations/diagnostics/unauthorized). It is granted to no role here;
--   assign it explicitly to platform operators.
-- * Tenant owners/admins with AUDIT_READ read their own tenant through
--   GET /audit/tenants/:tenant_id, which only returns rows with that tenant_id.
--
-- Existing rows are NOT backfilled: they stay tenant_id NULL and are visible only
-- through the platform view. See db/reconciliation/2026-10-28-legacy-data.md for an optional,
-- reviewable backfill. Idempotent; no existing grant or row is changed.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tenant_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_tenant_id_fkey') THEN
        ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_tenant_id_fkey
            FOREIGN KEY (tenant_id) REFERENCES tenants(id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS audit_logs_tenant_time_idx
    ON audit_logs (tenant_id, created_at DESC, id DESC) WHERE tenant_id IS NOT NULL;

INSERT INTO permissions (name, description)
VALUES ('PLATFORM_AUDIT_READ', 'Read the global, cross-tenant audit log and unattributed integration attempts (platform operators only).')
ON CONFLICT (name) DO NOTHING;
