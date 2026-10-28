# Legacy data reconciliation (2026-10-28 integrity audit)

Migrations 006–009 change no existing rows. The items below were found in the shared
development database by read-only aggregate queries on 2026-10-28. Each needs an
explicit decision by someone who knows what the data is; nothing here should be run
by automation. Run every statement inside a transaction, inspect the result, and only
then `COMMIT`.

## 1. Inventory rows without a tenant (2 rows)

Tenant routes and the integration worker never read these rows, and migration 008
blocks new ones. While unreconciled, the rows can't be updated (the NOT VALID check
still applies to UPDATE) and `VALIDATE CONSTRAINT` fails.

Inspect:

```sql
SELECT id, name, sku, quantity, unit, created_at, updated_at
FROM inventory WHERE tenant_id IS NULL ORDER BY id;

-- Earlier audit entries can show who created or changed each row:
SELECT id, user_id, action, created_at, new_data
FROM audit_logs WHERE table_name = 'inventory' AND record_id IN (SELECT id FROM inventory WHERE tenant_id IS NULL)
ORDER BY record_id, created_at;
```

Then for each row choose one:

```sql
BEGIN;
-- (a) It belongs to a known tenant. Fails with uq_inventory_tenant_sku if that
--     tenant already has the SKU; resolve the duplicate first.
UPDATE inventory SET tenant_id = <tenant_id>, updated_at = NOW() WHERE id = <id> AND tenant_id IS NULL;
-- (b) It is test or obsolete data: export it, then remove it.
-- DELETE FROM inventory WHERE id = <id> AND tenant_id IS NULL;
COMMIT;
```

Once no tenantless rows remain:

```sql
ALTER TABLE inventory VALIDATE CONSTRAINT inventory_tenant_required;
-- Optional, after validation succeeds:
ALTER TABLE inventory ALTER COLUMN tenant_id SET NOT NULL;
```

## 2. A tenant with no owner (1 tenant)

The membership API keeps at least one owner, so this tenant was created outside the
API (or its owner row was removed by hand). Nobody can manage its members.

```sql
SELECT t.id, t.name, t.slug, t.status, t.created_at,
       (SELECT COUNT(*) FROM tenant_members m WHERE m.tenant_id = t.id) AS members
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM tenant_members m WHERE m.tenant_id = t.id AND m.membership_role = 'owner');
```

Decide who owns it, then:

```sql
BEGIN;
INSERT INTO tenant_members (tenant_id, user_id, membership_role) VALUES (<tenant_id>, <user_id>, 'owner')
ON CONFLICT (tenant_id, user_id) DO UPDATE SET membership_role = 'owner';
INSERT INTO audit_logs (user_id, tenant_id, action, table_name, record_id, new_data)
VALUES (NULL, <tenant_id>, 'RECONCILE TENANT OWNER', 'tenant_members', <user_id>,
        jsonb_build_object('tenantId', <tenant_id>, 'userId', <user_id>, 'membershipRole', 'owner', 'reason', 'manual reconciliation'));
COMMIT;
```

Or, if it's abandoned test data, set `status = 'deleted'`.

## 3. An `active` integration with no credential (1 integration)

It can't authenticate any delivery, so it's harmless but misleading in the UI. Either
rotate its credential (`POST /integrations/:id/credentials/rotate`) or suspend it
(`POST /integrations/:id/suspend`), both through the API so the change is audited.

```sql
SELECT id, tenant_id, name, status, created_at FROM integrated_apps
WHERE status = 'active' AND credential_hash IS NULL;
```

## 4. Audit entries written before migration 007

They have `tenant_id IS NULL` and are visible only through `GET /audit/all`
(`PLATFORM_AUDIT_READ`). Leaving them there is safe. If tenants should see their own
older history, a backfill can use only tenant IDs that the server itself recorded in
the entry. Review the preview before running the update:

```sql
-- Preview: which entries would be attributed, and to which tenant.
SELECT id, action, table_name, created_at,
       COALESCE(new_data->>'tenantId', new_data->>'tenant_id', old_data->>'tenantId', old_data->>'tenant_id') AS recorded_tenant
FROM audit_logs
WHERE tenant_id IS NULL
  AND COALESCE(new_data->>'tenantId', new_data->>'tenant_id', old_data->>'tenantId', old_data->>'tenant_id') ~ '^[1-9][0-9]*$'
ORDER BY id;

BEGIN;
UPDATE audit_logs al
SET tenant_id = t.id
FROM tenants t
WHERE al.tenant_id IS NULL
  AND t.id::text = COALESCE(al.new_data->>'tenantId', al.new_data->>'tenant_id', al.old_data->>'tenantId', al.old_data->>'tenant_id');
-- Inspect the row count against the preview, then COMMIT or ROLLBACK.
```

Entries with no recorded tenant (logins, and the legacy `tickets` and
`integration_events` rows) stay platform-only.

## 5. Migrations to apply to the shared database

Migration 005 (`TENANTS_CREATE`) had not been applied on 2026-10-28, and no table
records which migrations have run. Apply 005–009 in order (`psql -v ON_ERROR_STOP=1 -f`).
They're idempotent. 009 stops without changing anything if case-insensitive duplicate
emails or usernames exist (none existed on 2026-10-28). After 006 and 007, review grants:

```sql
-- Who can manage integrations (006 granted it to every role with INTEGRATIONS_READ):
SELECT r.name FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
JOIN permissions p ON p.id = rp.permission_id WHERE p.name = 'INTEGRATIONS_MANAGE';
-- Platform operators (granted to nobody by 007):
-- INSERT INTO role_permissions (role_id, permission_id)
-- SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = '<operator role>' AND p.name = 'PLATFORM_AUDIT_READ';
```
