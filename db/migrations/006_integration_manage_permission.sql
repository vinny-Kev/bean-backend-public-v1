-- Data-only: separate managing integrations from reading them.
-- INTEGRATIONS_READ keeps the dashboards, event search, and diagnostics.
-- INTEGRATIONS_MANAGE is required to register, configure, activate, suspend,
-- disconnect, rotate credentials, retry events, and change integration settings.
-- Tenant owner/admin membership is still required on top of either permission.
-- Existing access is preserved: every role that holds INTEGRATIONS_READ when this
-- runs also receives INTEGRATIONS_MANAGE. Revoke it from read-only roles afterwards.
-- Idempotent; it does not remove any existing grant.
INSERT INTO permissions (name, description)
VALUES ('INTEGRATIONS_MANAGE', 'Register, configure, activate, suspend, disconnect, and rotate credentials for tenant integrations.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, manage.id
FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id AND p.name = 'INTEGRATIONS_READ'
CROSS JOIN (SELECT id FROM permissions WHERE name = 'INTEGRATIONS_MANAGE') manage
ON CONFLICT DO NOTHING;
