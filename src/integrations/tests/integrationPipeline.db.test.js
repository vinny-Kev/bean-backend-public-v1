import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import express from 'express';
import { pool } from '../../db/pool.js';
import { errorHandler, notFoundHandler, requestContext } from '../../middleware/errorMiddleware.js';
import integrationRoutes from '../routes/integration.routes.js';
import { processIntegrationEventBatch } from '../services/integrationEventWorker.js';
import { retryIntegrationEvent } from '../services/integrationInvestigationService.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';
import { SECRETS, count, one, resetSchema, saleEvent, seedFixtures, testDatabaseSkipReason } from './support/testDatabase.js';

if (testDatabaseSkipReason) {
    reportBlockedIntegrationCheck('PostgreSQL integration pipeline tests', 'a local *_test database is configured',
        `skipped: ${testDatabaseSkipReason}`);
}

const credentials = {
    acme: { appId: 1, appKey: 'acme-store-key', secret: SECRETS.acme },
    globex: { appId: 2, appKey: 'globex-store-key', secret: SECRETS.globex },
};

let baseUrl;
let server;

const postEvent = async (body, { appId, appKey, secret } = credentials.acme) => {
    const response = await fetch(`${baseUrl}/integrations/${appId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bean-App-Key': appKey, Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
};

const acceptEvent = async (body, creds) => {
    const response = await postEvent(body, creds);
    assert.equal(response.status, 202, JSON.stringify(response.body));
    return one('SELECT * FROM integration_events WHERE event_id=$1 AND integrated_app_id=$2',
        [body.eventId, (creds ?? credentials.acme).appId]);
};

const responseCapture = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
});

const stock = async (tenantId) => (await one('SELECT quantity FROM inventory WHERE tenant_id=$1 AND sku=$2', [tenantId, 'BEAN-42'])).quantity;

describe('integration event pipeline against PostgreSQL', { skip: testDatabaseSkipReason, concurrency: false }, () => {
    before(async () => {
        await resetSchema();
        const app = express();
        app.use(requestContext);
        app.use('/integrations/', integrationRoutes);
        app.use(notFoundHandler);
        app.use(errorHandler);
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        await new Promise((resolve) => server?.close(resolve) ?? resolve());
        await pool.end();
    });
    beforeEach(seedFixtures);

    test('accepted event is durably queued with dedup tombstone, diagnostic, and last_event_at, but no business effects yet', async () => {
        const response = await postEvent(saleEvent());
        assert.equal(response.status, 202);
        assert.equal(response.body.data.status, 'pending');

        const event = await one('SELECT * FROM integration_events WHERE event_id=$1', ['evt-1']);
        assert.equal(event.status, 'pending');
        assert.equal(event.tenant_id, '1');
        assert.equal(event.handler_key, 'transaction_completed');
        assert.equal(event.correlation_id, 'checkout-1');
        assert.equal(event.attempt_count, 0);
        assert.equal(event.processed_at, null);
        assert.equal(await count(`SELECT COUNT(*) FROM integration_event_deduplication
            WHERE integrated_app_id=1 AND event_id='evt-1' AND tenant_id=1 AND external_transaction_id='order-1'`), 1);
        assert.equal(await count(`SELECT COUNT(*) FROM integration_event_diagnostics
            WHERE tenant_id=1 AND event_id='evt-1' AND outcome='accepted' AND http_status=202`), 1);
        assert.notEqual((await one('SELECT last_event_at FROM integrated_apps WHERE id=1')).last_event_at, null);
        assert.equal(await count('SELECT COUNT(*) FROM sales_transactions'), 0);
        assert.equal(await stock(1), 10);
    });

    test('sequential and concurrent duplicate deliveries persist exactly one event', async () => {
        await acceptEvent(saleEvent());
        const firstSeen = (await one('SELECT last_event_at FROM integrated_apps WHERE id=1')).last_event_at;

        const responses = await Promise.all(Array.from({ length: 8 }, () => postEvent(saleEvent())));
        assert.deepEqual(responses.map((r) => r.status), Array(8).fill(200));
        assert.ok(responses.every((r) => r.body.data.status === 'duplicate'));

        const race = await Promise.all(Array.from({ length: 8 }, () => postEvent(saleEvent({ eventId: 'evt-race' }))));
        assert.equal(race.filter((r) => r.status === 202).length, 1);
        assert.equal(race.filter((r) => r.status === 200).length, 7);

        assert.equal(await count(`SELECT COUNT(*) FROM integration_events WHERE event_id IN ('evt-1','evt-race')`), 2);
        assert.equal(await count(`SELECT COUNT(*) FROM integration_event_diagnostics WHERE outcome='duplicate'`), 15);
        // A duplicate is not new activity from the integration: last_event_at must not move.
        // evt-race's single acceptance does advance it, so compare against a duplicate-only replay.
        assert.ok(firstSeen instanceof Date);
        const beforeReplay = (await one('SELECT last_event_at FROM integrated_apps WHERE id=1')).last_event_at;
        await postEvent(saleEvent());
        const afterReplay = (await one('SELECT last_event_at FROM integrated_apps WHERE id=1')).last_event_at;
        assert.equal(afterReplay.getTime(), beforeReplay.getTime());
    });

    test('authentication failures persist nothing and record only an anonymous diagnostic', async () => {
        await pool.query(`UPDATE integrated_apps SET status='pending' WHERE id=2`);
        const attempts = [
            postEvent(saleEvent(), { ...credentials.acme, secret: SECRETS.globex }),
            postEvent(saleEvent(), { ...credentials.acme, appKey: 'globex-store-key' }),
            postEvent(saleEvent(), { ...credentials.globex, appId: 1 }),
            postEvent(saleEvent(), credentials.globex),
        ];
        for (const response of await Promise.all(attempts)) {
            assert.equal(response.status, 401);
            assert.equal(response.body.error.code, 'INTEGRATION_AUTH_FAILED');
        }
        assert.equal(await count('SELECT COUNT(*) FROM integration_events'), 0);
        assert.equal(await count(`SELECT COUNT(*) FROM integration_event_diagnostics
            WHERE outcome='unauthorized' AND tenant_id IS NULL AND integrated_app_id IS NULL AND event_id IS NULL`), 4);
        assert.equal((await one('SELECT last_event_at FROM integrated_apps WHERE id=1')).last_event_at, null);
    });

    test('a suspended tenant cannot deliver events even with valid integration credentials', async () => {
        await pool.query(`UPDATE tenants SET status='suspended' WHERE id=1`);
        const response = await postEvent(saleEvent());
        assert.equal(response.status, 401);
        assert.equal(await count('SELECT COUNT(*) FROM integration_events'), 0);
    });

    test('tenant identity comes only from the authenticated integration, never the request body', async () => {
        const spoofed = await postEvent({ ...saleEvent(), tenantId: 2 });
        assert.equal(spoofed.status, 400);
        assert.equal(spoofed.body.error.code, 'INVALID_EVENT');
        assert.equal(await count('SELECT COUNT(*) FROM integration_events'), 0);
    });

    test('unsubscribed event types and contract violations are rejected before persistence', async () => {
        const unsubscribed = await postEvent({ eventId: 'adj-1', eventType: 'inventory.adjusted',
            occurredAt: new Date().toISOString(), payload: { productId: 'BEAN-42', quantity: 1, adjustment: 'increase' } },
        credentials.globex);
        assert.equal(unsubscribed.status, 422);
        assert.equal(unsubscribed.body.error.code, 'EVENT_NOT_SUBSCRIBED');

        // The legacy snake_case payload that the drifted registry schema used to require.
        const legacy = await postEvent({ eventId: 'legacy-1', eventType: 'transaction.completed',
            occurredAt: new Date().toISOString(), payload: { transaction_id: 'order-1', product_id: 'BEAN-42',
                quantity: 1, sale_amount: 10, currency: 'PHP', timestamp: new Date().toISOString() } });
        assert.equal(legacy.status, 400);
        assert.equal(legacy.body.error.code, 'INVALID_EVENT_PAYLOAD');

        const numericAmount = await postEvent(saleEvent({ eventId: 'float-1' }, { saleAmount: 12.5 }));
        assert.equal(numericAmount.status, 400);

        assert.equal(await count('SELECT COUNT(*) FROM integration_events'), 0);
        assert.equal(await count(`SELECT COUNT(*) FROM integration_event_diagnostics WHERE outcome='invalid' AND tenant_id IS NOT NULL`), 3);
        // Rejected deliveries are not integration activity.
        assert.equal(await count('SELECT COUNT(*) FROM integrated_apps WHERE last_event_at IS NOT NULL'), 0);
    });

    test('worker applies a sale atomically: stock, sale, commission, outbox, status, attempt, and audit', async () => {
        const queued = await acceptEvent(saleEvent());
        assert.equal(await processIntegrationEventBatch(), 1);

        assert.equal(await stock(1), 8);
        assert.equal(await stock(2), 7, 'another tenant sharing the SKU is untouched');
        const sale = await one('SELECT * FROM sales_transactions');
        assert.equal(sale.tenant_id, '1');
        assert.equal(sale.integrated_app_id, '1');
        assert.equal(sale.source_event_id, queued.id);
        assert.equal(sale.source_event_key, 'evt-1');
        assert.equal(sale.correlation_id, 'checkout-1');
        assert.equal(sale.external_transaction_id, 'order-1');
        assert.equal(sale.product_id, 'BEAN-42');
        assert.equal(sale.quantity, 2);
        assert.equal(sale.status, 'completed');
        assert.equal(sale.sale_amount, '1299.00');
        assert.equal(sale.currency, 'PHP');
        assert.deepEqual(sale.inventory_policy_snapshot, { policy: 'require_intervention', action: 'deducted' });

        const commission = await one('SELECT * FROM sales_commissions');
        assert.equal(commission.sales_transaction_id, sale.id);
        assert.equal(commission.user_id, '1');
        assert.equal(commission.commission_amount, '64.95');
        assert.equal(commission.status, 'pending');

        const outbox = await one('SELECT * FROM analytics_outbox');
        assert.equal(outbox.event_type, 'sale.processed');
        assert.equal(outbox.status, 'pending');
        assert.equal(outbox.source_integration_id, '1');
        assert.equal(outbox.payload.saleId, sale.id);

        const event = await one('SELECT * FROM integration_events WHERE id=$1', [queued.id]);
        assert.equal(event.status, 'processed');
        assert.notEqual(event.processed_at, null);
        assert.equal(event.attempt_count, 1);
        assert.equal(event.lease_owner, null);
        assert.equal(event.error_code, null);
        const attempt = await one('SELECT * FROM integration_event_attempts WHERE integration_event_id=$1', [queued.id]);
        assert.equal(attempt.outcome, 'processed');
        assert.notEqual(attempt.finished_at, null);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='PROCESS INTEGRATION EVENT' AND record_id=$1`, [queued.id]), 1);

        // Re-running the worker never re-applies a processed event.
        assert.equal(await processIntegrationEventBatch(), 0);
        assert.equal(await stock(1), 8);
        assert.equal(await count('SELECT COUNT(*) FROM sales_transactions'), 1);
    });

    test('an action-required failure rolls back all business writes; an admin retry then completes it', async () => {
        await pool.query('UPDATE integration_user_mappings SET is_active=false WHERE external_user_id=$1', ['emp-1']);
        const queued = await acceptEvent(saleEvent());
        await processIntegrationEventBatch();

        let event = await one('SELECT * FROM integration_events WHERE id=$1', [queued.id]);
        assert.equal(event.status, 'failed');
        assert.equal(event.error_code, 'EMPLOYEE_MAPPING_MISSING');
        assert.equal(event.failure_classification, 'action_required');
        assert.equal(event.next_attempt_at, null);
        assert.equal(await stock(1), 10);
        assert.equal(await count('SELECT COUNT(*) FROM sales_transactions'), 0);
        assert.equal(await count('SELECT COUNT(*) FROM analytics_outbox'), 0);
        assert.equal((await one('SELECT outcome FROM integration_event_attempts WHERE integration_event_id=$1', [queued.id])).outcome, 'failed');

        const retryRequest = (userId) => ({ params: { event_id: String(queued.id) },
            body: { tenantId: '1', reason: 'Re-activated the employee mapping' }, user: { id: userId } });
        const memberResponse = responseCapture();
        await retryIntegrationEvent(retryRequest(2), memberResponse, (error) => { throw error; });
        assert.equal(memberResponse.statusCode, 403, 'a non-admin tenant member cannot retry');
        const outsiderResponse = responseCapture();
        await retryIntegrationEvent(retryRequest(3), outsiderResponse, (error) => { throw error; });
        assert.equal(outsiderResponse.statusCode, 403, 'another tenant\'s owner cannot retry');

        await pool.query('UPDATE integration_user_mappings SET is_active=true WHERE external_user_id=$1', ['emp-1']);
        const ownerResponse = responseCapture();
        await retryIntegrationEvent(retryRequest(1), ownerResponse, (error) => { throw error; });
        assert.equal(ownerResponse.statusCode, 202);
        await processIntegrationEventBatch();

        event = await one('SELECT * FROM integration_events WHERE id=$1', [queued.id]);
        assert.equal(event.status, 'processed');
        assert.equal(event.attempt_count, 2);
        assert.equal(event.retry_requested_by_user_id, null);
        const retried = await one('SELECT * FROM integration_event_attempts WHERE integration_event_id=$1 AND attempt_number=2', [queued.id]);
        assert.equal(retried.outcome, 'processed');
        assert.equal(retried.initiated_by_user_id, '1');
        assert.equal(retried.retry_reason, 'Re-activated the employee mapping');
        assert.equal(await stock(1), 8);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='RETRY INTEGRATION EVENT' AND user_id=1`), 1);

        const again = responseCapture();
        await retryIntegrationEvent(retryRequest(1), again, (error) => { throw error; });
        assert.equal(again.statusCode, 409, 'a processed event is not eligible for retry');
    });

    test('insufficient stock fails under the default policy and is allowed under allow_negative_inventory', async () => {
        await acceptEvent(saleEvent({}, { quantity: 11 }));
        await processIntegrationEventBatch();
        assert.equal((await one(`SELECT error_code FROM integration_events WHERE event_id='evt-1'`)).error_code, 'INVENTORY_UNAVAILABLE');
        assert.equal(await stock(1), 10);
        assert.equal(await count('SELECT COUNT(*) FROM sales_commissions'), 0);

        await pool.query(`INSERT INTO tenant_integration_settings (tenant_id, inventory_shortage_policy) VALUES (1, 'allow_negative_inventory')`);
        await acceptEvent(saleEvent({ eventId: 'evt-2' }, { quantity: 11, externalTransactionId: 'order-2' }));
        await processIntegrationEventBatch();
        assert.equal((await one(`SELECT status FROM integration_events WHERE event_id='evt-2'`)).status, 'processed');
        assert.equal(await stock(1), -1);
    });

    test('the same external transaction under a new event ID is a business conflict, not a second sale', async () => {
        await acceptEvent(saleEvent());
        await acceptEvent(saleEvent({ eventId: 'evt-redelivered' }));
        await processIntegrationEventBatch();
        assert.equal(await count('SELECT COUNT(*) FROM sales_transactions'), 1);
        assert.equal(await count('SELECT COUNT(*) FROM sales_commissions'), 1);
        assert.equal(await count('SELECT COUNT(*) FROM analytics_outbox'), 1, 'the rolled-back conflict publishes nothing');
        assert.equal(await stock(1), 8);
        const conflict = await one(`SELECT * FROM integration_events WHERE event_id='evt-redelivered'`);
        assert.equal(conflict.status, 'failed');
        assert.equal(conflict.error_code, 'BUSINESS_CONFLICT');
    });

    test('worker effects stay inside the event tenant', async () => {
        await acceptEvent(saleEvent({ eventId: 'globex-1' }, { externalUserId: 'emp-9', quantity: 3 }), credentials.globex);
        await processIntegrationEventBatch();
        assert.equal(await stock(2), 4);
        assert.equal(await stock(1), 10);
        const sale = await one('SELECT tenant_id FROM sales_transactions');
        assert.equal(sale.tenant_id, '2');
        assert.equal(await count('SELECT COUNT(*) FROM sales_commissions'), 0, 'Globex has no commission rule');
    });

    test('a tenant suspended after acceptance gets no business effects', async () => {
        await acceptEvent(saleEvent());
        await pool.query(`UPDATE tenants SET status='suspended' WHERE id=1`);
        await processIntegrationEventBatch();
        const event = await one(`SELECT * FROM integration_events WHERE event_id='evt-1'`);
        assert.equal(event.status, 'failed');
        assert.equal(event.error_code, 'TENANT_INACTIVE');
        assert.equal(event.failure_classification, 'action_required');
        assert.equal(await stock(1), 10);
        assert.equal(await count('SELECT COUNT(*) FROM sales_transactions'), 0);
        assert.equal(await count('SELECT COUNT(*) FROM analytics_outbox'), 0);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='FAIL INTEGRATION EVENT'`), 1);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='PROCESS INTEGRATION EVENT'`), 0);
    });

    test('inventory adjustments apply increase/decrease/set and refuse to go negative', async () => {
        const adjust = (eventId, adjustment, quantity) => acceptEvent({ eventId, eventType: 'inventory.adjusted',
            occurredAt: new Date().toISOString(), payload: { productId: 'BEAN-42', quantity, adjustment } });
        await adjust('adj-1', 'increase', 5);
        await adjust('adj-2', 'decrease', 3);
        await processIntegrationEventBatch();
        assert.equal(await stock(1), 12);
        await adjust('adj-3', 'set', 4);
        await adjust('adj-4', 'decrease', 9);
        await processIntegrationEventBatch();
        assert.equal(await stock(1), 4);
        assert.equal((await one(`SELECT error_code FROM integration_events WHERE event_id='adj-4'`)).error_code, 'INVENTORY_UNAVAILABLE');
        assert.equal(await count(`SELECT COUNT(*) FROM analytics_outbox WHERE event_type='inventory.adjusted'`), 3);
        assert.equal(await stock(2), 7);
    });

    test('concurrent worker batches process each event exactly once', async () => {
        for (let i = 1; i <= 5; i += 1) {
            await acceptEvent(saleEvent({ eventId: `evt-${i}` }, { externalTransactionId: `order-${i}`, quantity: 1 }));
        }
        const processed = await Promise.all([processIntegrationEventBatch(), processIntegrationEventBatch(), processIntegrationEventBatch()]);
        assert.equal(processed.reduce((a, b) => a + b, 0), 5);
        assert.equal(await count(`SELECT COUNT(*) FROM integration_events WHERE status='processed'`), 5);
        assert.equal(await count('SELECT COUNT(*) FROM sales_transactions'), 5);
        assert.equal(await count('SELECT COUNT(*) FROM integration_event_attempts'), 5);
        assert.equal(await stock(1), 5);
    });

    test('an expired worker lease is recovered into a scheduled retry with its attempt closed', async () => {
        const queued = await acceptEvent(saleEvent());
        await pool.query(`UPDATE integration_events SET status='processing', attempt_count=1, automatic_attempt_count=1,
            lease_owner='crashed-worker', lease_expires_at=NOW() - INTERVAL '1 minute' WHERE id=$1`, [queued.id]);
        await pool.query(`INSERT INTO integration_event_attempts (integration_event_id, tenant_id, integrated_app_id, event_id,
            event_type, attempt_number, worker_id) VALUES ($1, 1, 1, 'evt-1', 'transaction.completed', 1, 'crashed-worker')`, [queued.id]);

        assert.equal(await processIntegrationEventBatch(), 0, 'the recovered event is not due until its retry time');
        const event = await one('SELECT * FROM integration_events WHERE id=$1', [queued.id]);
        assert.equal(event.status, 'pending');
        assert.equal(event.error_code, 'WORKER_LEASE_EXPIRED');
        assert.equal(event.lease_owner, null);
        assert.ok(event.next_attempt_at > new Date());
        const attempt = await one('SELECT * FROM integration_event_attempts WHERE integration_event_id=$1', [queued.id]);
        assert.equal(attempt.outcome, 'retry_scheduled');
        assert.notEqual(attempt.finished_at, null);
        assert.equal(await stock(1), 10);

        await pool.query('UPDATE integration_events SET next_attempt_at=NOW() WHERE id=$1', [queued.id]);
        assert.equal(await processIntegrationEventBatch(), 1);
        assert.equal((await one('SELECT status, attempt_count FROM integration_events WHERE id=$1', [queued.id])).attempt_count, 2);
        assert.equal(await stock(1), 8);
    });

    test('a lease that expires on the final allowed attempt ends in a terminal, retryable failure', async () => {
        const queued = await acceptEvent(saleEvent());
        const maxAttempts = (await import('../../config.js')).config.integrationMaxAttempts;
        await pool.query(`UPDATE integration_events SET status='processing', attempt_count=$2, automatic_attempt_count=$2,
            lease_owner='crashed-worker', lease_expires_at=NOW() - INTERVAL '1 minute' WHERE id=$1`, [queued.id, maxAttempts]);
        await pool.query(`INSERT INTO integration_event_attempts (integration_event_id, tenant_id, integrated_app_id, event_id,
            event_type, attempt_number, worker_id) VALUES ($1, 1, 1, 'evt-1', 'transaction.completed', $2, 'crashed-worker')`, [queued.id, maxAttempts]);

        assert.equal(await processIntegrationEventBatch(), 0);
        const event = await one('SELECT * FROM integration_events WHERE id=$1', [queued.id]);
        assert.equal(event.status, 'failed');
        assert.equal(event.failure_classification, 'action_required');
        assert.equal(event.next_attempt_at, null);
        assert.notEqual(event.processed_at, null);
        assert.equal((await one('SELECT outcome FROM integration_event_attempts WHERE integration_event_id=$1', [queued.id])).outcome, 'failed');
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='RECOVER INTEGRATION EVENT LEASE' AND record_id=$1`, [queued.id]), 1);
        assert.equal(await processIntegrationEventBatch(), 0, 'a terminal failure is not picked up again automatically');
        assert.equal(await stock(1), 10);
    });
});
