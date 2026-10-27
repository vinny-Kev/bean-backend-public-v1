import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import { pool } from '../../db/pool.js';
import { processIntegrationEventBatch } from '../services/integrationEventWorker.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';
import { SECRETS, resetSchema, saleEvent, seedFixtures, testDatabaseSkipReason } from './support/testDatabase.js';
import { startTestServer } from './support/testServer.js';

if (testDatabaseSkipReason) {
    reportBlockedIntegrationCheck('PostgreSQL integration dashboard tests', 'a local *_test database is configured',
        `skipped: ${testDatabaseSkipReason}`);
}

let api;
let sendEvent;
let close;

const acme = (event) => sendEvent(1, 'acme-store-key', SECRETS.acme, event);
const globex = (event) => sendEvent(2, 'globex-store-key', SECRETS.globex, event);
const adjustment = (eventId) => ({ eventId, eventType: 'inventory.adjusted', occurredAt: new Date().toISOString(),
    payload: { productId: 'BEAN-42', quantity: 4, adjustment: 'increase' } });

// One processed sale, one failed sale, one duplicate, one invalid delivery, one processed
// adjustment for Acme, plus a processed Globex sale that must never appear in Acme's views.
const seedActivity = async () => {
    assert.equal((await acme(saleEvent())).status, 202);
    assert.equal((await acme(saleEvent())).status, 200);
    assert.equal((await acme(saleEvent({ eventId: 'bad-1' }, { saleAmount: 'free' }))).status, 400);
    assert.equal((await acme(saleEvent({ eventId: 'evt-2' }, { externalTransactionId: 'order-2', externalUserId: 'unmapped' }))).status, 202);
    assert.equal((await acme(adjustment('adj-1'))).status, 202);
    assert.equal((await globex(saleEvent({ eventId: 'globex-1' }, { externalTransactionId: 'g-1', externalUserId: 'emp-9' }))).status, 202);
    await processIntegrationEventBatch();
};

