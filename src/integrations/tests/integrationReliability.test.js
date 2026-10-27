import assert from 'node:assert/strict';
import { classifyIntegrationFailure, IntegrationProcessingError, nextIntegrationRetryAt } from '../services/integrationReliability.js';
import { validateAgainstSchema, validateBusinessEvent } from '../middleware/integrationOriginMiddleware.js';
import { integrationTest as test } from './integrationTestReporter.js';

test('retry schedule uses bounded exponential stages with deterministic jitter', () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(nextIntegrationRetryAt({ attemptNumber: 1, maxAttempts: 5, now, random: () => 0.5 }).getTime(), now + 60_000);
    assert.equal(nextIntegrationRetryAt({ attemptNumber: 2, maxAttempts: 5, now, random: () => 0.5 }).getTime(), now + 300_000);
    assert.equal(nextIntegrationRetryAt({ attemptNumber: 4, maxAttempts: 5, now, random: () => 0.5 }).getTime(), now + 3_600_000);
});

test('retry policy stops at the configured maximum', () => {
    assert.equal(nextIntegrationRetryAt({ attemptNumber: 5, maxAttempts: 5 }), null);
});

test('classified permanent and action-required errors are retained', () => {
    assert.deepEqual(classifyIntegrationFailure(new IntegrationProcessingError('BAD_EVENT', 'Invalid event.', 'permanent')),
        { code: 'BAD_EVENT', summary: 'Invalid event.', classification: 'permanent' });
    assert.equal(classifyIntegrationFailure(Object.assign(new Error('duplicate'), { code: '23505' })).classification, 'action_required');
});

test('known database transport and concurrency failures are transient', () => {
    for (const code of ['40001', '40P01', '08006', 'ECONNRESET', 'ETIMEDOUT']) {
        assert.equal(classifyIntegrationFailure(Object.assign(new Error('private details'), { code })).classification, 'transient');
    }
});

test('unknown errors do not expose the original exception message', () => {
    const result = classifyIntegrationFailure(new Error('password=do-not-leak'));
    assert.equal(result.classification, 'action_required');
    assert.equal(result.summary.includes('do-not-leak'), false);
});

test('registered payload schema validation enforces required fields, types, and bounds', () => {
    const schema = { type: 'object', required: ['quantity'], additionalProperties: false,
        properties: { quantity: { type: 'integer', minimum: 1, maximum: 20 } } };
    assert.equal(validateAgainstSchema({ quantity: 5 }, schema), null);
    assert.match(validateAgainstSchema({ quantity: 0 }, schema), />= 1/);
    assert.match(validateAgainstSchema({ quantity: '5' }, schema), /integer/);
    assert.match(validateAgainstSchema({}, schema), /required/);
    assert.match(validateAgainstSchema({ quantity: 1, secret: 'x' }, schema), /additional properties/);
});

test('registered payload schema validation enforces string formats and rejects unknown keywords', () => {
    assert.equal(validateAgainstSchema('2026-10-22T10:15:30Z', { type: 'string', format: 'date-time' }), null);
    assert.match(validateAgainstSchema('2026-02-31T10:15:30Z', { type: 'string', format: 'date-time' }), /date-time/);
    assert.throws(() => validateAgainstSchema('x', { type: 'string', unknownKeyword: true }), /Registered event schema is invalid/);
});

test('sale business validation accepts completed sales and rejects other statuses', () => {
    const sale = { externalTransactionId: 'order-1', productId: 'SKU-1', quantity: 1,
        status: 'completed', saleAmount: '10.00', currency: 'PHP', externalUserId: 'employee-1' };
    assert.equal(validateBusinessEvent('transaction.completed', sale), null);
    assert.match(validateBusinessEvent('transaction.completed', { ...sale, status: 'refunded' }), /invalid business fields/);
    assert.match(validateBusinessEvent('transaction.completed', { ...sale, customerEmail: 'buyer@example.test' }), /unsupported fields/);
});
