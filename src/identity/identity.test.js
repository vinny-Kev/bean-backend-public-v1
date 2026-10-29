// Identity building blocks that need no database: permission mapping, validators, mail templates and
// transport, challenge hashing and configuration validation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

process.env.DATABASE_URL = '';
process.env.SESSION_SECRET ||= 'test-session-secret-0123456789abcdefghij';
process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'bean_test';
process.env.DB_USER ||= 'test';
process.env.DB_PASSWORD ||= 'test';
process.env.MAIL_TRANSPORT = 'capture';
process.env.APP_ORIGINS = 'http://localhost:5173';

const { tenantRoleHasPermission, TENANT_ROLE_PERMISSIONS } = await import('../tenants/tenantPermissions.js');
const helpers = await import('./identityHelpers.js');
const { templates, appLink } = await import('../mail/templates.js');
const { sendMail, capturedMessages, clearCapturedMessages } = await import('../mail/mailer.js');
const challenges = await import('./challengeService.js');
const { hashRequest, readIdempotencyKey } = await import('./idempotency.js');

test('tenant roles map to a fixed, ordered permission set', () => {
    assert.equal(tenantRoleHasPermission('member', 'INVENTORY_READ'), true);
    for (const permission of ['INVENTORY_CREATE', 'INVENTORY_UPDATE', 'INTEGRATIONS_READ', 'INTEGRATIONS_MANAGE', 'AUDIT_READ']) {
        assert.equal(tenantRoleHasPermission('member', permission), false, `member must not have ${permission}`);
        assert.equal(tenantRoleHasPermission('admin', permission), true);
        assert.equal(tenantRoleHasPermission('owner', permission), true);
    }
    assert.equal(tenantRoleHasPermission(null, 'INVENTORY_READ'), false, 'no membership, no access');
    assert.equal(tenantRoleHasPermission('superuser', 'INVENTORY_READ'), false);
    assert.equal(tenantRoleHasPermission('admin', 'PLATFORM_AUDIT_READ'), false, 'platform permissions are never derived from membership');
    assert.ok(TENANT_ROLE_PERMISSIONS.member.every((p) => TENANT_ROLE_PERMISSIONS.admin.includes(p)));
    assert.throws(() => { TENANT_ROLE_PERMISSIONS.member.push('X'); }, TypeError, 'the table is frozen');
});

test('full name, email and password validators', () => {
    for (const ok of ['Ada Lovelace', 'José de la Cruz', "Mary-Jane O'Neil", 'Li Wei', '张伟']) {
        assert.equal(helpers.isValidFullName(helpers.normalizeFullName(`  ${ok}  `)), true, ok);
    }
    for (const bad of ['', 'A', 'x'.repeat(101), '12345', 'Ada <b>', 'Ada;DROP', '- Ada']) {
        assert.equal(helpers.isValidFullName(helpers.normalizeFullName(bad)), false, bad);
    }
    assert.equal(helpers.normalizeFullName('  Ada    Lovelace '), 'Ada Lovelace');
    assert.equal(helpers.normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
    assert.equal(helpers.isValidEmail('a@b.co'), true);
    assert.equal(helpers.isValidEmail('no-at-sign'), false);
    assert.equal(helpers.isValidNewPassword('Str0ng!Pass'), true);
    for (const bad of ['short1!', 'alllowercase1!', 'NoDigits!!', 'No Space1!a', 'A1!a'.repeat(6), undefined, 12345678]) {
        assert.equal(helpers.isValidNewPassword(bad), false, String(bad));
    }
    assert.equal(helpers.maskEmail('sam@example.com'), 's***@example.com');
});

test('email links are built from the trusted origin and keep secrets in the fragment', () => {
    const link = appLink('/reset-password', 'token=abc');
    assert.equal(link, 'http://localhost:5173/reset-password#token=abc');
    assert.equal(link.includes('?'), false);
    const reset = templates.passwordReset({ url: link, minutes: 60 });
    assert.match(reset.text, /#token=abc/);
    assert.match(reset.html, /href="http:\/\/localhost:5173\/reset-password#token=abc"/);
});

test('mail templates escape user-controlled text and never put codes in subjects', () => {
    const invitation = templates.invitation({ organization: '<script>alert(1)</script>', inviter: 'Eve "the" <b>Admin</b>', role: 'member', url: 'http://localhost:5173/x#token=t', days: 7 });
    assert.equal(invitation.html.includes('<script>'), false);
    assert.equal(invitation.html.includes('<b>'), false);
    assert.match(invitation.html, /&lt;script&gt;/);
    const code = templates.verifyEmail({ code: '482913', minutes: 10 });
    assert.equal(code.subject.includes('482913'), false);
    assert.match(code.text, /482913/);
});

test('the capture transport keeps messages in memory and strips header injection', async () => {
    clearCapturedMessages();
    const sent = await sendMail({ to: 'Victim@Example.test\r\nBcc: attacker@example.test', subject: 'Hi\r\nBcc: x@y.z', text: 't', html: '<p>t</p>', template: 'test' });
    assert.equal(sent, true);
    const [message] = capturedMessages();
    assert.equal(/[\r\n]/.test(message.to + message.subject), false);
    assert.equal(message.template, 'test');
    clearCapturedMessages();
});

test('one-time codes and tokens are random, hashed with a purpose binding, and never equal their hash', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => challenges.newToken()));
    assert.equal(tokens.size, 50);
    assert.ok([...tokens].every((token) => token.length >= 43));
    const token = [...tokens][0];
    assert.equal(challenges.hashToken('password_reset', token), challenges.hashToken('password_reset', token));
    assert.notEqual(challenges.hashToken('password_reset', token), challenges.hashToken('invitation', token), 'the purpose is part of the hash');
    assert.notEqual(challenges.hashToken('password_reset', token), token);
    assert.match(challenges.hashToken('password_reset', token), /^[0-9a-f]{64}$/);
    assert.notEqual(challenges.hashIp('1.2.3.4'), '1.2.3.4');
    assert.equal(challenges.policy.maxAttempts, 5);
    assert.equal(challenges.policy.cooldownSeconds, 60);
});