const allPages = async (path, user, limit) => {
    const rows = [];
    for (let page = 1; page < 50; page += 1) {
        const response = await api('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=${limit}`, { user });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        rows.push(...response.body.data);
        if (!response.body.pagination.hasMore) return { rows, total: response.body.pagination.total };
    }
    throw new Error('pagination did not terminate');
};

describe('integration dashboard APIs against PostgreSQL', { skip: testDatabaseSkipReason, concurrency: false }, () => {
    before(async () => {
        await resetSchema();
        ({ api, sendEvent, close } = await startTestServer());
    });
    after(async () => {
        await close?.();
        await pool.end();
    });
    beforeEach(seedFixtures);

    test('application list keeps its contract, exposes no credentials, and validates the tenant selector', async () => {
        const list = await api('GET', '/integrations/all/1', { user: 2 });
        assert.equal(list.status, 200);
        assert.deepEqual(Object.keys(list.body.data[0]).sort(), ['appUrl', 'createdAt', 'createdByUserId', 'description', 'id',
            'lastEventAt', 'name', 'status', 'tenantId', 'updatedAt', 'webhookUrl']);
        assert.equal(JSON.stringify(list.body).includes('credential'), false);

        assert.deepEqual((await api('GET', '/integrations/all/1', { user: 3 })).body.data, [], 'non-members see nothing');
        const paged = await api('GET', '/integrations/all/1?page=1&limit=1', { user: 1 });
        assert.equal(paged.body.pagination.total, 1);
        assert.equal((await api('GET', '/integrations/all/2?page=1&limit=1', { user: 1 })).body.pagination.total, 0,
            'the count is scoped to tenants the caller belongs to');
        for (const selector of ['0x1', '1e0', '0', 'abc']) {
            assert.equal((await api('GET', `/integrations/all/${selector}`, { user: 1 })).status, 400, selector);
        }
    });

    test('dashboard endpoints resolve the integration from server-side membership', async () => {
        for (const view of ['activity', 'audit', 'analytics']) {
            const path = `/integrations/1/${view}`;
            assert.equal((await api('GET', path)).status, 401, `${view} unauthenticated`);
            assert.equal((await api('GET', path, { user: 5 })).status, 403, `${view} without INTEGRATIONS_READ`);
            assert.equal((await api('GET', path, { user: 3 })).status, 404, `${view} from another tenant`);
            assert.equal((await api('GET', path, { user: 4 })).status, 404, `${view} from a user with no tenant`);
            assert.equal((await api('GET', `${path}?tenantId=2`, { user: 1 })).status, 404, `${view} with a mismatched tenantId`);
            assert.equal((await api('GET', `${path}?tenantId=x`, { user: 1 })).status, 400, `${view} with an invalid tenantId`);
            assert.equal((await api('GET', `${path}?tenantId=1`, { user: 2 })).status, 200, `${view} with a matching tenantId`);
            assert.equal((await api('GET', path, { user: 2 })).status, 200, `${view} for a plain member`);
        }
    });

    test('activity distinguishes acceptance, duplicates, invalid deliveries, processing, and failures without payloads', async () => {
        await seedActivity();
        const { rows, total } = await allPages('/integrations/1/activity', 2, 4);
        assert.equal(rows.length, total);
        const byType = (type) => rows.filter((row) => row.recordType === type);

        const events = Object.fromEntries(byType('integration_event').map((row) => [row.eventId, row]));
        assert.deepEqual(Object.keys(events).sort(), ['adj-1', 'evt-1', 'evt-2']);
        assert.equal(events['evt-1'].status, 'processed');
        assert.notEqual(events['evt-1'].processedAt, null);
        assert.notEqual(events['evt-1'].receivedAt, null);
        assert.notEqual(events['evt-1'].eventOccurredAt, null);
        assert.equal(events['evt-1'].attemptCount, 1);
        assert.equal(events['evt-2'].status, 'failed');
        assert.equal(events['evt-2'].errorCode, 'EMPLOYEE_MAPPING_MISSING');
        assert.match(events['evt-2'].errorSummary, /employee mapping/);

        const deliveries = byType('delivery_diagnostic').map((row) => `${row.eventId}:${row.status}`).sort();
        assert.deepEqual(deliveries, ['adj-1:accepted', 'bad-1:invalid', 'evt-1:accepted', 'evt-1:duplicate', 'evt-2:accepted']);
        assert.deepEqual(byType('processing_attempt').map((row) => row.status).sort(), ['failed', 'processed', 'processed']);
        assert.equal(byType('sale').length, 1);
        assert.deepEqual(byType('analytics_outbox').map((row) => row.eventType).sort(), ['inventory.adjusted', 'sale.processed']);

        const serialized = JSON.stringify(rows);
        assert.equal(serialized.includes('globex'), false, 'another tenant\'s events never appear');
        assert.ok(rows.every((row) => !Object.hasOwn(row, 'payload')));
        assert.equal(serialized.includes('emp-1'), false, 'payload values such as the external user are not exposed');
        assert.equal(serialized.includes('"free"'), false, 'rejected payload values are not echoed');
        assert.match(byType('delivery_diagnostic').find((row) => row.eventId === 'bad-1').errorSummary, /saleAmount/,
            'invalid deliveries carry an actionable field-level summary');

        for (let i = 1; i < rows.length; i += 1) {
            assert.ok(new Date(rows[i - 1].occurredAt) >= new Date(rows[i].occurredAt), 'newest first');
        }
        assert.equal(new Set(rows.map((row) => `${row.recordType}:${row.id}`)).size, rows.length, 'pages never overlap');
    });

    test('activity filters by status, record type, event type, and time window, with explicit empty results', async () => {
        await seedActivity();
        const get = async (query) => {
            const response = await api('GET', `/integrations/1/activity?${query}`, { user: 1 });
            assert.equal(response.status, 200, `${query}: ${JSON.stringify(response.body)}`);
            return response.body;
        };
        const failed = await get('status=failed');
        assert.deepEqual(failed.data.map((row) => `${row.recordType}:${row.eventId}`).sort(),
            ['integration_event:evt-2', 'processing_attempt:evt-2']);
        assert.equal((await get('recordType=delivery_diagnostic&status=duplicate')).pagination.total, 1);
        assert.ok((await get('eventType=inventory.adjusted')).data.every((row) => row.eventType === 'inventory.adjusted'));
        const future = await get(`from=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`);
        assert.deepEqual(future.data, []);
        assert.equal(future.pagination.total, 0);
        for (const bad of ['status=bogus', 'recordType=lifecycle', 'eventType=Bad Type', 'from=yesterday',
            'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z']) {
            assert.equal((await api('GET', `/integrations/1/activity?${bad}`, { user: 1 })).status, 400, bad);
        }
        const freshApp = await api('GET', '/integrations/2/activity', { user: 3 });
        assert.equal(freshApp.status, 200);
    });

    test('audit history combines attributable audit and lifecycle records for this integration only', async () => {
        await seedActivity();
        assert.equal((await api('PUT', '/integrations/1/subscriptions', { user: 1, body: { eventTypes: ['transaction.completed', 'inventory.adjusted'] } })).status, 200);
        assert.equal((await api('PUT', '/integrations/1/user-mappings', { user: 1, body: { externalUserId: 'unmapped', userId: 2 } })).status, 200);
        assert.equal((await api('POST', '/integrations/1/suspend', { user: 1 })).status, 200);
        assert.equal((await api('POST', '/integrations/1/activate', { user: 1 })).status, 200);
        const rotated = await api('POST', '/integrations/1/credentials/rotate', { user: 1, body: { tenantId: '1' } });
        assert.equal(rotated.status, 200);
        assert.equal((await api('PUT', '/integrations/tenants/1/settings/inventory-policy', { user: 1,
            body: { inventoryShortagePolicy: 'allow_negative_inventory' } })).status, 200);
        assert.equal((await api('POST', '/integrations/2/suspend', { user: 3 })).status, 200);
        await pool.query(`INSERT INTO audit_logs (user_id, action, table_name, record_id, new_data)
            VALUES (1, 'MANUAL NOTE', 'integrated_apps', 1, '{"status":"active","credential":"leaked-secret","password":"p"}')`);

        const { rows, total } = await allPages('/integrations/1/audit', 2, 5);
        assert.equal(rows.length, total);
        const auditActions = rows.filter((row) => row.source === 'audit_log').map((row) => row.action);
        for (const action of ['UPDATE INTEGRATION SUBSCRIPTIONS', 'UPDATE INTEGRATION USER MAPPING', 'SUSPEND INTEGRATION',
            'ACTIVATE INTEGRATION', 'ROTATE INTEGRATION CREDENTIAL', 'PROCESS INTEGRATION EVENT', 'FAIL INTEGRATION EVENT', 'MANUAL NOTE']) {
            assert.ok(auditActions.includes(action), action);
        }
        assert.equal(auditActions.includes('UPDATE INTEGRATION INVENTORY POLICY'), false, 'tenant-wide settings are not attributed to one integration');
        assert.equal(auditActions.filter((action) => action === 'SUSPEND INTEGRATION').length, 1, 'Globex suspension is excluded');
        assert.equal(auditActions.filter((action) => action === 'PROCESS INTEGRATION EVENT').length, 2, 'Globex processing is excluded');
        const lifecycle = rows.filter((row) => row.source === 'lifecycle').map((row) => row.action);
        for (const action of ['subscriptions.updated', 'user_mapping.updated', 'integration.suspended', 'integration.activated',
            'credential.rotated', 'inventory.shortage_policy.updated']) {
            assert.ok(lifecycle.includes(action), action);
        }
        assert.ok(rows.every((row) => row.resourceType !== 'integrated_apps' || String(row.resourceId) === '1'));

        const manual = rows.find((row) => row.action === 'MANUAL NOTE');
        assert.deepEqual(manual.changes, { before: null, after: { status: 'active' } });
        const serialized = JSON.stringify(rows);
        for (const secret of ['leaked-secret', rotated.body.data.credential, SECRETS.acme]) assert.equal(serialized.includes(secret), false);

        const system = await api('GET', '/integrations/1/audit?actor=system', { user: 1 });
        assert.ok(system.body.data.length > 0);
        assert.ok(system.body.data.every((row) => row.actorType === 'system' && row.actorUserId === null));
        const onlyLifecycle = await api('GET', '/integrations/1/audit?source=lifecycle&limit=20', { user: 1 });
        assert.ok(onlyLifecycle.body.data.every((row) => row.source === 'lifecycle' && row.changes === null));
        assert.equal((await api('GET', '/integrations/1/audit?source=webhook', { user: 1 })).status, 400);
        assert.deepEqual((await api('GET', `/integrations/1/audit?to=${encodeURIComponent('2020-01-01T00:00:00Z')}`, { user: 1 })).body.data, []);
    });

    test('analytics report only records verifiably linked to the integration, with explicit empty states', async () => {
        const empty = await api('GET', '/integrations/1/analytics', { user: 2 });
        assert.equal(empty.status, 200);
        assert.equal(empty.body.data.events.total, 0);
        assert.equal(empty.body.data.events.successRate, null);
        assert.deepEqual(empty.body.data.sales.byCurrency, []);
        assert.equal(empty.body.data.processingLatencyMs.average, null);

        await seedActivity();
        const { data } = (await api('GET', '/integrations/1/analytics', { user: 2 })).body;
        assert.equal(data.schemaVersion, 1);
        assert.equal(data.integrationId, '1');
        assert.deepEqual(data.events.byStatus, { pending: 0, processing: 0, processed: 2, failed: 1 });
        assert.equal(data.events.successRate, 2 / 3);
        assert.deepEqual(data.events.topFailureCodes, [{ errorCode: 'EMPLOYEE_MAPPING_MISSING', count: 1 }]);
        assert.deepEqual(data.deliveries, { accepted: 3, duplicate: 1, invalid: 1, ingestionFailed: 0 });
        assert.equal(data.processingLatencyMs.samples, 2);
        assert.ok(data.processingLatencyMs.max >= data.processingLatencyMs.p50);
        assert.deepEqual(data.sales.byCurrency, [{ currency: 'PHP', transactions: 1, quantity: 2, grossAmount: '1299.00' }],
            'the Globex sale is not attributed to Acme');
        assert.deepEqual(data.commissions.byCurrency, [{ currency: 'PHP', status: 'pending', count: 1, amount: '64.95' }]);
        assert.deepEqual(data.inventoryAdjustments.byAdjustment, { increase: 1, decrease: 0, set: 0 });

        const globexView = (await api('GET', '/integrations/2/analytics', { user: 3 })).body.data;
        assert.equal(globexView.sales.byCurrency[0].transactions, 1);
        assert.deepEqual(globexView.commissions.byCurrency, []);

        const past = (await api('GET', `/integrations/1/analytics?from=${encodeURIComponent('2025-01-01T00:00:00Z')}&to=${encodeURIComponent('2025-02-01T00:00:00Z')}`, { user: 2 })).body.data;
        assert.equal(past.events.total, 0);
        assert.deepEqual(past.window, { from: '2025-01-01T00:00:00.000Z', to: '2025-02-01T00:00:00.000Z' });
        assert.equal((await api('GET', `/integrations/1/analytics?from=${encodeURIComponent('2024-01-01T00:00:00Z')}`, { user: 2 })).status, 400);
        assert.equal((await api('GET', '/integrations/1/analytics?groupBy=day', { user: 2 })).status, 400);

        // Dashboard reads write nothing.
        const before = (await pool.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n;
        await api('GET', '/integrations/1/analytics', { user: 2 });
        await api('GET', '/integrations/1/activity', { user: 2 });
        await api('GET', '/integrations/1/audit', { user: 2 });
        assert.equal((await pool.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n, before);
    });
});
