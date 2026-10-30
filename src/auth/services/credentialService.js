import bcrypt from 'bcrypt';
import { pool } from '../../db/pool.js';
import { checkIssueAllowed, consumeToken, hashIp, issueChallenge, policy, verifyOtp } from '../../identity/challengeService.js';
import {
    audit, clientIp, codeLength, ensureDefaultRole, isValidEmail, isValidNewPassword, normalizeEmail, passwordMessage, resendSeconds, revokeUserSessions, sendCooldown, sendError, sendOtpError,
} from '../../identity/identityHelpers.js';
import { sendMail } from '../../mail/mailer.js';
import { appLink, templates } from '../../mail/templates.js';

// ---- Password recovery -------------------------------------------------------------------------

// POST /auth/password/forgot { email }: always the same 202, whether or not the account exists.
export const forgotPassword = async (req, res, next) => {
    const email = normalizeEmail(req.body?.email);
    let client;
    try {
        if (isValidEmail(email)) {
            client = await pool.connect();
            await client.query('BEGIN');
            const user = (await client.query(
                'SELECT id FROM users WHERE lower(email) = $1 AND is_disabled = false AND deleted_at IS NULL FOR UPDATE', [email],
            )).rows[0];
            let token = null;
            if (user && (await checkIssueAllowed(client, user.id, 'password_reset')).allowed) {
                token = (await issueChallenge(client, { userId: user.id, purpose: 'password_reset', kind: 'token', email, ipHash: hashIp(clientIp(req)) })).secret;
                await audit(client, { userId: user.id, action: 'PASSWORD_RESET_REQUESTED', tableName: 'users', recordId: user.id });
            }
            await client.query('COMMIT');
            if (token) {
                await sendMail({ to: email, template: 'passwordReset', ...templates.passwordReset({ url: appLink('/reset-password', `token=${token}`), minutes: policy.tokenMinutes.password_reset }) }, { requestId: req.requestId });
            }
        }
        return res.status(202).json({ status: 'reset_requested', retryAfterSeconds: resendSeconds, message: 'If that address has an account, a reset link has been sent.' });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};

// POST /auth/password/reset { token, newPassword }: single-use token, ends every session.
export const resetPassword = async (req, res, next) => {
    const { token, newPassword } = req.body ?? {};
    if (!isValidNewPassword(newPassword)) return sendError(res, 400, 'INVALID_PASSWORD', passwordMessage);
    let client;
    try {
        const hash = await bcrypt.hash(newPassword, 12);
        client = await pool.connect();
        await client.query('BEGIN');
        const result = await consumeToken(client, { purpose: 'password_reset', token });
        if (!result.ok) {
            await client.query('ROLLBACK');
            return sendError(res, 400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired. Request a new one.');
        }
        const userId = result.challenge.user_id;
        const user = (await client.query(
            'SELECT email FROM users WHERE id = $1 AND is_disabled = false AND deleted_at IS NULL FOR UPDATE', [userId],
        )).rows[0];
        if (!user) {
            await client.query('ROLLBACK');
            return sendError(res, 400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired. Request a new one.');
        }
        // Following the link proves control of the mailbox, so it also verifies a still-unverified address.
        await client.query(
            'UPDATE users SET password_hash = $2, password_changed_at = now(), email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1',
            [userId, hash],
        );
        await ensureDefaultRole(client, userId);
        const revoked = await revokeUserSessions(client, userId);
        await client.query('DELETE FROM trusted_devices WHERE user_id = $1', [userId]);
        await client.query(`UPDATE auth_challenges SET superseded_at = now() WHERE user_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`, [userId]);
        await audit(client, { userId, action: 'PASSWORD_RESET_COMPLETED', tableName: 'users', recordId: userId, newData: { sessionsRevoked: revoked } });
        await client.query('COMMIT');
        await sendMail({ to: user.email, template: 'passwordChanged', ...templates.passwordChanged() }, { requestId: req.requestId });
        return res.status(200).json({ status: 'password_reset', message: 'Your password was changed. Sign in with the new password.' });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};

// ---- Email change -------------------------------------------------------------------------------

// POST /auth/email-change/request { newEmail, currentPassword } (signed in)
export const requestEmailChange = async (req, res, next) => {
    const newEmail = normalizeEmail(req.body?.newEmail);
    const { currentPassword } = req.body ?? {};
    if (!isValidEmail(newEmail) || typeof currentPassword !== 'string' || !currentPassword || Buffer.byteLength(currentPassword, 'utf8') > 72) {
        return sendError(res, 400, 'INVALID_REQUEST', 'Enter a valid new email address and your current password.');
    }
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const user = (await client.query('SELECT id, email, password_hash FROM users WHERE id = $1 FOR UPDATE', [req.user.id])).rows[0];
        if (!await bcrypt.compare(currentPassword, user.password_hash)) {
            await audit(client, { userId: user.id, action: 'EMAIL_CHANGE_DENIED', tableName: 'users', recordId: user.id, newData: { reason: 'wrong_password' } });
            await client.query('COMMIT');
            return sendError(res, 403, 'INVALID_PASSWORD', 'Your current password is not correct.');
        }
        let code = null;
        let throttled = null;
        const taken = newEmail !== user.email && (await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [newEmail])).rowCount > 0;
        if (newEmail !== user.email && !taken) {
            const allowed = await checkIssueAllowed(client, user.id, 'email_change');
            if (allowed.allowed) {
                code = (await issueChallenge(client, { userId: user.id, purpose: 'email_change', email: newEmail, ipHash: hashIp(clientIp(req)) })).secret;
                await audit(client, { userId: user.id, action: 'EMAIL_CHANGE_REQUESTED', tableName: 'users', recordId: user.id });
            } else {
                throttled = allowed;
            }
        }
        await client.query('COMMIT');
        if (throttled) return sendCooldown(res, throttled.retryAfterSeconds);
        if (code) {
            await sendMail({ to: newEmail, template: 'emailChangeCode', ...templates.emailChangeCode({ code, minutes: policy.otpMinutes }) }, { requestId: req.requestId });
            await sendMail({ to: user.email, template: 'emailChangeNotice', ...templates.emailChangeNotice({ phase: 'requested' }) }, { requestId: req.requestId });
        }
        // Identical whether or not the new address is already registered.
        return res.status(202).json({ status: 'code_sent', codeLength, retryAfterSeconds: resendSeconds, message: 'If the address can be used, a confirmation code has been sent to it.' });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};

// POST /auth/email-change/confirm { code } (signed in)
export const confirmEmailChange = async (req, res, next) => {
    const { code } = req.body ?? {};
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const user = (await client.query('SELECT id, email FROM users WHERE id = $1 FOR UPDATE', [req.user.id])).rows[0];
        const result = await verifyOtp(client, { userId: user.id, purpose: 'email_change', code });
        if (!result.ok) {
            await client.query('COMMIT'); // keep the failed-attempt count
            return sendOtpError(res, result.reason);
        }
        const newEmail = result.challenge.email;
        try {
            await client.query('SAVEPOINT change');
            await client.query('UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1', [user.id, newEmail]);
        } catch (error) {
            if (error.code !== '23505') throw error;
            await client.query('ROLLBACK TO SAVEPOINT change');
            await client.query('COMMIT');
            return sendError(res, 409, 'EMAIL_UNAVAILABLE', 'That email address can no longer be used. Start again with another address.');
        }
        const revoked = await revokeUserSessions(client, user.id, { exceptSid: req.sessionID });
        await audit(client, { userId: user.id, action: 'EMAIL_CHANGE_CONFIRMED', tableName: 'users', recordId: user.id, newData: { otherSessionsRevoked: revoked } });
        await client.query('COMMIT');
        await sendMail({ to: user.email, template: 'emailChangeNotice', ...templates.emailChangeNotice({ phase: 'confirmed' }) }, { requestId: req.requestId });
        return res.status(200).json({ status: 'email_changed', message: 'Your email address was changed.', email: newEmail });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};