test('a challenge row stores a hash and the issue/verify queries use the documented binding', async () => {
    const calls = [];
    const row = { stored: null };
    const client = {
        query: async (sql, params = []) => {
            calls.push({ sql, params });
            if (sql.includes('INSERT INTO auth_challenges')) {
                row.stored = { publicId: params[0], purpose: params[2], hash: params[6], expires: params[8] };
                return { rows: [{ expires_at: new Date(Date.now() + 600_000) }] };
            }
            return { rows: [], rowCount: 0 };
        },
    };
    const issued = await challenges.issueChallenge(client, { userId: 9, purpose: 'verify_email', email: 'a@b.co' });
    assert.match(issued.secret, /^\d{6}$/);
    assert.notEqual(row.stored.hash, issued.secret);
    assert.equal(row.stored.purpose, 'verify_email');
    assert.equal(row.stored.expires, '10');
    assert.ok(calls[0].sql.includes('superseded_at = now()'), 'the previous live challenge is superseded first');
    const missing = await challenges.verifyOtp(client, { userId: 9, purpose: 'verify_email', code: issued.secret });
    assert.deepEqual(missing, { ok: false, reason: 'INVALID' }, 'no live challenge gives the same generic answer');
});

test('idempotency keys are validated and request hashes are stable', () => {
    const request = (value) => ({ get: () => value });
    assert.equal(readIdempotencyKey(request('form-key-0001')), 'form-key-0001');
    for (const bad of [undefined, '', 'short', 'x'.repeat(101), 'has space in it', 'bad/char/here']) assert.equal(readIdempotencyKey(request(bad)), null, String(bad));
    assert.equal(hashRequest({ a: 1 }), hashRequest({ a: 1 }));
    assert.notEqual(hashRequest({ a: 1 }), hashRequest({ a: 2 }));
});

test('configuration fails fast with actionable messages', () => {
    const run = (env) => {
        try {
            execFileSync(process.execPath, ['--input-type=module', '-e', "import('./src/config.js').then(()=>console.log('OK'))"], {
                cwd: new URL('../..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
                env: { PATH: process.env.PATH, SESSION_SECRET: process.env.SESSION_SECRET, DB_HOST: 'localhost', DB_NAME: 'x', DB_USER: 'x', DB_PASSWORD: 'x', APP_ORIGINS: 'http://localhost:5173', ...env },
            });
            return 'OK';
        } catch (error) {
            return String(error.stderr);
        }
    };
    assert.equal(run({ MAIL_TRANSPORT: 'capture' }), 'OK');
    assert.match(run({ MAIL_TRANSPORT: 'smtp', MAIL_FROM_ADDRESS: 'no-reply@example.com' }), /SMTP_HOST/);
    assert.match(run({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com' }), /MAIL_FROM_ADDRESS/);
    assert.match(run({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', MAIL_FROM_ADDRESS: 'no-reply@example.com', SMTP_USER: 'u' }), /SMTP_USER and SMTP_PASSWORD/);
    assert.match(run({ MAIL_TRANSPORT: 'carrier-pigeon' }), /MAIL_TRANSPORT must be/);
    assert.match(run({ NODE_ENV: 'production', MAIL_TRANSPORT: 'outbox' }), /MAIL_TRANSPORT must be smtp in production/);
    assert.match(run({ MAIL_TRANSPORT: 'capture', APP_BASE_URL: 'https://evil.example' }), /APP_BASE_URL must be one of the APP_ORIGINS/);
    assert.match(run({ MAIL_TRANSPORT: 'capture', LOGIN_STEP_UP: 'sometimes' }), /LOGIN_STEP_UP/);
    assert.match(run({ MAIL_TRANSPORT: 'capture', OTP_PEPPER: 'short' }), /OTP_PEPPER/);
});
