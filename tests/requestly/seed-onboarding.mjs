// Seeds the minimum fixtures the Requestly onboarding pipeline needs, on a local *_test
// database only. Idempotent: it upserts its own roles, accounts, and one rival tenant and
// never deletes or truncates anything.
//
//   DATABASE_URL= DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=bean_requestly_test DB_USER=... DB_PASSWORD=... \
//     REQUESTLY_TEST_PASSWORD='Onboard!Test1' node tests/requestly/seed-onboarding.mjs
import bcrypt from 'bcrypt';
import { pathToFileURL } from 'node:url';

// Accounts the collection logs in as. The new hire is NOT seeded: the collection registers it.
export const ONBOARDING_ACCOUNTS = Object.freeze({
    founder: { email: 'founder.requestly@example.test', username: 'rqfounder', role: 'onboarding_founder' },
    manager: { email: 'manager.requestly@example.test', username: 'rqmanager', role: 'onboarding_employee' },
    cashier: { email: 'cashier.requestly@example.test', username: 'rqcashier', role: 'onboarding_employee' },
    // Owns the separate "rival" tenant used for cross-tenant checks in both directions.
    rival: { email: 'rival.requestly@example.test', username: 'rqrival', role: 'onboarding_founder' },
});
export const RIVAL_TENANT = Object.freeze({ slug: 'requestly-rival', name: 'Requestly Rival Org', sku: 'RIVAL-1' });

// Test-only roles, so existing roles such as `dev` are never modified.
const ROLE_PERMISSIONS = {
    onboarding_founder: ['TENANTS_CREATE', 'INTEGRATIONS_READ', 'INTEGRATIONS_MANAGE', 'INVENTORY_READ', 'INVENTORY_CREATE', 'INVENTORY_UPDATE'],
    onboarding_employee: ['INTEGRATIONS_READ', 'INVENTORY_READ'],
};

export const seedOnboardingFixtures = async (db, password) => {
    if (typeof password !== 'string' || password.length < 8) throw new Error('A test password of at least 8 characters is required.');
    const hash = await bcrypt.hash(password, 10);
    await db.query('BEGIN');
    try {
        for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
            await db.query('INSERT INTO roles (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
                [role, 'Requestly onboarding test fixture role']);
            for (const permission of permissions) {
                await db.query('INSERT INTO permissions (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [permission]);
                await db.query(`INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id FROM roles r, permissions p WHERE r.name=$1 AND p.name=$2 ON CONFLICT DO NOTHING`, [role, permission]);
            }
        }
        const ids = {};
        for (const [key, account] of Object.entries(ONBOARDING_ACCOUNTS)) {
            const row = await db.query(
                `INSERT INTO users (email, username, password_hash, role_id)
                 VALUES ($1, $2, $3, (SELECT id FROM roles WHERE name=$4))
                 ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role_id=EXCLUDED.role_id,
                    is_disabled=false, deleted_at=NULL
                 RETURNING id`, [account.email, account.username, hash, account.role]);
            ids[key] = row.rows[0].id;
        }
        const rival = await db.query(
            `INSERT INTO tenants (name, slug) VALUES ($1, $2)
             ON CONFLICT (slug) DO UPDATE SET status='active' RETURNING id`, [RIVAL_TENANT.name, RIVAL_TENANT.slug]);
        await db.query(`INSERT INTO tenant_members (tenant_id, user_id, membership_role) VALUES ($1, $2, 'owner')
            ON CONFLICT (tenant_id, user_id) DO UPDATE SET membership_role='owner'`, [rival.rows[0].id, ids.rival]);
        await db.query(`INSERT INTO inventory (tenant_id, name, sku, quantity) VALUES ($1, 'Rival stock', $2, 7)
            ON CONFLICT (tenant_id, sku) WHERE tenant_id IS NOT NULL DO NOTHING`, [rival.rows[0].id, RIVAL_TENANT.sku]);
        await db.query('COMMIT');
        return { userIds: ids, rivalTenantId: rival.rows[0].id };
    } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
    }
};

// CLI. By default only a local *_test database is accepted (the database-test guard). A shared
// staging database needs both `--target=staging` and REQUESTLY_STAGING_HOST set to the exact
// hostname DATABASE_URL points at, so a wrong .env cannot be seeded by accident.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const { testDatabaseSkipReason } = await import('../../src/integrations/tests/support/testDatabase.js');
    const { config } = await import('../../src/config.js');
    const { pool } = await import('../../src/db/pool.js');
    try {
        const host = config.database.connectionString ? new URL(config.database.connectionString).hostname : config.database.host;
        if (process.argv.includes('--target=staging')) {
            if (process.env.REQUESTLY_STAGING_HOST !== host) {
                throw new Error(`Refusing to seed: set REQUESTLY_STAGING_HOST=${host} to confirm this is the staging database you mean.`);
            }
            console.log(`Seeding staging database at ${host}.`);
        } else if (testDatabaseSkipReason) {
            throw new Error(`Refusing to seed: ${testDatabaseSkipReason} (for a shared staging database, see --target=staging in tests/requestly/README.md)`);
        }
        const password = process.env.REQUESTLY_TEST_PASSWORD;
        if (!password) throw new Error('Set REQUESTLY_TEST_PASSWORD to the password configured in the collection (test_password).');
        const result = await seedOnboardingFixtures(pool, password);
        console.log(`Seeded Requestly onboarding fixtures: ${Object.keys(ONBOARDING_ACCOUNTS).join(', ')} accounts and tenant "${RIVAL_TENANT.slug}" (id ${result.rivalTenantId}).`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}
