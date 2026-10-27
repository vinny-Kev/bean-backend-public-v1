import assert from 'node:assert/strict';
import { sanitizeAuditData } from '../services/integrationAuditHistoryService.js';
import { ANALYTICS_SCHEMA_VERSION, buildIntegrationAnalytics } from '../services/integrationAnalyticsService.js';
import { integrationTest as test } from './integrationTestReporter.js';

test('audit data is reduced to an allowlist of safe scalar fields', () => {
    assert.deepEqual(sanitizeAuditData({ tenantId: 1, status: 'active', credential: 'secret', credentialHash: '$2b$...',
        payload: { saleAmount: '10' }, enabledEventTypes: ['transaction.completed'], reason: 'x'.repeat(600) }),
    { tenantId: 1, status: 'active', enabledEventTypes: ['transaction.completed'], reason: 'x'.repeat(500) });
    assert.equal(sanitizeAuditData({ password: 'p', token: 't' }), null);
    assert.equal(sanitizeAuditData(null), null);
    assert.equal(sanitizeAuditData([{ status: 'x' }]), null);
    assert.deepEqual(sanitizeAuditData({ status: { nested: true }, enabledEventTypes: [1, 2] }), null);
});

const empty = { eventRows: [], latencyRow: undefined, failureRows: [], deliveryRows: [], salesRows: [], commissionRows: [], adjustmentRows: [] };
const window = { integrationId: 7, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z') };

test('analytics contract is zero-filled and explicit when there is no activity', () => {
    const result = buildIntegrationAnalytics({ ...window, ...empty });
    assert.equal(result.schemaVersion, ANALYTICS_SCHEMA_VERSION);
    assert.deepEqual(result.window, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' });
    assert.deepEqual(result.events, { total: 0, byStatus: { pending: 0, processing: 0, processed: 0, failed: 0 },
        byType: [], successRate: null, topFailureCodes: [] });
    assert.deepEqual(result.deliveries, { accepted: 0, duplicate: 0, invalid: 0, ingestionFailed: 0 });
    assert.deepEqual(result.processingLatencyMs, { samples: 0, average: null, p50: null, p95: null, max: null });
    assert.deepEqual(result.sales, { available: true, byCurrency: [] });
    assert.deepEqual(result.inventoryAdjustments, { available: true, total: 0, byAdjustment: { increase: 0, decrease: 0, set: 0 } });
    assert.ok(result.limitations.length > 0);
});

test('analytics aggregation groups by type and status and keeps money as decimal strings', () => {
    const result = buildIntegrationAnalytics({ ...window, ...empty,
        eventRows: [
            { event_type: 'transaction.completed', status: 'processed', count: 3 },
            { event_type: 'transaction.completed', status: 'failed', count: 1 },
            { event_type: 'inventory.adjusted', status: 'pending', count: 2 },
        ],
        latencyRow: { samples: 3, average: '1500.4', p50: '1200', p95: '2999.6', max: '3000' },
        failureRows: [{ error_code: 'INVENTORY_UNAVAILABLE', count: 1 }],
        deliveryRows: [{ outcome: 'accepted', count: 6 }, { outcome: 'duplicate', count: 2 }, { outcome: 'ingestion_failed', count: 1 }],
        salesRows: [{ currency: 'PHP', transactions: 3, quantity: '7', gross_amount: '3897.00' }],
        commissionRows: [{ currency: 'PHP', status: 'pending', count: 3, amount: '194.85' }],
        adjustmentRows: [{ adjustment: 'increase', count: 2 }, { adjustment: 'bogus', count: 9 }],
    });
    assert.deepEqual(result.events.byStatus, { pending: 2, processing: 0, processed: 3, failed: 1 });
    assert.equal(result.events.total, 6);
    assert.equal(result.events.successRate, 0.75);
    assert.deepEqual(result.events.byType.map((t) => [t.eventType, t.total, t.processed, t.failed, t.pending]),
        [['transaction.completed', 4, 3, 1, 0], ['inventory.adjusted', 2, 0, 0, 2]]);
    assert.deepEqual(result.deliveries, { accepted: 6, duplicate: 2, invalid: 0, ingestionFailed: 1 });
    assert.deepEqual(result.processingLatencyMs, { samples: 3, average: 1500, p50: 1200, p95: 3000, max: 3000 });
    assert.deepEqual(result.sales.byCurrency, [{ currency: 'PHP', transactions: 3, quantity: 7, grossAmount: '3897.00' }]);
    assert.deepEqual(result.commissions.byCurrency, [{ currency: 'PHP', status: 'pending', count: 3, amount: '194.85' }]);
    assert.deepEqual(result.inventoryAdjustments, { available: true, total: 2, byAdjustment: { increase: 2, decrease: 0, set: 0 } });
});
