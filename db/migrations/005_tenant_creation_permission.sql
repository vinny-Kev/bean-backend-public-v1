-- Data-only: tenant creation becomes an account-level permission instead of
-- something any authenticated user can do. Tenant membership roles
-- (owner/admin/member) never grant it.
-- Existing access is preserved: the `dev` role, which every current Neon user
-- holds, keeps the ability to create tenants. New accounts have no role until
-- one is assigned. Idempotent; it does not change any existing grant.
INSERT INTO permissions (name, description)
VALUES ('TENANTS_CREATE', 'Create a new tenant (organization) and become its owner.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.name = 'TENANTS_CREATE'
WHERE r.name = 'dev'
ON CONFLICT DO NOTHING;
