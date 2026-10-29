// Identity, onboarding, invitation, ownership and RBAC behavior against PostgreSQL with real sessions.
// Runs only against a scratch *_test database (npm run test:db). Mail goes to the in-memory capture
// transport; nothing is sent anywhere.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import bcrypt from 'bcrypt';
import { pool } from '../db/pool.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from '../integrations/tests/integrationTestReporter.js';
import { count, one, resetSchema, seedFixtures, testDatabaseSkipReason } from '../integrations/tests/support/testDatabase.js';
import { startTestServer, trustedOrigin } from '../integrations/tests/support/testServer.js';
import { capturedMessages, clearCapturedMessages } from '../mail/mailer.js';
import * as limiters from '../middleware/auth/rateLimitMiddleware.js';
import { tenantCreationLimiter } from '../tenants/routes/tenant.routes.js';

const skip = testDatabaseSkipReason || (!trustedOrigin && 'APP_ORIGINS must contain at least one origin for the CSRF origin check.');
if (skip) reportBlockedIntegrationCheck('PostgreSQL identity tests', 'a *_test database and APP_ORIGINS', `skipped: ${skip}`);

const password = 'Str0ng!Pass';
let client;
let close;

const resetLimiters = async () => {
    for (const limiter of Object.values(limiters)) {
        for (const key of ['127.0.0.1', '::ffff:127.0.0.1']) await limiter.resetKey?.(key);
    }
    // Per-user budgets are keyed by user id, and ids restart with every fixture reset.
    for (let id = 1; id <= 140; id += 1) await tenantCreationLimiter.resetKey(`user:${id}`);
};
const mailTo = (address) => capturedMessages().filter((m) => m.to === address.toLowerCase());
const lastCode = (address) => /Your code is (\d{6})/.exec(mailTo(address).at(-1)?.text ?? '')?.[1];
const lastToken = (address) => /#token=([\w-]+)/.exec(mailTo(address).at(-1)?.text ?? '')?.[1];

// Verified account created directly (signup is rate limited and covered by its own tests).
const account = async (username, email, { role = 'standard', verified = true } = {}) => (await pool.query(
    `INSERT INTO users (username, email, password_hash, full_name, email_verified_at, role_id)
     VALUES ($1,$2,$3,$4, ${verified ? 'now()' : 'NULL'}, (SELECT id FROM roles WHERE name=$5)) RETURNING id`,
    [username, email, await bcrypt.hash(password, 4), `${username} Person`, role],
)).rows[0].id;
const login = (api, email, pass = password) => api('POST', '/auth/login', { body: { email, password: pass } });
const signedIn = async (username, email, options) => {
    const id = await account(username, email, options);
    const api = client();
    assert.equal((await login(api, email)).status, 200);
    return { id: String(id), api, email };
};
const createTenant = async (api, slug, key) => {
    const response = await api('POST', '/tenants', { body: { name: `Org ${slug}`, slug }, headers: key ? { 'Idempotency-Key': key } : undefined });
    return response;
};

