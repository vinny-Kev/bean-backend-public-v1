// Isolated HTTP tests: in-memory sessions and a mocked database, never the real DB.
// Run: node --experimental-test-module-mocks --test session-restoration.test.mjs
import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import session from 'express-session';

let currentRow;
const query = mock.fn(async () => ({ rows: currentRow ? [currentRow] : [] }));
mock.module('./src/config.js', {
    namedExports: { config: { cookieSecure: false, cookieSameSite: 'lax' } },
});
mock.module('./src/db/pool.js', { namedExports: { pool: { query } } });
const { default: authRoutes } = await import('./src/auth/routes/auth.routes.js');

let server;
let base;
before(async () => {
    const app = express();
    app.use(express.json());
    app.use(session({
        name: 'bean.sid',
        secret: randomBytes(32).toString('hex'),
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: 'lax' },
    }));
    // Fixture creation exists ONLY in this isolated test application.
    app.post('/test-session', (req, res) => {
        req.session.userId = 1;
        req.session.authenticatedAt = req.body.authenticatedAt ?? Date.now();
        req.session.user = { roleId: 999, password: 'never-return-this-fixture' };
        res.sendStatus(204);
    });
    app.use('/auth', authRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
    currentRow = { id: 1, username: 'Test Member', email: 'fixture@example.test', role_id: 2, password_hash: 'never-return-this-fixture' };
    query.mock.resetCalls();
});
async function cookie(authenticatedAt) {
    const response = await fetch(`${base}/test-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authenticatedAt }),
    });
    return response.headers.get('set-cookie').split(';')[0];
}

test('missing session is 401 and no-store without querying users', async () => {
    const response = await fetch(`${base}/auth/me`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(query.mock.callCount(), 0);
});
test('a valid session restores only current safe identity fields', async () => {
    const response = await fetch(`${base}/auth/me`, { headers: { Cookie: await cookie() } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
        user: { id: 1, username: 'Test Member', email: 'fixture@example.test', roleId: 2 },
    });
    assert.equal(query.mock.callCount(), 1);
    assert.match(query.mock.calls[0].arguments[0], /is_disabled = false AND deleted_at IS NULL/);
    assert.deepEqual(query.mock.calls[0].arguments[1], [1]);
});
test('users without module permissions can still restore their own session', async () => {
    currentRow.role_id = null;
    const response = await fetch(`${base}/auth/me`, { headers: { Cookie: await cookie() } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.roleId, null);
});
test('expired sessions are rejected and destroyed', async () => {
    const existing = await cookie(Date.now() - 6 * 60 * 60 * 1000 - 1000);
    const response = await fetch(`${base}/auth/me`, { headers: { Cookie: existing } });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('set-cookie'), /bean\.sid=;/);
    assert.equal(query.mock.callCount(), 0);
    assert.equal((await fetch(`${base}/auth/me`, { headers: { Cookie: existing } })).status, 401);
});
test('disabled or deleted users cannot restore their session', async () => {
    currentRow = null; // The current-user query excludes disabled/deleted rows.
    const response = await fetch(`${base}/auth/me`, { headers: { Cookie: await cookie() } });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('set-cookie'), /bean\.sid=;/);
});
test('logout invalidates subsequent restoration', async () => {
    const existing = await cookie();
    assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: existing } })).status, 204);
    assert.equal((await fetch(`${base}/auth/me`, { headers: { Cookie: existing } })).status, 401);
});
