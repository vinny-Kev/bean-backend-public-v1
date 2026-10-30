-- Identity: email verification, password-change tracking, full name, and the default account role.
--
-- * users.email_verified_at: NULL until the address is proven by a one-time code. Login and
--   sessions require it. BACKFILL (runs exactly once, in the same step that adds the column):
--   every account that exists when this migration first runs is treated as verified
--   (email_verified_at = created_at), because those accounts predate the requirement. Re-running
--   the migration never verifies anyone, since the column already exists.
--   Reversal for the backfill: UPDATE users SET email_verified_at = NULL WHERE <ids you choose>.
-- * users.password_changed_at: set on password reset; NULL for accounts that never changed it.
-- * users.full_name: collected at registration; NULL for legacy accounts (the UI falls back to username).
-- * role "standard": the account role given to a user when their email is first verified. It carries
--   only TENANTS_CREATE (so a new user can found an organization). Module access inside an
--   organization comes from the membership role (owner/admin/member), not from this account role.
--   No existing user's role is changed by this migration.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email_verified_at') THEN
        ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
        UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
    END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name varchar(100);

INSERT INTO roles (name, description)
VALUES ('standard', 'Default account role for verified self-registered users: may create an organization. Access inside an organization comes from the membership role.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.name = 'TENANTS_CREATE'
WHERE r.name = 'standard'
ON CONFLICT DO NOTHING;
