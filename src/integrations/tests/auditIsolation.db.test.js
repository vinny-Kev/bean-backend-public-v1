import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import { pool } from '../../db/pool.js';
import { processIntegrationEventBatch } from '../services/integrationEventWorker.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';
import { count, resetSchema, saleEvent, SECRETS, seedFixtures, testDatabaseSkipReason } from './support/testDatabase.js';
import { startTestServer } from './support/testServer.js';

if (testDatabaseSkipReason) {
    reportBlockedIntegrationCheck('PostgreSQL audit isolation tests', 'a local *_test database is configured',
        `skipped: ${testDatabaseSkipReason}`);
}

let api;
let sendEvent;
let close;

// Fixtures: tenant 1 = owner 1, member 2, admin 6 (staff); tenant 2 = owner 3; user 4 = dev, no tenant; user 5 = no role.
// dev and staff hold AUDIT_READ; nobody holds PLATFORM_AUDIT_READ unless a test grants it.
const grantPlatformAudit = (userId) => pool.query(`INSERT INTO roles (name) VALUES ('platform_operator') ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM roles r, permissions p WHERE r.name='platform_operator' AND p.name='PLATFORM_AUDIT_READ'
        ON CONFLICT DO NOTHING;
    UPDATE users SET role_id=(SELECT id FROM roles WHERE name='platform_operator') WHERE id=${Number(userId)};`);

// Audited work in both tenants: inventory, membership, integration lifecycle, and worker processing.
const generateTenantActivity = async () => {
    assert.equal((await api('POST', '/inventory/tenants/1/items', { user: 1, body: { name: 'Acme beans', sku: 'ACME-ONLY', quantity: 3 } })).status, 200);
    assert.equal((await api('POST', '/inventory/tenants/2/items', { user: 3, body: { name: 'Globex beans', sku: 'GLOBEX-SECRET', quantity: 4 } })).status, 200);
    assert.equal((await api('POST', '/tenants/1/members', { user: 1, body: { username: 'founder' } })).status, 201);
    assert.equal((await api('POST', '/tenants/2/members', { user: 3, body: { username: 'norole' } })).status, 201);
    assert.equal((await api('PUT', '/integrations/tenants/2/settings/inventory-policy', { user: 3,
        body: { inventoryShortagePolicy: 'allow_negative_inventory' } })).status, 200);
    assert.equal((await sendEvent(1, 'acme-store-key', SECRETS.acme, saleEvent())).status, 202);
    assert.equal((await sendEvent(2, 'globex-store-key', SECRETS.globex, saleEvent({ eventId: 'g-1' }, { externalUserId: 'emp-9' }))).status, 202);
    await processIntegrationEventBatch();
    assert.equal((await api('POST', '/integrations/1/suspend', { user: 1 })).status, 200);
    // A legacy entry from before audit_logs.tenant_id existed.
    await pool.query(`INSERT INTO audit_logs (user_id, action, table_name, new_data) VALUES (3, 'LEGACY', 'inventory', '{"sku":"LEGACY-GLOBAL"}')`);
};