describe('identity, onboarding, invitations and RBAC against PostgreSQL', { skip, concurrency: false }, () => {
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
        clearCapturedMessages();
        await resetLimiters();
    });

    // ---- registration and email verification -----------------------------------------------------

    test('signup emails a one-time code stored only as a hash; verification activates the account and grants the standard role', async () => {
        const api = client();
        const signup = await api('POST', '/auth/signup', { body: { fullName: 'Ada Lovelace', username: 'adal', email: 'Ada@Example.test', password } });
        assert.equal(signup.status, 202);
        const code = lastCode('ada@example.test');
        assert.match(code, /^\d{6}$/);
        assert.equal(JSON.stringify(signup.body).includes(code), false, 'the code is never in the API response');
        const stored = await one(`SELECT secret_hash, purpose, email FROM auth_challenges`);
        assert.notEqual(stored.secret_hash, code);
        assert.equal(stored.purpose, 'verify_email');
        assert.equal(stored.email, 'ada@example.test');
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE new_data::text LIKE '%${code}%'`), 0, 'codes never reach the audit trail');

        const blocked = await login(api, 'ada@example.test');
        assert.equal(blocked.status, 403);
        assert.equal(blocked.body.error.code, 'EMAIL_NOT_VERIFIED');
        assert.equal(blocked.headers.getSetCookie().some((h) => h.startsWith('bean.sid=')), false, 'no session before verification');

        assert.equal((await api('POST', '/auth/verify-email', { body: { email: 'ada@example.test', code: code === '000000' ? '111111' : '000000' } })).status, 400);
        const verified = await api('POST', '/auth/verify-email', { body: { email: 'ADA@example.test', code } });
        assert.equal(verified.status, 200);
        const user = await one(`SELECT role_id, email_verified_at FROM users WHERE username='adal'`);
        assert.ok(user.email_verified_at);
        assert.equal(user.role_id, (await one(`SELECT id FROM roles WHERE name='standard'`)).id);

        assert.equal((await api('POST', '/auth/verify-email', { body: { email: 'ada@example.test', code } })).status, 400, 'a used code cannot be replayed');
        const ok = await login(api, 'ada@example.test');
        assert.equal(ok.status, 200);
        assert.deepEqual((await api('GET', '/auth/me')).body.user.permissions, ['TENANTS_CREATE']);
        assert.ok(await count(`SELECT COUNT(*) FROM audit_logs WHERE action IN ('SIGNUP','SIGNUP_VERIFIED')`) >= 2);
    });

    test('OTP brute force locks the challenge; a resend is rate limited, then issues a fresh working code', async () => {
        const api = client();
        await api('POST', '/auth/signup', { body: { fullName: 'Brute Force', username: 'brute', email: 'brute@example.test', password } });
        const code = lastCode('brute@example.test');
        const wrong = code === '123456' ? '654321' : '123456';
        const results = [];
        for (let i = 0; i < 5; i += 1) results.push((await api('POST', '/auth/verify-email', { body: { email: 'brute@example.test', code: wrong } })).body.error.code);
        assert.deepEqual(results.slice(0, 4), ['OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID']);
        assert.equal(results[4], 'OTP_LOCKED');
        const correctButLocked = await api('POST', '/auth/verify-email', { body: { email: 'brute@example.test', code } });
        assert.equal(correctButLocked.status, 400);
        assert.equal(correctButLocked.body.error.code, 'OTP_LOCKED', 'the right code no longer works once attempts are exhausted');

        const before = mailTo('brute@example.test').length;
        assert.equal((await api('POST', '/auth/verify-email/resend', { body: { email: 'brute@example.test' } })).status, 202);
        assert.equal(mailTo('brute@example.test').length, before, 'resend inside the 60 s cooldown sends nothing');
        await pool.query(`UPDATE auth_challenges SET created_at = now() - interval '2 minutes'`);
        assert.equal((await api('POST', '/auth/verify-email/resend', { body: { email: 'brute@example.test' } })).status, 202);
        assert.equal(mailTo('brute@example.test').length, before + 1);
        assert.equal(await count(`SELECT COUNT(*) FROM auth_challenges WHERE superseded_at IS NULL AND consumed_at IS NULL`), 1, 'the previous challenge was superseded');
        assert.equal((await api('POST', '/auth/verify-email', { body: { email: 'brute@example.test', code: lastCode('brute@example.test') } })).status, 200);
    });

    test('expired codes are rejected, and resend for unknown or verified addresses reveals nothing', async () => {
        const api = client();
        await api('POST', '/auth/signup', { body: { fullName: 'Slow Poke', username: 'slowpoke', email: 'slow@example.test', password } });
        const code = lastCode('slow@example.test');
        await pool.query(`UPDATE auth_challenges SET expires_at = now() - interval '1 minute'`);
        const expired = await api('POST', '/auth/verify-email', { body: { email: 'slow@example.test', code } });
        assert.equal(expired.body.error.code, 'OTP_EXPIRED');

        const messages = capturedMessages().length;
        await account('already', 'already@example.test');
        for (const email of ['nobody@example.test', 'already@example.test']) {
            const response = await api('POST', '/auth/verify-email/resend', { body: { email } });
            assert.equal(response.status, 202);
            assert.equal(response.body.status, 'verification_sent');
        }
        assert.equal(capturedMessages().length, messages, 'no mail for unknown or already-verified addresses');
    });

    test('duplicate registration: same response for existing emails, one code per cooldown, username conflicts explicit', async () => {
        const api = client();
        const body = { fullName: 'Dup Licate', username: 'duplicate', email: 'dup@example.test', password };
        const first = await api('POST', '/auth/signup', { body });
        const second = await api('POST', '/auth/signup', { body: { ...body, username: 'duplicate2', password: 'Another!Pass9' } });
        assert.equal(first.status, 202);
        assert.equal(second.status, 202);
        assert.deepEqual(first.body, second.body, 'identical responses');
        assert.equal(mailTo('dup@example.test').length, 1, 'no second code inside the cooldown');
        assert.equal(await count(`SELECT COUNT(*) FROM users WHERE lower(email)='dup@example.test'`), 1);
        const original = await one(`SELECT password_hash FROM users WHERE lower(email)='dup@example.test'`);
        assert.equal(await bcrypt.compare(password, original.password_hash), true, 'a second registration never replaces the original password');

        await account('verifiedperson', 'verified@example.test');
        const existing = await api('POST', '/auth/signup', { body: { ...body, username: 'another', email: 'verified@example.test' } });
        assert.equal(existing.status, 202);
        assert.equal(mailTo('verified@example.test').at(-1).template, 'accountExists');
        assert.equal(await count(`SELECT COUNT(*) FROM users WHERE lower(email)='verified@example.test'`), 1);

        const clash = await api('POST', '/auth/signup', { body: { ...body, email: 'fresh@example.test' } });
        assert.equal(clash.status, 409);
        assert.equal(clash.body.error.code, 'USERNAME_TAKEN');
    });

    test('concurrent registrations of one address create one account and send one code', async () => {
        const send = () => client()('POST', '/auth/signup', { body: { fullName: 'Race Condition', username: 'racer', email: 'racer@example.test', password } });
        const results = await Promise.all([send(), send(), send()]);
        assert.equal(results.filter((r) => r.status === 202).length >= 1, true);
        assert.ok(results.every((r) => [202, 409].includes(r.status)));
        assert.equal(await count(`SELECT COUNT(*) FROM users WHERE lower(email)='racer@example.test'`), 1);
        assert.equal(mailTo('racer@example.test').length, 1);
    });

    // ---- sign-in step-up ----------------------------------------------------------------------------

    test('a new device must pass an emailed code; the first device is trusted silently; codes are single use', async () => {
        await account('devuser', 'dev@example.test');
        const laptop = client();
        const first = await login(laptop, 'dev@example.test');
        assert.equal(first.status, 200);
        assert.ok(first.headers.getSetCookie().some((h) => h.startsWith('bean.dev.') && /HttpOnly/i.test(h)), 'device cookie issued');
        assert.equal(mailTo('dev@example.test').length, 0, 'no code for the first device');
        assert.equal((await login(laptop, 'dev@example.test')).status, 200, 'the same device signs in again without a code');

        const phone = client();
        const challenge = await login(phone, 'dev@example.test');
        assert.equal(challenge.status, 202);
        assert.equal(challenge.headers.getSetCookie().some((h) => h.startsWith('bean.sid=')), false, 'no session until the code is entered');
        assert.equal((await phone('GET', '/auth/me')).status, 401);
        const code = lastCode('dev@example.test');
        assert.equal(JSON.stringify(challenge.body).includes(code), false);

        const wrong = await phone('POST', '/auth/login/verify', { body: { challengeId: challenge.body.challengeId, code: code === '000000' ? '111111' : '000000' } });
        assert.equal(wrong.status, 400);
        const done = await phone('POST', '/auth/login/verify', { body: { challengeId: challenge.body.challengeId, code } });
        assert.equal(done.status, 200);
        assert.ok(done.headers.getSetCookie().some((h) => h.startsWith('bean.sid=')));
        assert.equal((await phone('GET', '/auth/me')).status, 200);
        const replay = await client()('POST', '/auth/login/verify', { body: { challengeId: challenge.body.challengeId, code } });
        assert.equal(replay.status, 400, 'a consumed code cannot be reused');
        assert.equal(await count(`SELECT COUNT(*) FROM trusted_devices`), 2);
        assert.ok(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='LOGIN_STEP_UP_REQUIRED'`) === 1);
    });

    // ---- password recovery ------------------------------------------------------------------------

    test('password reset: generic request, hashed single-use expiring token, sessions revoked, notice sent', async () => {
        const { api: session } = await signedIn('resetme', 'reset@example.test');
        const stranger = client();
        const before = capturedMessages().length;
        const unknown = await stranger('POST', '/auth/password/forgot', { body: { email: 'ghost@example.test' } });
        const known = await stranger('POST', '/auth/password/forgot', { body: { email: 'RESET@example.test' } });
        assert.equal(unknown.status, 202);
        assert.deepEqual(unknown.body, known.body, 'same answer for known and unknown addresses');
        assert.equal(capturedMessages().length, before + 1, 'only the real account is emailed');
        const token = lastToken('reset@example.test');
        assert.ok(token);
        assert.match(mailTo('reset@example.test').at(-1).text, /\/reset-password#token=/, 'the token is in the URL fragment');
        const row = await one(`SELECT secret_hash FROM auth_challenges WHERE purpose='password_reset'`);
        assert.notEqual(row.secret_hash, token);

        assert.equal((await stranger('POST', '/auth/password/reset', { body: { token, newPassword: 'weak' } })).status, 400);
        const done = await stranger('POST', '/auth/password/reset', { body: { token, newPassword: 'Brand!New9pw' } });
        assert.equal(done.status, 200);
        assert.equal((await session('GET', '/auth/me')).status, 401, 'existing sessions are revoked');
        assert.equal(mailTo('reset@example.test').at(-1).template, 'passwordChanged');
        assert.equal((await stranger('POST', '/auth/password/reset', { body: { token, newPassword: 'Another!New9pw' } })).status, 400, 'tokens are single use');
        assert.equal((await login(client(), 'reset@example.test', 'Brand!New9pw')).status, 200);
        assert.equal((await login(client(), 'reset@example.test', password)).status, 401);
        assert.equal((await one(`SELECT password_changed_at FROM users WHERE username='resetme'`)).password_changed_at !== null, true);
    });

    test('an expired reset token fails, and a reset also verifies a still-unverified address', async () => {
        await account('unverif', 'unverif@example.test', { role: null, verified: false });
        const api = client();
        await api('POST', '/auth/password/forgot', { body: { email: 'unverif@example.test' } });
        const token = lastToken('unverif@example.test');
        await pool.query(`UPDATE auth_challenges SET expires_at = now() - interval '1 minute'`);
        assert.equal((await api('POST', '/auth/password/reset', { body: { token, newPassword: 'Brand!New9pw' } })).body.error.code, 'RESET_TOKEN_INVALID');
        await pool.query(`UPDATE auth_challenges SET created_at = now() - interval '5 minutes'`);
        await api('POST', '/auth/password/forgot', { body: { email: 'unverif@example.test' } });
        assert.equal((await api('POST', '/auth/password/reset', { body: { token: lastToken('unverif@example.test'), newPassword: 'Brand!New9pw' } })).status, 200);
        const user = await one(`SELECT email_verified_at, role_id FROM users WHERE username='unverif'`);
        assert.ok(user.email_verified_at);
        assert.ok(user.role_id, 'verification through reset grants the standard role');
    });

    // ---- email change -----------------------------------------------------------------------------

    test('email change needs the password, proof of the new address, revokes other sessions and notifies the old address', async () => {
        const { api, email } = await signedIn('changer', 'old@example.test');
        const other = client();
        await login(other, email);
        await account('taken', 'taken@example.test');

        assert.equal((await api('POST', '/auth/email-change/request', { body: { newEmail: 'new@example.test', currentPassword: 'Wrong!Pass1' } })).status, 403);
        const toTaken = await api('POST', '/auth/email-change/request', { body: { newEmail: 'taken@example.test', currentPassword: password } });
        assert.equal(toTaken.status, 202, 'same answer when the address is already registered');
        assert.equal(mailTo('taken@example.test').length, 0);

        const requested = await api('POST', '/auth/email-change/request', { body: { newEmail: 'NEW@example.test', currentPassword: password } });
        assert.equal(requested.status, 202);
        assert.equal(mailTo('old@example.test').at(-1).template, 'emailChangeNotice');
        const code = lastCode('new@example.test');
        assert.ok(code);
        assert.equal((await one(`SELECT email FROM users WHERE username='changer'`)).email, 'old@example.test', 'nothing changes before confirmation');
        assert.equal((await api('POST', '/auth/email-change/confirm', { body: { code: code === '000000' ? '111111' : '000000' } })).status, 400);
        const confirmed = await api('POST', '/auth/email-change/confirm', { body: { code } });
        assert.equal(confirmed.status, 200);
        assert.equal((await one(`SELECT email FROM users WHERE username='changer'`)).email, 'new@example.test');
        assert.equal((await api('GET', '/auth/me')).status, 200, 'the current session survives');
        assert.equal((await other('GET', '/auth/me')).status, 401, 'other sessions are revoked');
        assert.equal((await login(api, 'new@example.test')).status, 200, 'the new address is now the sign-in identifier');
        assert.equal((await login(client(), 'old@example.test')).status, 401, 'the old address no longer signs in');
        assert.ok(mailTo('old@example.test').some((m) => /changed/i.test(m.subject)));
    });

    // ---- organizations and onboarding ---------------------------------------------------------------

    test('onboarding is derived from real records; organization creation is idempotent and leaves no orphan on conflict', async () => {
        const { api, id } = await signedIn('orgfounder', 'orgfounder@example.test');
        const start = (await api('GET', '/onboarding')).body.data;
        assert.deepEqual({ step: start.step, organizations: start.organizations, canCreateOrganization: start.canCreateOrganization }, { step: 'organization', organizations: 0, canCreateOrganization: true });

        const [one1, two1] = await Promise.all([createTenant(api, 'acme-labs', 'form-key-0001'), createTenant(api, 'acme-labs', 'form-key-0001')]);
        assert.ok([one1.status, two1.status].every((s) => [201, 409].includes(s)), 'concurrent duplicates never produce two tenants');
        assert.equal(await count(`SELECT COUNT(*) FROM tenants WHERE slug='acme-labs'`), 1);
        const replay = await createTenant(api, 'acme-labs', 'form-key-0001');
        assert.equal(replay.status, 201, 'a retry replays the stored response');
        assert.equal(replay.body.data.slug, 'acme-labs');
        assert.equal(await count(`SELECT COUNT(*) FROM tenants WHERE slug='acme-labs'`), 1);
        const reused = await createTenant(api, 'different-name', 'form-key-0001');
        assert.equal(reused.status, 422);
        assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

        const tenantId = replay.body.data.id;
        assert.equal((await one(`SELECT membership_role FROM tenant_members WHERE tenant_id=${tenantId} AND user_id=${id}`)).membership_role, 'owner');
        assert.equal((await api('GET', '/onboarding')).body.data.step, 'done');

        const taken = await createTenant(api, 'acme-labs');
        assert.equal(taken.status, 409);
        assert.equal(await count(`SELECT COUNT(*) FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM tenant_members m WHERE m.tenant_id=t.id AND m.membership_role='owner') AND t.id > 100`), 0, 'no ownerless tenant after a failure');

        const second = await createTenant(api, 'second-org', 'form-key-0002');
        assert.equal(second.status, 201);
        assert.deepEqual((await api('GET', '/tenants')).body.data.map((t) => t.slug).sort(), ['acme-labs', 'second-org'], 'one user, several organizations');
    });

    // ---- invitations ----------------------------------------------------------------------------------

    const seedTenant = async () => {
        const owner = await signedIn('ownerone', 'owner1@example.test');
        const tenantId = (await createTenant(owner.api, 'invite-co')).body.data.id;
        return { owner, tenantId };
    };
    const invite = (owner, tenantId, email, role = 'member') => owner.api('POST', `/tenants/${tenantId}/invitations`, { body: { email, role } });

    test('invitation for a new user: emailed token, hashed at rest, accepted only by the verified invitee, single use', async () => {
        const { owner, tenantId } = await seedTenant();
        const created = await invite(owner, tenantId, 'Newbie@Example.test', 'admin');
        assert.equal(created.status, 201);
        const token = lastToken('newbie@example.test');
        assert.ok(token);
        assert.match(mailTo('newbie@example.test').at(-1).text, /\/accept-invitation#token=/);
        assert.notEqual((await one(`SELECT token_hash FROM tenant_invitations`)).token_hash, token);
        const listed = await owner.api('GET', `/tenants/${tenantId}/invitations`);
        assert.deepEqual(listed.body.data.map((i) => [i.email, i.role, i.status]), [['newbie@example.test', 'admin', 'pending']]);

        // The invitee registers and verifies through the real flow, then accepts.
        const api = client();
        await api('POST', '/auth/signup', { body: { fullName: 'New Bie', username: 'newbie', email: 'newbie@example.test', password } });
        await api('POST', '/auth/verify-email', { body: { email: 'newbie@example.test', code: lastCode('newbie@example.test') } });
        assert.equal((await login(api, 'newbie@example.test')).status, 200);
        const mine = await api('GET', '/invitations/mine');
        assert.equal(mine.body.data.length, 1);
        assert.equal((await api('GET', '/onboarding')).body.data.pendingInvitations, 1);
        const accepted = await api('POST', '/invitations/accept', { body: { token } });
        assert.equal(accepted.status, 200);
        assert.equal(accepted.body.data.membershipRole, 'admin');
        assert.equal((await one(`SELECT membership_role FROM tenant_members WHERE tenant_id=${tenantId} AND user_id=(SELECT id FROM users WHERE username='newbie')`)).membership_role, 'admin');
        assert.equal((await api('POST', '/invitations/accept', { body: { token } })).status, 400, 'reuse is rejected');
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE tenant_id=${tenantId} AND action IN ('CREATE INVITATION','ACCEPT INVITATION','ADD TENANT MEMBER')`), 3);
        assert.equal(JSON.stringify((await pool.query(`SELECT new_data FROM audit_logs WHERE action LIKE '%INVITATION%'`)).rows).includes(token), false, 'tokens never reach the audit trail');
    });

    test('wrong email, expired, revoked and resent invitations are rejected without membership', async () => {
        const { owner, tenantId } = await seedTenant();
        await invite(owner, tenantId, 'target@example.test');
        const token = lastToken('target@example.test');
        const intruder = await signedIn('intruder', 'intruder@example.test');
        const wrong = await intruder.api('POST', '/invitations/accept', { body: { token } });
        assert.equal(wrong.status, 403);
        assert.equal(wrong.body.error.code, 'INVITATION_EMAIL_MISMATCH');
        assert.equal(await count(`SELECT COUNT(*) FROM tenant_members WHERE tenant_id=${tenantId}`), 1);

        const target = await signedIn('target', 'target@example.test');
        const id = (await one(`SELECT id FROM tenant_invitations`)).id;
        assert.equal((await owner.api('POST', `/tenants/${tenantId}/invitations/${id}/resend`)).status, 429, 'resend cooldown');
        await pool.query(`UPDATE tenant_invitations SET updated_at = now() - interval '5 minutes'`);
        const resent = await owner.api('POST', `/tenants/${tenantId}/invitations/${id}/resend`);
        assert.equal(resent.status, 200);
        assert.equal((await target.api('POST', '/invitations/accept', { body: { token } })).status, 400, 'the old link stops working after a resend');
        const fresh = lastToken('target@example.test');
        assert.notEqual(fresh, token);

        await pool.query(`UPDATE tenant_invitations SET expires_at = now() - interval '1 minute'`);
        const expired = await target.api('POST', '/invitations/accept', { body: { token: fresh } });
        assert.equal(expired.status, 410);
        assert.equal((await one(`SELECT status FROM tenant_invitations`)).status, 'expired');
        assert.equal(await count(`SELECT COUNT(*) FROM tenant_members WHERE tenant_id=${tenantId}`), 1);

        await invite(owner, tenantId, 'revoked@example.test');
        const revokedToken = lastToken('revoked@example.test');
        const revoked = await signedIn('revokee', 'revoked@example.test');
        const rid = (await one(`SELECT id FROM tenant_invitations WHERE email_normalized='revoked@example.test'`)).id;
        assert.equal((await owner.api('DELETE', `/tenants/${tenantId}/invitations/${rid}`)).status, 200);
        assert.equal((await revoked.api('POST', '/invitations/accept', { body: { token: revokedToken } })).status, 400);
        assert.equal((await revoked.api('POST', `/invitations/${rid}/accept`)).status, 400);
    });

    test('concurrent acceptance of one invitation creates exactly one membership', async () => {
        const { owner, tenantId } = await seedTenant();
        await invite(owner, tenantId, 'racer2@example.test');
        const token = lastToken('racer2@example.test');
        const racer = await signedIn('racer2', 'racer2@example.test');
        const results = await Promise.all(Array.from({ length: 6 }, () => racer.api('POST', '/invitations/accept', { body: { token } })));
        assert.equal(results.filter((r) => r.status === 200).length, 1, 'exactly one acceptance wins');
        assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 400));
        assert.equal(await count(`SELECT COUNT(*) FROM tenant_members WHERE tenant_id=${tenantId} AND user_id=${racer.id}`), 1);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='ACCEPT INVITATION'`), 1);
    });

    test('invitation authority is re-checked: roles, plain members, other tenants, departed inviters, inactive tenants', async () => {
        const { owner, tenantId } = await seedTenant();
        const admin = await signedIn('adminone', 'admin1@example.test');
        const member = await signedIn('memberone', 'member1@example.test');
        await owner.api('POST', `/tenants/${tenantId}/members`, { body: { email: 'admin1@example.test', role: 'admin' } });
        await owner.api('POST', `/tenants/${tenantId}/members`, { body: { email: 'member1@example.test', role: 'member' } });

        assert.equal((await invite(admin, tenantId, 'x1@example.test', 'admin')).status, 403, 'admins cannot invite admins');
        assert.equal((await invite(member, tenantId, 'x2@example.test')).status, 403, 'plain members cannot invite');
        assert.equal((await invite(owner, tenantId, 'owner1@example.test')).status, 400, 'cannot invite yourself');
        assert.equal((await invite(owner, tenantId, 'member1@example.test')).status, 409, 'already a member');
        const other = await signedIn('otherowner', 'other@example.test');
        assert.equal((await invite(other, tenantId, 'x3@example.test')).status, 404, 'non-members cannot even see the tenant');
        assert.equal((await other.api('GET', `/tenants/${tenantId}/invitations`)).status, 404);

        // Cross-tenant IDs: another tenant's invitation is invisible through your own tenant.
        const otherTenant = (await createTenant(other.api, 'other-co')).body.data.id;
        await invite(other, otherTenant, 'cross@example.test');
        const crossId = (await one(`SELECT id FROM tenant_invitations WHERE email_normalized='cross@example.test'`)).id;
        assert.equal((await owner.api('DELETE', `/tenants/${tenantId}/invitations/${crossId}`)).status, 404);
        assert.equal((await owner.api('POST', `/tenants/${tenantId}/invitations/${crossId}/resend`)).status, 404);

        // An admin's invitation dies when the admin loses the right to add members.
        assert.equal((await invite(admin, tenantId, 'later@example.test')).status, 201);
        const laterToken = lastToken('later@example.test');
        const later = await signedIn('laterperson', 'later@example.test');
        await owner.api('DELETE', `/tenants/${tenantId}/members/${admin.id}`);
        const dead = await later.api('POST', '/invitations/accept', { body: { token: laterToken } });
        assert.equal(dead.status, 409);
        assert.equal(dead.body.error.code, 'INVITATION_NO_LONGER_VALID');

        await invite(owner, tenantId, 'inactive@example.test');
        const inactiveToken = lastToken('inactive@example.test');
        const inactive = await signedIn('inactiveperson', 'inactive@example.test');
        await pool.query(`UPDATE tenants SET status='suspended' WHERE id=${tenantId}`);
        assert.equal((await inactive.api('POST', '/invitations/accept', { body: { token: inactiveToken } })).status, 409);
        assert.equal(await count(`SELECT COUNT(*) FROM tenant_members WHERE user_id=${inactive.id}`), 0);
    });

    // ---- ownership transfer -------------------------------------------------------------------------

    test('ownership transfer is owner-only, code-confirmed, atomic, bound to its tenant and audited', async () => {
        const { owner, tenantId } = await seedTenant();
        const heir = await signedIn('heir', 'heir@example.test');
        await owner.api('POST', `/tenants/${tenantId}/members`, { body: { email: 'heir@example.test', role: 'admin' } });
        const outsider = await signedIn('outsider', 'outsider@example.test');

        assert.equal((await heir.api('POST', `/tenants/${tenantId}/ownership-transfer/request`, { body: { newOwnerUserId: heir.id } })).status, 403, 'only owners');
        assert.equal((await outsider.api('POST', `/tenants/${tenantId}/ownership-transfer/request`, { body: { newOwnerUserId: outsider.id } })).status, 404);
        assert.equal((await owner.api('POST', `/tenants/${tenantId}/ownership-transfer/request`, { body: { newOwnerUserId: outsider.id } })).status, 404, 'target must be a member');
        assert.equal((await owner.api('POST', `/tenants/${tenantId}/ownership-transfer/request`, { body: { newOwnerUserId: owner.id } })).status, 400);

        const requested = await owner.api('POST', `/tenants/${tenantId}/ownership-transfer/request`, { body: { newOwnerUserId: heir.id } });
        assert.equal(requested.status, 202);
        const code = lastCode('owner1@example.test');
        assert.equal((await owner.api('POST', `/tenants/${tenantId}/ownership-transfer/confirm`, { body: { code: code === '000000' ? '111111' : '000000' } })).status, 400);
        assert.equal(await count(`SELECT COUNT(*) FROM tenant_members WHERE tenant_id=${tenantId} AND membership_role='owner'`), 1, 'nothing changed yet');

        // A code issued for this tenant cannot confirm a transfer in another tenant the same user owns.
        const second = (await createTenant(owner.api, 'second-co')).body.data.id;
        const secondMember = await signedIn('secondmember', 'secondmember@example.test');
        await owner.api('POST', `/tenants/${second}/members`, { body: { email: 'secondmember@example.test' } });
        const misuse = await owner.api('POST', `/tenants/${second}/ownership-transfer/confirm`, { body: { code } });
        assert.equal(misuse.status, 400);
        assert.equal(secondMember.id !== undefined, true);

        const done = await owner.api('POST', `/tenants/${tenantId}/ownership-transfer/confirm`, { body: { code } });
        assert.equal(done.status, 200);
        const roles = (await pool.query(`SELECT user_id, membership_role FROM tenant_members WHERE tenant_id=${tenantId} ORDER BY user_id`)).rows;
        assert.equal(roles.find((r) => String(r.user_id) === heir.id).membership_role, 'owner');
        assert.equal(roles.find((r) => String(r.user_id) === owner.id).membership_role, 'admin');
        assert.equal(roles.filter((r) => r.membership_role === 'owner').length, 1, 'never zero or two owners');
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE tenant_id=${tenantId} AND action='OWNERSHIP_TRANSFERRED'`), 1);
        assert.equal((await owner.api('POST', `/tenants/${tenantId}/ownership-transfer/confirm`, { body: { code } })).status, 403, 'the former owner can no longer act as owner');
    });

    // ---- RBAC and tenant isolation ----------------------------------------------------------------------

    test('membership role decides access inside each organization; other organizations stay invisible on every route', async () => {
        const { owner, tenantId } = await seedTenant();
        const staff = await signedIn('staffer', 'staffer@example.test');
        const lead = await signedIn('leader', 'leader@example.test');
        await owner.api('POST', `/tenants/${tenantId}/members`, { body: { email: 'staffer@example.test', role: 'member' } });
        await owner.api('POST', `/tenants/${tenantId}/members`, { body: { email: 'leader@example.test', role: 'admin' } });
        const item = { name: 'Bean bag', sku: 'BEAN-1', quantity: 5 };

        // Both are "standard" accounts with no inventory permission of their own: the tenant role grants it.
        assert.equal((await staff.api('GET', `/inventory/tenants/${tenantId}/items`)).status, 200, 'member can read');
        assert.equal((await staff.api('POST', `/inventory/tenants/${tenantId}/items`, { body: item })).status, 403, 'member cannot create');
        const created = await lead.api('POST', `/inventory/tenants/${tenantId}/items`, { body: item });
        assert.equal(created.status, 200, 'admin can create');
        assert.equal((await staff.api('PUT', `/inventory/tenants/${tenantId}/items/${created.body.data.id}`, { body: { ...item, quantity: 9, unit: 'unit' } })).status, 403);
        assert.equal((await lead.api('PUT', `/inventory/tenants/${tenantId}/items/${created.body.data.id}`, { body: { ...item, quantity: 9, unit: 'unit' } })).status, 200);
        assert.equal((await staff.api('GET', `/audit/tenants/${tenantId}`)).status, 403, 'members cannot read the tenant audit log');
        assert.equal((await lead.api('GET', `/audit/tenants/${tenantId}`)).status, 200);
        assert.equal((await staff.api('GET', `/integrations/all/${tenantId}`)).status, 403);
        assert.equal((await lead.api('GET', `/integrations/all/${tenantId}`)).status, 200);

        // Someone who belongs to a different organization only: nothing here is reachable.
        const stranger = await signedIn('strangerx', 'strangerx@example.test');
        await createTenant(stranger.api, 'elsewhere');
        const probes = [
            ['GET', `/tenants/${tenantId}`], ['GET', `/tenants/${tenantId}/members`], ['GET', `/tenants/${tenantId}/invitations`],
            ['GET', `/inventory/tenants/${tenantId}/items`], ['POST', `/inventory/tenants/${tenantId}/items`, item],
            ['GET', `/audit/tenants/${tenantId}`], ['GET', `/integrations/all/${tenantId}`], ['GET', `/integrations/tenants/${tenantId}/settings`],
            ['POST', `/tenants/${tenantId}/invitations`, { email: 'z@example.test' }],
            ['POST', `/tenants/${tenantId}/ownership-transfer/request`, { newOwnerUserId: staff.id }],
            ['GET', `/ticketing/tenants/${tenantId}/tickets`], ['POST', `/ticketing/tenants/${tenantId}/tickets`, { title: 'Hello there' }],
        ];
        for (const [method, path, body] of probes) {
            const response = await stranger.api(method, path, body === undefined ? {} : { body });
            assert.ok([403, 404].includes(response.status), `${method} ${path} must be denied, got ${response.status}`);
        }
        assert.equal(await count(`SELECT COUNT(*) FROM inventory WHERE tenant_id=${tenantId}`), 1);
    });

    test('sessions end for unverified accounts and members cannot self-assign privileged roles', async () => {
        const { owner, tenantId } = await seedTenant();
        const member = await signedIn('lowly', 'lowly@example.test');
        await owner.api('POST', `/tenants/${tenantId}/members`, { body: { email: 'lowly@example.test', role: 'member' } });
        assert.equal((await member.api('PATCH', `/tenants/${tenantId}/members/${member.id}`, { body: { role: 'owner' } })).status, 403);
        assert.equal((await member.api('POST', `/tenants/${tenantId}/members`, { body: { email: 'x@example.test', role: 'admin' } })).status, 403);
        await pool.query(`UPDATE users SET email_verified_at = NULL WHERE id = ${member.id}`);
        assert.equal((await member.api('GET', '/auth/me')).status, 401, 'an account that is not verified has no usable session');
    });
});
