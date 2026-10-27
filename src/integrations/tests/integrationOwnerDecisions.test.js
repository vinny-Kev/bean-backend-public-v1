import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { pool } from '../../db/pool.js';
import { getIntegrationActivity } from '../services/integrationActivityService.js';
import { updateInventoryShortagePolicy } from '../services/integrationSettingsService.js';
import { rotateIntegrationCredential } from '../services/integrationCredentialService.js';
import { runIntegrationRetentionBatch } from '../services/integrationRetentionService.js';
import { getInventoryShortageBehavior, resolveInventoryShortagePolicy } from '../services/integrationPolicy.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';

reportBlockedIntegrationCheck('PostgreSQL transaction and concurrency coverage',
    'isolated PostgreSQL integration tests execute',
    'not in this file: these tests mock pool calls; run `npm run test:db` against a local *_test database');

const responseCapture = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
});

test('activity feed enforces tenant/integration scope and bounded filters/pagination', async () => {
    const originalQuery = pool.query;
    const calls = [];
    pool.query = async (sql, values) => {
        calls.push({ sql, values });
        if (calls.length === 1) return { rowCount: 1, rows: [{ id: 12, tenant_id: 4, membership_role: 'member' }] };
        if (calls.length === 2) return { rowCount: 1, rows: [{ total: 1 }] };
        return { rowCount: 1, rows: [{ record_id: '17', record_type: 'processing_attempt', event_id: 'sale-1',
            internal_event_id: '9',
            event_type: 'transaction.completed', external_transaction_id: 'order-1', correlation_id: 'corr-1',
            occurred_at: new Date('2026-01-01T00:00:00Z'), stage: 'worker_attempt', outcome: 'processed',
            error_code: null, error_summary: null, related_event_id: '9', related_record_id: '1' }] };
    };
    try {
        const req = { params: { integration_id: '12' }, query: { tenantId: '4', from: '2026-01-01T00:00:00Z',
            to: '2026-01-02T00:00:00Z', eventType: 'transaction.completed', status: 'processed' },
            user: { id: 3 }, pagination: { limit: 5, offset: 10 } };
        const res = responseCapture();
        await getIntegrationActivity(req, res, (error) => { throw error; });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.data[0].eventId, 'sale-1');
        assert.equal(res.body.data[0].internalEventId, '9');
        assert.deepEqual(calls[0].values, [12, 3], 'the integration is resolved through the caller membership');
        const activityQuery = calls[1];
        assert.match(activityQuery.sql, /e\.tenant_id=\$1 AND e\.integrated_app_id=\$2/);
        assert.match(activityQuery.sql, /o\.tenant_id=\$1 AND o\.source_integration_id=\$2/);
        assert.deepEqual(activityQuery.values.slice(0, 2), [4, 12]);
        assert.ok(activityQuery.values.includes('transaction.completed'));
        assert.ok(activityQuery.values.includes('processed'));
        assert.deepEqual(calls[2].values.slice(-2), [5, 10]);
        assert.equal(Object.hasOwn(res.body.data[0], 'payload'), false);
    } finally { pool.query = originalQuery; }
});

test('activity feed hides an integration from a user outside its tenant', async () => {
    const originalQuery = pool.query;
    let calls = 0;
    pool.query = async () => { calls += 1; return { rowCount: 0, rows: [] }; };
    try {
        const res = responseCapture();
        await getIntegrationActivity({ params: { integration_id: '12' }, query: { tenantId: '4' },
            user: { id: 99 } }, res, (error) => { throw error; });
        assert.equal(res.statusCode, 404);
        assert.equal(calls, 1);
    } finally { pool.query = originalQuery; }
});

