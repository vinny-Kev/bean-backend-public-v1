import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareToPattern, inRangeOfLength, isPlainObject, parsePositiveId, parseTimestampRange } from './validations.js';

test('parseTimestampRange validates bounds, applies defaults, and caps the window', () => {
    const now = new Date('2026-10-27T00:00:00Z');
    assert.deepEqual(parseTimestampRange({}), { from: null, to: null, error: null });
    assert.deepEqual(parseTimestampRange({ from: 'nope' }), { error: 'from must be a valid timestamp.' });
    assert.deepEqual(parseTimestampRange({ to: ['2026-01-01'] }), { error: 'to must be a valid timestamp.' });
    assert.deepEqual(parseTimestampRange({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }), { error: 'from must not be later than to.' });

    const defaulted = parseTimestampRange({}, { defaultDays: 30, now });
    assert.equal(defaulted.to.toISOString(), '2026-10-27T00:00:00.000Z');
    assert.equal(defaulted.from.toISOString(), '2026-09-27T00:00:00.000Z');
    assert.equal(parseTimestampRange({ to: '2026-10-10T00:00:00Z' }, { defaultDays: 1, now }).from.toISOString(), '2026-10-09T00:00:00.000Z');
    assert.match(parseTimestampRange({ from: '2024-01-01T00:00:00Z' }, { defaultDays: 30, maxDays: 366, now }).error, /366 days/);
});

test('integration envelope and payload patterns', () => {
    assert.equal(compareToPattern('storefront-event-9081', 'event_id'), true);
    assert.equal(compareToPattern('a:b.c_d-e', 'event_id'), true);
    assert.equal(compareToPattern('has space', 'event_id'), false);
    assert.equal(compareToPattern('x'.repeat(256), 'event_id'), false);

    assert.equal(compareToPattern('transaction.completed', 'event_type'), true);
    assert.equal(compareToPattern('Transaction.completed', 'event_type'), false);
    assert.equal(compareToPattern(`a${'b'.repeat(99)}`, 'event_type'), true, '100 characters fits integration_events.event_type');
    assert.equal(compareToPattern(`a${'b'.repeat(100)}`, 'event_type'), false);

    assert.equal(compareToPattern('BEAN-42', 'product_id'), true);
    assert.equal(compareToPattern('bean 42', 'product_id'), false);

    for (const ok of ['0', '10', '1299.00', '0.5', '9999999999.99']) assert.equal(compareToPattern(ok, 'money_amount'), true, ok);
    for (const bad of ['01', '1.234', '-1', '1e3', '12345678901']) assert.equal(compareToPattern(bad, 'money_amount'), false, bad);

    assert.equal(compareToPattern('PHP', 'currency_code'), true);
    assert.equal(compareToPattern('php', 'currency_code'), false);
});

test('tenant slug pattern', () => {
    for (const ok of ['acme', 'new-org', 'a1-b2-c3']) assert.equal(compareToPattern(ok, 'slug'), true, ok);
    for (const bad of ['Acme', '-acme', 'acme-', 'a--b', 'a b', 'a_b']) assert.equal(compareToPattern(bad, 'slug'), false, bad);
    assert.equal(compareToPattern('anything', 'unknown_pattern'), false);
});

test('parsePositiveId accepts only safe positive integer strings', () => {
    assert.equal(parsePositiveId('42'), 42);
    for (const bad of ['0', '-1', '01', '1.5', ' 1', '9007199254740993', 42, undefined, null]) {
        assert.equal(parsePositiveId(bad), null, String(bad));
    }
});

test('isPlainObject and inRangeOfLength', () => {
    assert.equal(isPlainObject({}), true);
    for (const value of [null, [], 'x', 1, undefined]) assert.equal(isPlainObject(value), false);
    assert.equal(inRangeOfLength('abc', 1, 3), true);
    assert.equal(inRangeOfLength('', 1, 3), false);
});
