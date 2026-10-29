import bcrypt from 'bcrypt';
import { pool } from '../../db/pool.js';
import { checkIssueAllowed, hashIp, issueChallenge, policy, verifyOtp } from '../../identity/challengeService.js';
import { audit, auditBestEffort, clientIp, codeLength, ensureDefaultRole, normalizeEmail, resendSeconds, sendError, sendOtpError } from '../../identity/identityHelpers.js';
import { sendMail } from '../../mail/mailer.js';
import { appLink, templates } from '../../mail/templates.js';

const accepted = (res) => res.status(202).json({
    status: 'verification_sent',
    codeLength,
    retryAfterSeconds: resendSeconds,
    message: 'If the details are valid, a verification code has been sent to the email address. Enter it to activate the account.',
});

// "Someone registered with your address" notices are limited to one per address per 10 minutes so
// registration cannot be used to spam an inbox.
const noticeSentAt = new Map();
const mayNotify = (email) => {
    const now = Date.now();
    for (const [key, at] of noticeSentAt) if (now - at > 600_000) noticeSentAt.delete(key);
    if (noticeSentAt.has(email)) return false;
    noticeSentAt.set(email, now);
    return true;
};

const sendVerificationCode = (to, code, requestId) => sendMail(
    { to, template: 'verifyEmail', ...templates.verifyEmail({ code, minutes: policy.otpMinutes }) },
    { requestId },
);

// POST /auth/signup: creates an UNVERIFIED account and emails a one-time code. The response is the
// same whether or not the email is already registered (no account enumeration by email). A repeat
// submission for an unverified address never replaces the stored password: the original owner of
// the address is the only one who can complete verification, and the code goes to that mailbox.
export const signupUserService = async (req, res, next) => {
    const { fullName, username, email, password } = req.body;
    let client;
    try {
        const passwordHash = await bcrypt.hash(password, 12);
        client = await pool.connect();
        await client.query('BEGIN');
        const inserted = await client.query(
            `INSERT INTO users (username, email, password_hash, full_name)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
            [username, email, passwordHash, fullName],
        );

        if (inserted.rowCount) {
            const userId = inserted.rows[0].id;
            const challenge = await issueChallenge(client, { userId, purpose: 'verify_email', email, ipHash: hashIp(clientIp(req)) });
            await audit(client, { userId, action: 'SIGNUP', tableName: 'users', recordId: userId, newData: { username } });
            await client.query('COMMIT');
            await sendVerificationCode(email, challenge.secret, req.requestId);
            return accepted(res);
        }

        const existing = (await client.query(
            'SELECT id, email_verified_at, deleted_at, is_disabled FROM users WHERE lower(email) = $1', [email],
        )).rows[0];
        if (!existing) {
            await client.query('ROLLBACK');
            return sendError(res, 409, 'USERNAME_TAKEN', 'That username is already taken. Choose another.');
        }
        if (existing.deleted_at || existing.is_disabled) {
            await client.query('COMMIT');
            return accepted(res);
        }
        if (existing.email_verified_at) {
            await client.query('COMMIT');
            if (mayNotify(email)) {
                await sendMail({ to: email, template: 'accountExists', ...templates.accountExists({ url: appLink('/login') }) }, { requestId: req.requestId });
            }
            return accepted(res);
        }
        // Unverified: send a fresh code (superseding the old one) unless one was sent a moment ago.
        const allowed = await checkIssueAllowed(client, existing.id, 'verify_email');
        let code = null;
        if (allowed.allowed) {
            code = (await issueChallenge(client, { userId: existing.id, purpose: 'verify_email', email, ipHash: hashIp(clientIp(req)) })).secret;
        }
        await client.query('COMMIT');
        if (code) await sendVerificationCode(email, code, req.requestId);
        return accepted(res);
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};

// POST /auth/verify-email { email, code }
export const verifyEmailService = async (req, res, next) => {
    const email = normalizeEmail(req.body?.email);
    const code = req.body?.code;
    if (!email || typeof code !== 'string') return sendError(res, 400, 'OTP_INVALID', 'Enter the email address and the 6-digit code.');
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const user = (await client.query(
            'SELECT id, email_verified_at FROM users WHERE lower(email) = $1 AND is_disabled = false AND deleted_at IS NULL FOR UPDATE', [email],
        )).rows[0];
        const result = user && !user.email_verified_at
            ? await verifyOtp(client, { userId: user.id, purpose: 'verify_email', code, email })
            : { ok: false, reason: 'INVALID' };
        if (!result.ok) {
            if (user) await auditBestEffort(client, { userId: user.id, action: 'EMAIL_VERIFY_FAILED', tableName: 'users', recordId: user.id, newData: { reason: result.reason } }, req.requestId);
            await client.query('COMMIT'); // persists the failed-attempt counter
            return sendOtpError(res, result.reason);
        }
        await client.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [user.id]);
        await ensureDefaultRole(client, user.id);
        await audit(client, { userId: user.id, action: 'SIGNUP_VERIFIED', tableName: 'users', recordId: user.id });
        await client.query('COMMIT');
        return res.status(200).json({ status: 'verified', message: 'Email verified. You can sign in now.' });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};

// POST /auth/verify-email/resend { email }: always 202.
export const resendVerificationService = async (req, res, next) => {
    const email = normalizeEmail(req.body?.email);
    let client;
    try {
        if (email) {
            client = await pool.connect();
            await client.query('BEGIN');
            const user = (await client.query(
                'SELECT id FROM users WHERE lower(email) = $1 AND email_verified_at IS NULL AND is_disabled = false AND deleted_at IS NULL FOR UPDATE', [email],
            )).rows[0];
            let code = null;
            if (user && (await checkIssueAllowed(client, user.id, 'verify_email')).allowed) {
                code = (await issueChallenge(client, { userId: user.id, purpose: 'verify_email', email, ipHash: hashIp(clientIp(req)) })).secret;
            }
            await client.query('COMMIT');
            if (code) await sendVerificationCode(email, code, req.requestId);
        }
        return res.status(202).json({ status: 'verification_sent', codeLength, retryAfterSeconds: resendSeconds, message: 'If that address has an unverified account, a new code has been sent.' });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};
