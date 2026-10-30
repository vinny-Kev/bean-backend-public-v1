// Audit behavior of login and logout against a fake database (no PostgreSQL connection).
// Signup, verification and the other identity flows are covered against PostgreSQL in
// src/identity/identity.db.test.js.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import bcrypt from 'bcrypt';
import express from 'express';

process.env.DATABASE_URL = '';
process.env.SESSION_SECRET ||= 'test-session-secret-0123456789abcdefghij';
process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'bean_test';
process.env.DB_USER ||= 'test';
process.env.DB_PASSWORD ||= 'test';

const { pool } = await import('../db/pool.js');
const { default: authRoutes } = await import('./routes/auth.routes.js');
const { errorHandler, requestContext } = await import('../middleware/errorMiddleware.js');

const passwordHash = await bcrypt.hash('Passw0rd!x', 4);
let failAudit;
let sessionUserId;
let queries;

const query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO audit_logs') && failAudit) throw new Error('audit write failed');
    if (sql.includes('password_hash') && sql.includes('FROM users')) {
        return { rows: params[0] === 'known@example.test'
            ? [{ id: 11, email: 'known@example.test', username: 'known', full_name: 'Known User', email_verified_at: new Date(), password_hash: passwordHash, role_id: 1 }] : [] };
    }
    if (sql.includes('FROM trusted_devices')) return { rows: [{ total: 0, known: 0 }] };
    return { rows: [] };
};
pool.query = query;
pool.connect = async () => ({ query, release() {} });

let server;
let base;
before(async () => {
    const app = express();
    app.use(requestContext);
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = {
            userId: sessionUserId,
            regenerate(done) { done(); },
            save(done) { done(); },
            destroy(done) { done(); },
        };
        next();
    });
    app.use('/auth', authRoutes);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { failAudit = false; sessionUserId = undefined; queries = []; });

const post = (path, body) => fetch(`${base}/auth${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const audits = () => queries.filter(({ sql }) => sql.includes('INSERT INTO audit_logs'));
// The login limiter counts failures (3 per window per IP), so the success case runs before them.
test('successful login records LOGIN_SUCCESS', async () => {
    const response = await post('/login', { email: 'known@example.test', password: 'Passw0rd!x' });
    assert.equal(response.status, 200);
    assert.equal(audits()[0].params[2], 'LOGIN_SUCCESS');
});

test('failed login for a real account is audited without the submitted credentials', async () => {
    const response = await post('/login', { email: 'known@example.test', password: 'Wrong-pass1!' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: 'Invalid email or password.' });
    const [audit] = audits();
    assert.equal(audit.params[0], 11);
    assert.equal(audit.params[2], 'LOGIN_FAILURE');
    assert.equal(JSON.stringify(audit.params).includes('Wrong-pass1'), false);
    assert.equal(JSON.stringify(audit.params).includes('known@example.test'), false);
});

test('failed login for an unknown account gives the same response and writes no audit row', async () => {
    const response = await post('/login', { email: 'nobody@example.test', password: 'Wrong-pass1!' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: 'Invalid email or password.' });
    assert.equal(audits().length, 0);
});

test('a failing audit write does not change the failed-login response', async () => {
    failAudit = true;
    const response = await post('/login', { email: 'known@example.test', password: 'Wrong-pass1!' });
    assert.equal(response.status, 401);
});

test('logout records LOGOUT for a signed-in user and still succeeds if the audit write fails', async () => {
    sessionUserId = 11;
    assert.equal((await post('/logout', {})).status, 204);
    assert.equal(audits()[0].params[2], 'LOGOUT');
    queries = [];
    failAudit = true;
    assert.equal((await post('/logout', {})).status, 204);
});

test('logout without a session is a no-op that writes no audit row', async () => {
    assert.equal((await post('/logout', {})).status, 204);
    assert.equal(audits().length, 0);
});