describe('audit log isolation against PostgreSQL', { skip: testDatabaseSkipReason, concurrency: false }, () => {
    before(async () => {
        await resetSchema();
        ({ api, sendEvent, close } = await startTestServer());
    });
    after(async () => {
        await close?.();
        await pool.end();
    });
    beforeEach(seedFixtures);

    test('every tenant-scoped audit write records its tenant', async () => {
        await generateTenantActivity();
        const actions = async (tenantId) => (await pool.query(
            'SELECT DISTINCT action FROM audit_logs WHERE tenant_id=$1 ORDER BY action', [tenantId])).rows.map((row) => row.action);
        assert.deepEqual(await actions(1), ['ADD TENANT MEMBER', 'CREATE INVENTORY', 'PROCESS INTEGRATION EVENT', 'SUSPEND INTEGRATION']);
        assert.deepEqual(await actions(2), ['ADD TENANT MEMBER', 'CREATE INVENTORY', 'PROCESS INTEGRATION EVENT',
            'UPDATE INTEGRATION INVENTORY POLICY']);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE tenant_id IS NULL AND action<>'LEGACY'`), 0);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE tenant_id=1 AND new_data::text LIKE '%GLOBEX-SECRET%'`), 0);
    });

    test('the global audit log requires PLATFORM_AUDIT_READ; tenant AUDIT_READ is not enough', async () => {
        await generateTenantActivity();
        for (const path of ['/audit/all', '/audit/all?page=1&limit=5', '/integrations/diagnostics/unauthorized']) {
            const denied = await api('GET', path, { user: 1 });
            assert.equal(denied.status, 403, `${path} for a tenant owner holding AUDIT_READ`);
            assert.equal(denied.body.error.code, 'PERMISSION_REQUIRED');
            assert.equal(JSON.stringify(denied.body).includes('GLOBEX'), false);
        }
        assert.equal((await api('GET', '/audit/all')).status, 401);

        await grantPlatformAudit(4);
        const global = await api('GET', '/audit/all?page=1&limit=20', { user: 4 });
        assert.equal(global.status, 200);
        assert.equal(global.body.pagination.total, await count('SELECT COUNT(*) FROM audit_logs'));
        assert.deepEqual([...new Set(global.body.data.map((row) => row.tenantId))].sort(), ['1', '2', null].sort());
        assert.equal((await api('GET', '/integrations/diagnostics/unauthorized', { user: 4 })).status, 200);
    });

    test('tenant audit history shows only that tenant, only to its owners and admins', async () => {
        await generateTenantActivity();
        const total = await count('SELECT COUNT(*) FROM audit_logs WHERE tenant_id=1');
        assert.ok(total >= 4);

        const owner = await api('GET', '/audit/tenants/1', { user: 1 });
        assert.equal(owner.status, 200);
        assert.equal(owner.body.data.length, total);
        assert.ok(owner.body.data.every((row) => row.tenantId === '1'));
        const text = JSON.stringify(owner.body);
        for (const foreign of ['GLOBEX-SECRET', 'LEGACY-GLOBAL', 'allow_negative_inventory', 'norole']) {
            assert.equal(text.includes(foreign), false, `tenant 1 history must not contain ${foreign}`);
        }

        // Pagination, counts and page boundaries stay inside the tenant.
        const seen = [];
        for (let page = 1; page <= Math.ceil(total / 2); page += 1) {
            const response = await api('GET', `/audit/tenants/1?page=${page}&limit=2`, { user: 1 });
            assert.equal(response.body.pagination.total, total);
            seen.push(...response.body.data.map((row) => row.id));
        }
        assert.deepEqual(seen, owner.body.data.map((row) => row.id));
        assert.deepEqual((await api('GET', `/audit/tenants/1?offset=${total}&limit=20`, { user: 1 })).body.data, []);

        assert.equal((await api('GET', '/audit/tenants/1', { user: 6 })).status, 200, 'a tenant admin');
        const member = await api('GET', '/audit/tenants/1', { user: 2 });
        assert.equal(member.status, 403, 'a plain member');
        assert.equal(member.body.error.code, 'TENANT_ROLE_REQUIRED');
        assert.equal((await api('GET', '/audit/tenants/1', { user: 3 })).status, 404, 'another tenant\'s owner');
        assert.equal((await api('GET', '/audit/tenants/1', { user: 5 })).status, 403, 'no AUDIT_READ');
        assert.equal((await api('GET', '/audit/tenants/1')).status, 401);
        assert.equal((await api('GET', '/audit/tenants/abc', { user: 1 })).status, 400);

        const other = await api('GET', '/audit/tenants/2', { user: 3 });
        assert.equal(other.status, 200);
        assert.ok(other.body.data.length > 0 && other.body.data.every((row) => row.tenantId === '2'));
        assert.equal(JSON.stringify(other.body).includes('ACME-ONLY'), false);

        await pool.query(`UPDATE tenants SET status='deleted' WHERE id=1`);
        assert.equal((await api('GET', '/audit/tenants/1', { user: 1 })).status, 404, 'a deleted tenant');
    });
});
