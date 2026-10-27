import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { config } from '../../../config.js';
import { pool } from '../../../db/pool.js';

const dbDirectory = fileURLToPath(new URL('../../../../db/', import.meta.url));

// These tests drop and rebuild the public schema. Refuse anything except an
// explicitly local database whose name ends in `_test`, so a stray .env
// DATABASE_URL (for example the shared Neon database) is never touched.
export const testDatabaseSkipReason = (() => {
    const db = config.database;
    if (db.connectionString) return 'DATABASE_URL is set; database tests only run against a local *_test database.';
    if (!['127.0.0.1', 'localhost', '::1'].includes(db.host)) return 'DB_HOST must be a local address for database tests.';
    if (!/_test$/.test(db.database)) return 'DB_NAME must end in _test for database tests.';
    return false;
})();

export const SECRETS = Object.freeze({
    acme: 'acme-integration-secret-0123456789abcdefghij',
    globex: 'globex-integration-secret-0123456789abcdefgh',
});

export const resetSchema = async () => {
    if (testDatabaseSkipReason) throw new Error(testDatabaseSkipReason);
    const client = await pool.connect();
    try {
        await client.query('DROP SCHEMA public CASCADE');
        await client.query('CREATE SCHEMA public');
        await client.query(readFileSync(`${dbDirectory}schema/baseline.sql`, 'utf8'));
        // Replaying every migration on top of the baseline also verifies they are re-runnable.
        for (const file of readdirSync(`${dbDirectory}migrations`).filter((name) => name.endsWith('.sql')).sort()) {
            await client.query(readFileSync(`${dbDirectory}migrations/${file}`, 'utf8'));
        }
    } finally { client.release(); }
};

const credentialHashes = Promise.all([bcrypt.hash(SECRETS.acme, 4), bcrypt.hash(SECRETS.globex, 4)]);

// Two tenants that share a SKU, so tenant isolation of business effects is observable.
export const seedFixtures = async () => {
    if (testDatabaseSkipReason) throw new Error(testDatabaseSkipReason);
    const [acmeHash, globexHash] = await credentialHashes;
    await pool.query(`TRUNCATE tenants, users, integration_events, integration_event_attempts,
        integration_event_diagnostics, analytics_outbox, audit_logs RESTART IDENTITY CASCADE`);
    await pool.query(`
        INSERT INTO tenants (id, name, slug, status) OVERRIDING SYSTEM VALUE
            VALUES (1, 'Acme', 'acme', 'active'), (2, 'Globex', 'globex', 'active');
        INSERT INTO roles (name) VALUES ('dev'), ('staff') ON CONFLICT (name) DO NOTHING;
        INSERT INTO permissions (name) VALUES ('INTEGRATIONS_READ'), ('INVENTORY_READ'), ('INVENTORY_CREATE'),
            ('INVENTORY_UPDATE'), ('TENANTS_CREATE') ON CONFLICT (name) DO NOTHING;
        -- dev has every permission; staff has the same minus TENANTS_CREATE.
        INSERT INTO role_permissions (role_id, permission_id)
            SELECT r.id, p.id FROM roles r, permissions p
            WHERE r.name='dev' OR (r.name='staff' AND p.name<>'TENANTS_CREATE')
            ON CONFLICT DO NOTHING;
        -- Users 1-4 are dev; user 4 belongs to no tenant; user 5 has no role at all;
        -- user 6 is staff and an admin of tenant 1 (a tenant role without account-level tenant creation).
        INSERT INTO users (id, email, username, password_hash, role_id) OVERRIDING SYSTEM VALUE
            SELECT u.id, u.email, u.username, 'x', r.id
            FROM (VALUES (1, 'owner@acme.test', 'acmeowner', 'dev'), (2, 'member@acme.test', 'acmemember', 'dev'),
                         (3, 'owner@globex.test', 'globexowner', 'dev'), (4, 'founder@new.test', 'founder', 'dev'),
                         (5, 'norole@new.test', 'norole', NULL), (6, 'admin@acme.test', 'acmeadmin', 'staff'))
                AS u(id, email, username, role_name)
            LEFT JOIN roles r ON r.name=u.role_name;
        SELECT setval('users_id_seq', 100);
        INSERT INTO tenant_members (tenant_id, user_id, membership_role)
            VALUES (1, 1, 'owner'), (1, 2, 'member'), (1, 6, 'admin'), (2, 3, 'owner');
        INSERT INTO inventory (id, tenant_id, name, sku, quantity) OVERRIDING SYSTEM VALUE
            VALUES (1, 1, 'Bean bag', 'BEAN-42', 10), (2, 2, 'Bean bag', 'BEAN-42', 7);
        INSERT INTO commission_rules (tenant_id, commission_rate) VALUES (1, 0.05);`);
    await pool.query(
        `INSERT INTO integrated_apps (id, tenant_id, name, app_key, status, credential_hash) OVERRIDING SYSTEM VALUE
         VALUES (1, 1, 'Acme storefront', 'acme-store-key', 'active', $1),
                (2, 2, 'Globex storefront', 'globex-store-key', 'active', $2)`,
        [acmeHash, globexHash],
    );
    // Fixtures use explicit IDs; move identity sequences past them for rows the API creates.
    await pool.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), 100),
        setval(pg_get_serial_sequence('integrated_apps','id'), 100),
        setval(pg_get_serial_sequence('inventory','id'), 100)`);
    await pool.query(`
        INSERT INTO integrated_app_event_subscriptions (tenant_id, integrated_app_id, event_type)
            VALUES (1, 1, 'transaction.completed'), (1, 1, 'inventory.adjusted'), (2, 2, 'transaction.completed');
        INSERT INTO integration_user_mappings (tenant_id, integrated_app_id, external_user_id, user_id)
            VALUES (1, 1, 'emp-1', 1), (2, 2, 'emp-9', 3);`);
};

export const saleEvent = (overrides = {}, payloadOverrides = {}) => ({
    eventId: 'evt-1',
    eventType: 'transaction.completed',
    occurredAt: new Date().toISOString(),
    correlationId: 'checkout-1',
    ...overrides,
    payload: {
        externalTransactionId: 'order-1',
        productId: 'BEAN-42',
        quantity: 2,
        status: 'completed',
        saleAmount: '1299.00',
        currency: 'PHP',
        externalUserId: 'emp-1',
        ...payloadOverrides,
    },
});

export const one = async (sql, values) => (await pool.query(sql, values)).rows[0];
export const count = async (sql, values) => Number((await pool.query(sql, values)).rows[0].count);
