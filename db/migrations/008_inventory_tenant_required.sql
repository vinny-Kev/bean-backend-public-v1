-- Every new inventory row must belong to a tenant. Tenant-scoped routes and the
-- integration worker never read tenantless rows, and uq_inventory_tenant_sku ignores them.
--
-- NOT VALID: the constraint applies to every INSERT/UPDATE from now on but does not
-- check existing rows, so legacy tenantless rows (two in the shared development
-- database on 2026-10-28) are left untouched rather than guessed into a tenant.
-- Reconcile them by hand (see db/reconciliation/2026-10-28-legacy-data.md), then run:
--     ALTER TABLE inventory VALIDATE CONSTRAINT inventory_tenant_required;
-- and, once validated, optionally ALTER COLUMN tenant_id SET NOT NULL.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_tenant_required') THEN
        ALTER TABLE inventory ADD CONSTRAINT inventory_tenant_required CHECK (tenant_id IS NOT NULL) NOT VALID;
    END IF;
END $$;