test('credential rotation returns a bcrypt-compatible secret once and never puts it in audit data', async () => {
    const originalConnect = pool.connect;
    const statements = [];
    let storedHash;
    pool.connect = async () => ({
        async query(sql, values = []) {
            statements.push({ sql, values });
            if (sql.includes('SELECT ia.id')) return { rowCount: 1, rows: [{ id: 9, tenant_id: 4,
                app_key: 'shop-key', status: 'active', membership_role: 'admin' }] };
            if (sql.startsWith('UPDATE integrated_apps')) storedHash = values[0];
            return { rowCount: 1, rows: [] };
        },
        release() {},
    });
    try {
        const res = responseCapture();
        await rotateIntegrationCredential({ params: { integration_id: '9' }, body: { tenantId: '4' },
            user: { id: 3 }, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, res, (error) => { throw error; });
        const secret = res.body.data.credential;
        assert.equal(res.statusCode, 200);
        assert.equal(typeof secret, 'string');
        assert.equal(await bcrypt.compare(secret, storedHash), true);
        assert.ok(statements.some(({ sql }) => sql.includes('credential.rotated')));
        const auditWrite = statements.find(({ sql }) => sql.includes('INSERT INTO audit_logs'));
        assert.ok(auditWrite);
        assert.equal(JSON.stringify(auditWrite.values).includes(secret), false);
        assert.equal(JSON.stringify(statements.map(({ values }) => values)).includes(secret), false);
    } finally { pool.connect = originalConnect; }
});

test('retention batch deletes only eligible processed outbox and source events in bounded batches', async () => {
    const originalConnect = pool.connect;
    const statements = [];
    pool.connect = async () => ({
        async query(sql, values = []) {
            statements.push({ sql, values });
            return { rowCount: 0, rows: [] };
        },
        release() {},
    });
    try {
        const result = await runIntegrationRetentionBatch({ batchSize: 7 });
        assert.deepEqual(result, { outbox: 0, events: 0, attempts: 0, diagnostics: 0 });
        const deletes = statements.filter(({ sql }) => sql.includes('WITH expired'));
        assert.equal(deletes.length, 4);
        assert.match(deletes[0].sql, /status='processed'/);
        assert.match(deletes[1].sql, /status='processed'/);
        assert.ok(deletes.every(({ values }) => values[1] === 7));
        assert.match(deletes[0].sql, /FOR UPDATE SKIP LOCKED/);
    } finally { pool.connect = originalConnect; }
});

test('inventory shortage policy defaults safely and rejects unknown values', () => {
    assert.equal(resolveInventoryShortagePolicy(undefined), 'require_intervention');
    assert.equal(resolveInventoryShortagePolicy('allow_negative_inventory'), 'allow_negative_inventory');
    assert.equal(resolveInventoryShortagePolicy('record_sale_without_stock_deduction'), 'record_sale_without_stock_deduction');
    assert.equal(resolveInventoryShortagePolicy('trust_client_payload'), 'require_intervention');
    assert.deepEqual(getInventoryShortageBehavior('require_intervention'), {
        policy: 'require_intervention', deductStock: true, allowNegative: false,
    });
    assert.deepEqual(getInventoryShortageBehavior('allow_negative_inventory'), {
        policy: 'allow_negative_inventory', deductStock: true, allowNegative: true,
    });
    assert.deepEqual(getInventoryShortageBehavior('record_sale_without_stock_deduction'), {
        policy: 'record_sale_without_stock_deduction', deductStock: false, allowNegative: false,
    });
});

test('tenant inventory policy cannot be changed by a non-admin tenant member', async () => {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    let connectCalls = 0;
    const statements = [];
    pool.query = async () => ({ rowCount: 1, rows: [] });
    pool.connect = async () => {
        connectCalls += 1;
        return { async query(sql) { statements.push(sql); return sql.startsWith('SELECT membership_role')
            ? { rowCount: 1, rows: [{ membership_role: 'staff' }] } : { rowCount: 0, rows: [] }; }, release() {} };
    };
    try {
        const res = responseCapture();
        await updateInventoryShortagePolicy({ params: { tenant_id: '4' },
            body: { inventoryShortagePolicy: 'allow_negative_inventory' }, user: { id: 3 } },
        res, (error) => { throw error; });
        assert.equal(res.statusCode, 403);
        assert.equal(connectCalls, 1);
        assert.ok(statements.includes('ROLLBACK'));
        assert.equal(statements.some((sql) => sql.includes('INSERT INTO tenant_integration_settings')), false);
    } finally { pool.query = originalQuery; pool.connect = originalConnect; }
});

test('tenant integration list binds pagination after the tenant/user filters and scopes the count to members', async () => {
    const { getTenantIntegrations } = await import('../services/integrationService.js');
    const originalQuery = pool.query;
    const calls = [];
    pool.query = async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes('COUNT(*)')) return { rowCount: 1, rows: [{ total: 0 }] };
        return { rowCount: 0, rows: [] };
    };
    try {
        const res = responseCapture();
        await getTenantIntegrations({ params: { tenant_id: '4' }, user: { id: 3 },
            pagination: { page: 1, limit: 5, offset: 0 } }, res, (error) => { throw error; });
        assert.equal(res.statusCode, 200);
        assert.match(calls[0].sql, /LIMIT \$3 OFFSET \$4/);
        assert.deepEqual(calls[0].values, [4, 3, 5, 0]);
        assert.match(calls[1].sql, /tenant_members/);
        assert.deepEqual(calls[1].values, [4, 3]);
    } finally { pool.query = originalQuery; }
});
