// Migrations 013-016 applied on top of an already populated database (schema as of migration 012).
// Existing users, tenants, memberships, roles and business rows must come through unchanged.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from '../integrations/tests/integrationTestReporter.js';
import { testDatabaseSkipReason } from '../integrations/tests/support/testDatabase.js';

const skip = testDatabaseSkipReason;
if (skip) reportBlockedIntegrationCheck('PostgreSQL identity migration tests', 'a *_test database', `skipped: ${skip}`);

const dbDirectory = fileURLToPath(new URL('../../db/', import.meta.url));
const migrations = readdirSync(`${dbDirectory}migrations`).filter((name) => name.endsWith('.sql')).sort();
const apply = async (predicate) => {
    for (const file of migrations.filter(predicate)) await pool.query(readFileSync(`${dbDirectory}migrations/${file}`, 'utf8'));
};
const rows = async (sql) => (await pool.query(sql)).rows;

describe('identity migrations on a populated database', { skip, concurrency: false }, () => {
    before(async () => {
        await pool.query('DROP SCHEMA public CASCADE');
        await pool.query('CREATE SCHEMA public');
        await pool.query(readFileSync(`${dbDirectory}schema/baseline.sql`, 'utf8'));
        await apply((name) => Number(name.slice(0, 3)) <= 12);
        // A populated, pre-identity database: two roles, users with and without a role, two tenants.
        await pool.query(`
            INSERT INTO roles (name) VALUES ('dev') ON CONFLICT (name) DO NOTHING;
            INSERT INTO permissions (name) VALUES ('INVENTORY_READ') ON CONFLICT (name) DO NOTHING;
            INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.name='dev' AND p.name='INVENTORY_READ' ON CONFLICT DO NOTHING;
            INSERT INTO users (id, email, username, password_hash, role_id, created_at) OVERRIDING SYSTEM VALUE VALUES
              (1, 'a@legacy.test', 'legacya', 'x', (SELECT id FROM roles WHERE name='dev'), '2026-01-01T00:00:00Z'),
              (2, 'b@legacy.test', 'legacyb', 'x', NULL, '2026-02-01T00:00:00Z'),
              (3, 'c@legacy.test', 'legacyc', 'x', NULL, '2026-03-01T00:00:00Z');
            UPDATE users SET is_disabled = true WHERE id = 3;
            INSERT INTO tenants (id, name, slug) OVERRIDING SYSTEM VALUE VALUES (7, 'Legacy One', 'legacy-one'), (8, 'Legacy Two', 'legacy-two');
            INSERT INTO tenant_members (tenant_id, user_id, membership_role) VALUES (7, 1, 'owner'), (7, 2, 'member'), (8, 1, 'admin');
            INSERT INTO inventory (tenant_id, name, sku, quantity) VALUES (7, 'Beans', 'BEANS-1', 4);
            INSERT INTO audit_logs (user_id, tenant_id, action) VALUES (1, 7, 'LEGACY ACTION');`);
    });
    after(() => pool.end());

    test('013-016 keep every existing record and verify only the accounts that existed before', async () => {
        const before = {
            users: await rows('SELECT id, email, username, password_hash, role_id, is_disabled, created_at FROM users ORDER BY id'),
            tenants: await rows('SELECT id, name, slug, status FROM tenants ORDER BY id'),
            members: await rows('SELECT tenant_id, user_id, membership_role FROM tenant_members ORDER BY tenant_id, user_id'),
            inventory: await rows('SELECT tenant_id, name, sku, quantity FROM inventory ORDER BY id'),
            audit: await rows('SELECT user_id, tenant_id, action FROM audit_logs ORDER BY id'),
            roles: await rows('SELECT name FROM roles ORDER BY name'),
        };

        await apply((name) => Number(name.slice(0, 3)) >= 13);

        assert.deepEqual(await rows('SELECT id, email, username, password_hash, role_id, is_disabled, created_at FROM users ORDER BY id'), before.users, 'user rows unchanged');
        assert.deepEqual(await rows('SELECT id, name, slug, status FROM tenants ORDER BY id'), before.tenants, 'tenant ids preserved');
        assert.deepEqual(await rows('SELECT tenant_id, user_id, membership_role FROM tenant_members ORDER BY tenant_id, user_id'), before.members, 'memberships preserved');
        assert.deepEqual(await rows('SELECT tenant_id, name, sku, quantity FROM inventory ORDER BY id'), before.inventory);
        assert.deepEqual((await rows('SELECT user_id, tenant_id, action FROM audit_logs ORDER BY id')).slice(0, before.audit.length), before.audit, 'audit history preserved');
        assert.deepEqual((await rows('SELECT name FROM roles ORDER BY name')).map((r) => r.name), [...before.roles.map((r) => r.name), 'standard'].sort(), 'only the standard role was added');

        // Backfill: pre-existing accounts count as verified as of their creation; roles are untouched.
        const users = await rows('SELECT id, role_id, created_at, email_verified_at, full_name, password_changed_at FROM users ORDER BY id');
        for (const user of users) {
            assert.equal(user.email_verified_at.toISOString(), user.created_at.toISOString());
            assert.equal(user.full_name, null);
            assert.equal(user.password_changed_at, null);
        }
        assert.deepEqual(users.map((u) => u.role_id === null), [false, true, true], 'no role was silently assigned');

        // standard carries TENANTS_CREATE only.
        const standard = await rows(`SELECT p.name FROM roles r JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE r.name='standard'`);
        assert.deepEqual(standard.map((r) => r.name), ['TENANTS_CREATE']);

        // New tables exist and are empty.
        for (const table of ['auth_challenges', 'trusted_devices', 'tenant_invitations', 'idempotency_keys']) {
            assert.equal((await rows(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n, 0, table);
        }
    });

    test('re-running the migrations is safe and never verifies a newly registered account', async () => {
        await pool.query(`INSERT INTO users (id, email, username, password_hash) OVERRIDING SYSTEM VALUE VALUES (99, 'new@later.test', 'later', 'x')`);
        await apply((name) => Number(name.slice(0, 3)) >= 13);
        await apply((name) => Number(name.slice(0, 3)) >= 13);
        assert.equal((await rows(`SELECT email_verified_at FROM users WHERE username='later'`))[0].email_verified_at, null);
        assert.equal((await rows('SELECT COUNT(*)::int AS n FROM users'))[0].n, 4);
        assert.equal((await rows(`SELECT COUNT(*)::int AS n FROM roles WHERE name='standard'`))[0].n, 1);
    });

    test('database constraints: one live challenge per user and purpose, one pending invitation per address, hashed-token uniqueness', async () => {
        const userId = (await rows(`SELECT id FROM users WHERE username='legacya'`))[0].id;
        const challenge = (hash) => pool.query(
            `INSERT INTO auth_challenges (user_id, purpose, kind, secret_hash, expires_at) VALUES ($1,'verify_email','otp',$2, now() + interval '10 minutes')`, [userId, hash.repeat(64).slice(0, 64)]);
        await challenge('a');
        await assert.rejects(challenge('b'), { constraint: 'uq_auth_challenges_live' });
        await assert.rejects(pool.query(`INSERT INTO auth_challenges (user_id, purpose, kind, secret_hash, expires_at) VALUES ($1,'bogus','otp',$2, now())`, [userId, 'c'.repeat(64)]), { code: '23514' });

        const invite = (hash, status = 'pending') => pool.query(
            `INSERT INTO tenant_invitations (tenant_id, email_normalized, membership_role, token_hash, status, expires_at) VALUES (7,'x@y.test','member',$1,$2, now() + interval '1 day')`, [hash.repeat(64).slice(0, 64), status]);
        await invite('d');
        await assert.rejects(invite('e'), { constraint: 'uq_tenant_invitations_pending' });
        await invite('f', 'revoked');
        await assert.rejects(invite('d', 'revoked'), { code: '23505' });
        await assert.rejects(pool.query(`INSERT INTO tenant_invitations (tenant_id, email_normalized, membership_role, token_hash, expires_at) VALUES (7,'UPPER@y.test','member',$1, now())`, ['g'.repeat(64)]), { code: '23514' });
    });
});
