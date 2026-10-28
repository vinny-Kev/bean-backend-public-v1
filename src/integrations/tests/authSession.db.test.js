import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import bcrypt from 'bcrypt';
import { pool } from '../../db/pool.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';
import { count, one, resetSchema, seedFixtures, testDatabaseSkipReason } from './support/testDatabase.js';
import { startTestServer, trustedOrigin } from './support/testServer.js';
import { signupUserService } from '../../auth/services/signupUserService.js';

const skip = testDatabaseSkipReason || (!trustedOrigin && 'APP_ORIGINS must contain at least one origin for the CSRF origin check.');
if (skip) reportBlockedIntegrationCheck('PostgreSQL authentication and session tests', 'a local *_test database and APP_ORIGINS', `skipped: ${skip}`);

let client;
let close;
const password = 'Str0ng!Pass';

// Creates an account directly; signup itself is covered above and is rate limited to 5 per hour.
const createAccount = async (username, email) => pool.query(
    'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)', [username, email, await bcrypt.hash(password, 4)]);

describe('registration, login, session, and logout with real sessions against PostgreSQL', { skip, concurrency: false }, () => {
    before(async () => {
        await resetSchema();
        ({ client, close } = await startTestServer({ realSessions: true }));
    });
    after(async () => {
        await close?.();
        await pool.end();
    });
    beforeEach(async () => {
        await seedFixtures();
        await pool.query('TRUNCATE session');
    });

    test('signup hashes the password, normalizes email, and rejects duplicates and invalid input', async () => {
        const api = client();
        const created = await api('POST', '/auth/signup', { body: { username: 'newuser', email: 'New.User@Example.test', password } });
        assert.equal(created.status, 201);
        assert.equal(created.body.responseData.email, 'new.user@example.test');
        assert.equal(JSON.stringify(created.body).includes('password'), false);
        const stored = await one(`SELECT password_hash, role_id FROM users WHERE username='newuser'`);
        assert.notEqual(stored.password_hash, password);
        assert.equal(await bcrypt.compare(password, stored.password_hash), true);
        assert.equal(stored.role_id, null, 'new accounts get no role, so no account-level permissions');

        assert.equal((await api('POST', '/auth/signup', { body: { username: 'other', email: 'NEW.user@example.test', password } })).status, 409);
        assert.equal((await api('POST', '/auth/signup', { body: { username: 'x', email: 'bad', password: 'weak' } })).status, 400);
        assert.equal((await api('POST', '/auth/signup', { body: { username: 'nocsrf', email: 'n@example.test', password }, origin: null })).status, 403,
            'unsafe requests without a trusted Origin are rejected');
    });

    test('email and username are unique regardless of case, even when signups race past the pre-check', async () => {
        // Both requests have already passed validateSignupData's existence check, which is the race window.
        const signup = (username, email) => new Promise((resolve, reject) => {
            const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
            signupUserService({ body: { username, email, password } }, res, reject);
        });
        const raced = await Promise.all([signup('RaceUser', 'race1@example.test'), signup('raceuser', 'race2@example.test')]);
        assert.deepEqual(raced.map((r) => r.status).sort(), [201, 409]);
        assert.equal(await count(`SELECT COUNT(*) FROM users WHERE LOWER(username)='raceuser'`), 1);
        assert.equal(JSON.stringify(raced).includes('users_'), false, 'constraint names are not exposed');

        await assert.rejects(createAccount('AcmeOwner', 'someone@example.test'), { constraint: 'users_username_lower_key' });
        await assert.rejects(createAccount('someone', 'Owner@Acme.TEST'), { constraint: 'users_email_lower_key' });
    });

    test('login and /auth/me return only safe identity fields', async () => {
        const api = client();
        await createAccount('safeuser', 'safe@example.test');
        const login = await api('POST', '/auth/login', { body: { email: 'SAFE@example.test', password } });
        assert.equal(login.status, 200);
        assert.deepEqual(Object.keys(login.body).sort(), ['message', 'user']);
        assert.deepEqual(Object.keys(login.body.user).sort(), ['email', 'id', 'roleId', 'username']);
        const me = await api('GET', '/auth/me');
        assert.deepEqual(Object.keys(me.body.user).sort(), ['email', 'id', 'permissions', 'roleId', 'username']);
        const sid = (await one('SELECT sid FROM session LIMIT 1')).sid;
        for (const body of [login.body, me.body]) {
            assert.equal(/password|hash|sid|session|cookie/i.test(JSON.stringify(body)), false);
            assert.equal(JSON.stringify(body).includes(sid), false);
        }
    });

    test('login creates an HttpOnly session, /auth/me reflects the account, and logout ends it', async () => {
        const api = client();
        await api('POST', '/auth/signup', { body: { username: 'loginuser', email: 'login@example.test', password } });
        assert.equal((await api('GET', '/auth/me')).status, 401);

        const wrong = await api('POST', '/auth/login', { body: { email: 'login@example.test', password: 'Wrong!Pass1' } });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.body.message, 'Invalid email or password.');
        assert.equal((await api('POST', '/auth/login', { body: { email: 'nobody@example.test', password } })).body.message,
            'Invalid email or password.', 'unknown accounts get the same message');

        const login = await api('POST', '/auth/login', { body: { email: 'LOGIN@example.test', password } });
        assert.equal(login.status, 200);
        const cookie = login.headers.getSetCookie().find((header) => header.startsWith('bean.sid='));
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=/i);
        assert.equal(JSON.stringify(login.body).includes('password'), false);

        const me = await api('GET', '/auth/me');
        assert.equal(me.status, 200);
        assert.equal(me.body.user.username, 'loginuser');
        assert.deepEqual(me.body.user.permissions, []);
        assert.equal(me.headers.get('cache-control'), 'no-store');
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='LOGIN_SUCCESS'`), 1);

        const relogin = await api('POST', '/auth/login', { body: { email: 'login@example.test', password } });
        assert.notEqual(relogin.headers.getSetCookie().find((h) => h.startsWith('bean.sid=')), cookie, 'login issues a new session ID');

        assert.equal((await api('POST', '/auth/logout')).status, 204);
        assert.equal((await api('GET', '/auth/me')).status, 401);
        assert.equal(await count('SELECT COUNT(*) FROM session'), 0, 'the server-side session is destroyed');
    });

    test('a disabled account loses its existing session immediately', async () => {
        const api = client();
        await createAccount('soontobe', 'disabled@example.test');
        assert.equal((await api('POST', '/auth/login', { body: { email: 'disabled@example.test', password } })).status, 200);
        assert.equal((await api('GET', '/auth/me')).status, 200);
        await pool.query(`UPDATE users SET is_disabled=true WHERE username='soontobe'`);
        assert.equal((await api('GET', '/auth/me')).status, 401);
        // A fresh login attempt would also fail (login filters is_disabled), but this file stays
        // under the real limiter's 3 failed logins per 15 minutes.
    });

    test('a new account cannot create a tenant until granted TENANTS_CREATE, then becomes the owner', async () => {
        const api = client();
        await createAccount('founder2', 'founder2@example.test');
        assert.equal((await api('POST', '/auth/login', { body: { email: 'founder2@example.test', password } })).status, 200);
        const denied = await api('POST', '/tenants', { body: { name: 'Founder Org', slug: 'founder-org' } });
        assert.equal(denied.status, 403);

        await pool.query(`UPDATE users SET role_id=(SELECT id FROM roles WHERE name='dev') WHERE username='founder2'`);
        assert.ok((await api('GET', '/auth/me')).body.user.permissions.includes('TENANTS_CREATE'), 'permissions are read live, not cached');
        assert.equal((await api('POST', '/tenants', { body: { name: 'Founder Org', slug: 'founder-org' }, origin: 'https://evil.example' })).status, 403,
            'a foreign Origin is rejected');
        const created = await api('POST', '/tenants', { body: { name: 'Founder Org', slug: 'founder-org' } });
        assert.equal(created.status, 201);
        assert.equal(created.body.data.membershipRole, 'owner');
        const tenants = await api('GET', '/tenants');
        assert.deepEqual(tenants.body.data.map((t) => t.slug), ['founder-org']);
        assert.equal((await api('GET', `/tenants/${created.body.data.id}/members`)).body.data[0].username, 'founder2');
        assert.equal((await api('GET', '/tenants/1')).status, 404, 'other tenants stay invisible');
    });
});
