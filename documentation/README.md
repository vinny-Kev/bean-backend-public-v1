## Local Test Account

Create a local-only account with a password supplied interactively or through an ignored environment variable. Never commit test credentials to this repository.

## Backend setup

Use Node.js 20 or later. From the `backend` directory, copy `.env.example` to `.env`, replace the database password and session secret with local values, then install dependencies and start the server:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

The server validates its configuration at startup and binds to `HOST` and `PORT` (defaults to `127.0.0.1:3000`). Set `APP_ORIGINS` to comma-separated, exact frontend origins. Production requires an approved origin and HTTPS secure cookies. Never commit `.env` or use the example session secret in a deployed environment.

### Connect to Neon

The backend accepts a Neon PostgreSQL connection URL through `DATABASE_URL`. When set, it takes precedence over the local `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` values, and the connection uses TLS certificate verification.

1. Create a Neon project and choose a region close to where the backend will run.
2. In the project dashboard, open **Connect**, choose the application connection details, and select the **pooled** connection string for the long-running API. Neon provides both direct and pooled URLs; its pooler endpoint is intended to help applications stay within Postgres connection limits. [Neon connection pooling](https://neon.com/docs/manage/endpoints/)
3. Copy the PostgreSQL URL into `backend/.env` as `DATABASE_URL="..."`. Treat it as a password: don’t paste it into chat, commit it, or add it to Requestly collections.
4. Keep the existing `DB_*` values for local PostgreSQL if you still use it. A non-empty `DATABASE_URL` selects Neon; clear it to switch back to `DB_*`.
5. Start the backend with `npm run dev` and confirm it can connect.

Neon creates a database, but this project does not yet have schema migrations for its users, roles, permissions, inventory, and audit tables. The session store can create its own table; the rest of the application schema must be applied to Neon before the API can serve those routes. Don’t point a production API at a blank Neon database. Schema migration and a first connection check remain backlog items.

## Roles and permissions (PostgreSQL)

Run the SQL below in the `bean` database after the schema tables (`roles`, `permissions`, `role_permissions`, and `users`) exist. It is safe to run again: it only inserts rows that are not already present. The `dev` role is granted every permission listed here, so use it only for local development. Create narrower roles for real users in a deployed environment.

### Seed the development role and current route permissions

```sql
BEGIN;

INSERT INTO roles (name, description)
SELECT 'dev', 'Development and system administration role'
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'dev');

INSERT INTO permissions (name, description)
SELECT seed.name, seed.description
FROM (VALUES
    ('INVENTORY_READ',   'View inventory records'),
    ('INVENTORY_CREATE', 'Create inventory records'),
    ('INVENTORY_UPDATE', 'Modify inventory records'),
    ('INVENTORY_DELETE', 'Delete inventory records'),
    ('AUDIT_READ',       'View audit logs')
) AS seed(name, description)
WHERE NOT EXISTS (
    SELECT 1 FROM permissions existing WHERE existing.name = seed.name
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'dev'
  AND p.name IN (
      'INVENTORY_READ', 'INVENTORY_CREATE', 'INVENTORY_UPDATE',
      'INVENTORY_DELETE', 'AUDIT_READ'
  )
  AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

COMMIT;
```

The audit route currently checks for `AUDIT_READ`; permission names are exact and must match the value passed to `requirePermission` in each route.

### Check a user's effective permissions

Replace the email with the account you want to inspect. This shows the assigned role and each permission granted through `role_permissions`:

```sql
SELECT u.id AS user_id,
       u.email,
       u.username,
       r.name AS role,
       p.name AS permission,
       p.description
FROM users u
LEFT JOIN roles r ON r.id = u.role_id
LEFT JOIN role_permissions rp ON rp.role_id = r.id
LEFT JOIN permissions p ON p.id = rp.permission_id
WHERE u.email = 'kevin@test.com'
ORDER BY p.name;
```

To see permissions that exist but have not been granted to a role:

```sql
SELECT p.name, p.description
FROM permissions p
WHERE NOT EXISTS (
    SELECT 1
    FROM role_permissions rp
    WHERE rp.permission_id = p.id
)
ORDER BY p.name;
```

### Add a permission as the API grows

Add a permission row, then grant it only to the roles that should use it. For example, after adding a route guarded by `requirePermission('INVENTORY_EXPORT')`:

```sql
INSERT INTO permissions (name, description)
SELECT 'INVENTORY_EXPORT', 'Export inventory records'
WHERE NOT EXISTS (
    SELECT 1 FROM permissions WHERE name = 'INVENTORY_EXPORT'
);

-- Grant it to dev; repeat with another role name only if appropriate.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.name = 'INVENTORY_EXPORT'
WHERE r.name = 'dev'
  AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
```

Use the exact same permission string in the route and database. `requirePermission` checks the current user's role against the database on each protected request, so a role-permission change takes effect without changing the user's session.

## Development Backlog

See [TODO2026-10-01.md](TODO2026-10-01.md) for the prioritized public-release hardening list, confirmed vulnerabilities, idempotency design, and paid-edition fork plan.

## Integration Guide

See [FRONTEND_AND_MODULE_GUIDE.md](FRONTEND_AND_MODULE_GUIDE.md) for the browser/API client contract, cookie sessions, CSRF/origin rules, authentication lifecycle, route conventions, and a checklist for adding modules.
