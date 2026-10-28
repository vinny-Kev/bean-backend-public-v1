import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import { pool } from '../../db/pool.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';
import { count, one, resetSchema, saleEvent, SECRETS, seedFixtures, testDatabaseSkipReason } from './support/testDatabase.js';
import { startTestServer } from './support/testServer.js';

if (testDatabaseSkipReason) {
    reportBlockedIntegrationCheck('PostgreSQL integration authorization tests', 'a local *_test database is configured',
        `skipped: ${testDatabaseSkipReason}`);
}

let api;
let sendEvent;
let close;

// Fixtures: tenant 1 = owner 1, member 2, admin 6; tenant 2 = owner 3. Integration 1 belongs to tenant 1.
const failedEvent = async () => (await pool.query(
    `INSERT INTO integration_events (tenant_id, integrated_app_id, event_id, event_type, payload, status, occurred_at,
        error_code, failure_classification)
     VALUES (1, 1, 'authz-failed', 'transaction.completed', '{}'::jsonb, 'failed', NOW(), 'INVENTORY_UNAVAILABLE', 'action_required')
     RETURNING id`)).rows[0].id;

// Every integration-changing route, as one tenant-1 admin would call it.
const managementCalls = (eventId) => [
    ['POST', '/integrations/tenants/1/apps', { name: 'Second shop' }],
    ['PUT', '/integrations/1/subscriptions', { eventTypes: ['transaction.completed'] }],
    ['PUT', '/integrations/1/user-mappings', { externalUserId: 'emp-2', userId: 2 }],
    ['POST', '/integrations/1/suspend', undefined],
    ['POST', '/integrations/1/activate', undefined],
    ['POST', '/integrations/1/disconnect', undefined],
    ['POST', '/integrations/1/credentials/rotate', { tenantId: '1' }],
    ['PUT', '/integrations/tenants/1/settings/inventory-policy', { inventoryShortagePolicy: 'allow_negative_inventory' }],
    ['POST', `/integrations/events/${eventId}/retry`, { tenantId: '1', reason: 'Stock was corrected by hand' }],
];

const integrationSnapshot = async () => one(
    `SELECT ia.status, ia.credential_hash, ia.credential_rotated_at,
        (SELECT COUNT(*)::int FROM integrated_apps WHERE tenant_id=1) AS apps,
        (SELECT COUNT(*)::int FROM integration_lifecycle_activity) AS lifecycle,
        (SELECT COUNT(*)::int FROM integration_user_mappings) AS mappings,
        (SELECT COUNT(*)::int FROM tenant_integration_settings) AS settings,
        (SELECT COUNT(*)::int FROM integration_events WHERE status='failed') AS failed_events,
        (SELECT array_agg(event_type || ':' || is_enabled ORDER BY event_type) FROM integrated_app_event_subscriptions
         WHERE integrated_app_id=1) AS subscriptions
     FROM integrated_apps ia WHERE ia.id=1`);

