import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';

process.env.DATABASE_URL = '';
process.env.SESSION_SECRET ||= 'test-session-secret-0123456789abcdefghij';
process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'bean_test';
process.env.DB_USER ||= 'test';
process.env.DB_PASSWORD ||= 'test';

const { checkDatabase, createHealthRouter } = await import('./routes/health.routes.js');

let databaseUp = true;
let checks = 0;
let server;
let base;

before(async () => {
    const app = express();
    app.use('/health', createHealthRouter({ check: async () => { checks += 1; return databaseUp; } }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

test('liveness is public, minimal, uncached and never queries the database', async () => {
    databaseUp = false;
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(checks, 0);
});

test('readiness reports 200 when the database answers', async () => {
    databaseUp = true;
    const response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', checks: { database: 'ok' } });
});

test('readiness reports 503 without leaking details when the database is down', async () => {
    databaseUp = false;
    const response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'unavailable', checks: { database: 'unavailable' } });
});

test('checkDatabase maps query failures and hangs to false, success to true', async () => {
    assert.equal(await checkDatabase({ query: async () => ({ rows: [] }) }), true);
    assert.equal(await checkDatabase({ query: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); } }), false);
    const started = Date.now();
    assert.equal(await checkDatabase({ query: () => new Promise(() => {}) }), false);
    assert.ok(Date.now() - started < 4000, 'a hung database must not hang the probe');
});

test('health routes do not write audit entries (no audit imports)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./routes/health.routes.js', import.meta.url), 'utf8');
    assert.equal(/^import .*audit/im.test(source), false);
});