describe('integration management authorization against PostgreSQL', { skip: testDatabaseSkipReason, concurrency: false }, () => {
    before(async () => {
        await resetSchema();
        ({ api, sendEvent, close } = await startTestServer());
    });
    after(async () => {
        await close?.();
        await pool.end();
    });
    beforeEach(seedFixtures);

    test('INTEGRATIONS_READ alone reads integrations; every change needs INTEGRATIONS_MANAGE', async () => {
        // User 6 is a tenant-1 admin; give the account a read-only integration role.
        await pool.query(`INSERT INTO roles (name) VALUES ('integration_reader');
            INSERT INTO role_permissions (role_id, permission_id)
                SELECT r.id, p.id FROM roles r, permissions p WHERE r.name='integration_reader' AND p.name='INTEGRATIONS_READ';
            UPDATE users SET role_id=(SELECT id FROM roles WHERE name='integration_reader') WHERE id=6;`);
        const eventId = await failedEvent();

        for (const path of ['/integrations/1', '/integrations/1/activity', '/integrations/1/audit', '/integrations/1/analytics',
            '/integrations/all/1', '/integrations/events?tenantId=1', `/integrations/events/${eventId}?tenantId=1`,
            '/integrations/diagnostics?tenantId=1', '/integrations/tenants/1/settings']) {
            assert.equal((await api('GET', path, { user: 6 })).status, 200, `read ${path}`);
        }

        const before = await integrationSnapshot();
        for (const [method, path, body] of managementCalls(eventId)) {
            const response = await api(method, path, { user: 6, body });
            assert.equal(response.status, 403, `${method} ${path} without INTEGRATIONS_MANAGE`);
        }
        assert.deepEqual(await integrationSnapshot(), before, 'denied management calls change nothing');
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE table_name<>'integrations'`), 0);

        // Permissions are read live: granting MANAGE takes effect on the next request.
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id)
            SELECT r.id, p.id FROM roles r, permissions p WHERE r.name='integration_reader' AND p.name='INTEGRATIONS_MANAGE'`);
        assert.equal((await api('POST', '/integrations/1/suspend', { user: 6 })).status, 200);
        assert.equal((await one('SELECT status FROM integrated_apps WHERE id=1')).status, 'suspended');

        // MANAGE is an account permission; it never replaces tenant authority.
        const member = await api('POST', '/integrations/1/activate', { user: 2 });
        assert.equal(member.status, 403, 'a plain tenant member holding INTEGRATIONS_MANAGE');
        assert.equal(member.body.error.code, 'TENANT_ADMIN_REQUIRED');
        assert.equal((await api('POST', '/integrations/2/suspend', { user: 6 })).status, 404, 'another tenant\'s integration');
    });

    test('a deleted tenant\'s integrations are unreachable for its former members', async () => {
        const eventId = await failedEvent();
        await pool.query(`UPDATE tenants SET status='deleted' WHERE id=1`);
        const before = await integrationSnapshot();

        for (const path of ['/integrations/1', '/integrations/1/activity', '/integrations/1/audit', '/integrations/1/analytics']) {
            assert.equal((await api('GET', path, { user: 1 })).status, 404, `owner reading ${path}`);
        }
        const list = await api('GET', '/integrations/all/1?page=1', { user: 1 });
        assert.equal(list.status, 200);
        assert.deepEqual([list.body.data.length, list.body.pagination.total], [0, 0]);
        for (const path of ['/integrations/events?tenantId=1', `/integrations/events/${eventId}?tenantId=1`,
            '/integrations/diagnostics?tenantId=1', '/integrations/tenants/1/settings']) {
            assert.equal((await api('GET', path, { user: 1 })).status, 403, `owner reading ${path}`);
        }
        for (const [method, path, body] of managementCalls(eventId)) {
            const response = await api(method, path, { user: 1, body });
            assert.ok([403, 404].includes(response.status), `${method} ${path} on a deleted tenant -> ${response.status}`);
        }
        assert.deepEqual(await integrationSnapshot(), before, 'nothing about the deleted tenant\'s integration changed');

        // The other tenant is unaffected.
        assert.equal((await api('GET', '/integrations/2', { user: 3 })).status, 200);
    });

    test('one integration\'s credentials never authenticate another tenant\'s integration', async () => {
        const attempts = [
            [1, 'globex-store-key', SECRETS.globex, 'tenant 2 key and secret against tenant 1\'s integration ID'],
            [1, 'acme-store-key', SECRETS.globex, 'tenant 1 key with tenant 2 secret'],
            [2, 'acme-store-key', SECRETS.acme, 'tenant 1 key and secret against tenant 2\'s integration ID'],
            [999, 'acme-store-key', SECRETS.acme, 'an integration ID that does not exist'],
        ];
        for (const [appId, appKey, secret, label] of attempts) {
            const response = await sendEvent(appId, appKey, secret, saleEvent({ eventId: `cross-${appId}-${appKey}` }));
            assert.equal(response.status, 401, label);
            assert.equal(response.body.error.code, 'INTEGRATION_AUTH_FAILED');
        }
        assert.equal(await count('SELECT COUNT(*) FROM integration_events'), 0);
        assert.equal(await count('SELECT COUNT(*) FROM integration_event_deduplication'), 0);
        assert.equal(await count(`SELECT COUNT(*) FROM integration_event_diagnostics WHERE tenant_id IS NOT NULL`), 0,
            'failed authentication is never attributed to a tenant');
        assert.equal((await sendEvent(1, 'acme-store-key', SECRETS.acme, saleEvent())).status, 202, 'the right credential still works');
    });

    test('a removed member loses tenant, inventory, integration, and audit access on the next request', async () => {
        for (const path of ['/tenants/1', '/inventory/tenants/1/items', '/integrations/1', '/audit/tenants/1']) {
            assert.equal((await api('GET', path, { user: 6 })).status, 200, `admin before removal: ${path}`);
        }
        assert.equal((await api('DELETE', '/tenants/1/members/6', { user: 1 })).status, 200);
        for (const path of ['/tenants/1', '/inventory/tenants/1/items', '/integrations/1', '/integrations/1/analytics', '/audit/tenants/1']) {
            assert.equal((await api('GET', path, { user: 6 })).status, 404, `after removal: ${path}`);
        }
        assert.equal((await api('GET', '/integrations/events?tenantId=1', { user: 6 })).status, 403);
        assert.equal((await api('POST', '/integrations/1/suspend', { user: 6 })).status, 404);
        assert.equal((await api('PUT', '/inventory/tenants/1/items/1', { user: 6,
            body: { name: 'Bean bag', sku: 'BEAN-42', quantity: 0, unit: 'unit' } })).status, 404);
        assert.equal((await one('SELECT quantity FROM inventory WHERE id=1')).quantity, 10);
        const all = await api('GET', '/integrations/all/1', { user: 6 });
        assert.deepEqual([all.status, all.body.data.length], [200, 0]);
    });
});
