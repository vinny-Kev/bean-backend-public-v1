import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { destroySession } from '../../util/sessionUtils.js';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { checkIssueAllowed, hashDeviceToken, hashIp, issueChallenge, newToken, policy, verifyOtp } from '../../identity/challengeService.js';
import {
    audit, auditBestEffort, clientIp, codeLength, deviceCookieName, deviceCookieOptions, readCookie, resendSeconds, sendCooldown, sendError, sendOtpError,
} from '../../identity/identityHelpers.js';
import { sendMail } from '../../mail/mailer.js';
import { templates } from '../../mail/templates.js';

const regenerateSession = (req) => new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
});

const saveSession = (req) => new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
});

// Starts the authenticated session. The session ID is regenerated first (session fixation).
const establishSession = async (req, user) => {
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.authenticatedAt = Date.now();
    await saveSession(req);
};

// Device trust: the first successful sign-in of an account silently trusts that browser; after
// that, a browser without a trusted-device cookie must pass an email code (step-up).
const deviceStatus = async (userId, req) => {
    const token = readCookie(req, deviceCookieName(userId));
    const result = await pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE token_hash = $2)::int AS known
         FROM trusted_devices WHERE user_id = $1`,
        [userId, token ? hashDeviceToken(token) : null],
    );
    return { any: result.rows[0].total > 0, known: result.rows[0].known > 0, token };
};

const trustDevice = async (userId, res) => {
    const token = newToken();
    await pool.query('INSERT INTO trusted_devices (user_id, token_hash) VALUES ($1, $2)', [userId, hashDeviceToken(token)]);
    res.cookie(deviceCookieName(userId), token, deviceCookieOptions);
};

const completeLogin = async (req, res, user, { viaStepUp = false } = {}) => {
    const device = await deviceStatus(user.id, req);
    await establishSession(req, user);
    if (device.known) {
        await pool.query('UPDATE trusted_devices SET last_seen_at = now() WHERE user_id = $1 AND token_hash = $2', [user.id, hashDeviceToken(device.token)]);
    } else if (!device.any || viaStepUp) {
        await trustDevice(user.id, res);
    }
    await composeAuditLogs(auditLog({
        userId: user.id,
        action: 'LOGIN_SUCCESS',
        tableName: 'session',
        recordId: user.id,
        ...(viaStepUp && { newData: { stepUp: 'email_otp' } }),
    }));
    return res.status(200).json({ message: 'Login successful.', user });
};

export const loginUser = async (req, res, next) => {
    try {
        const user = req.user;
        if (config.loginStepUp === 'new-device') {
            const device = await deviceStatus(user.id, req);
            if (device.any && !device.known) {
                const client = await pool.connect();
                let issued = null;
                try {
                    await client.query('BEGIN');
                    const allowed = await checkIssueAllowed(client, user.id, 'login_step_up');
                    if (!allowed.allowed) {
                        await client.query('ROLLBACK');
                        return sendCooldown(res, allowed.retryAfterSeconds);
                    }
                    issued = await issueChallenge(client, { userId: user.id, purpose: 'login_step_up', email: user.email, ipHash: hashIp(clientIp(req)) });
                    await audit(client, { userId: user.id, action: 'LOGIN_STEP_UP_REQUIRED', tableName: 'session', recordId: user.id });
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK').catch(() => {});
                    throw error;
                } finally {
                    client.release();
                }
                await sendMail({ to: user.email, template: 'loginCode', ...templates.loginCode({ code: issued.secret, minutes: policy.otpMinutes }) }, { requestId: req.requestId });
                return res.status(202).json({
                    challenge: 'email_otp',
                    challengeId: issued.publicId,
                    codeLength,
                    retryAfterSeconds: resendSeconds,
                    expiresInMinutes: policy.otpMinutes,
                    message: 'Enter the code we emailed you to finish signing in.',
                });
            }
        }
        return await completeLogin(req, res, user);
    } catch (error) {
        return next(error);
    }
};

// POST /auth/login/verify { challengeId, code }: finishes a step-up sign-in.
export const verifyLoginStepUp = async (req, res, next) => {
    const { challengeId, code } = req.body ?? {};
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof challengeId !== 'string' || !uuid.test(challengeId)) return sendError(res, 404, 'CHALLENGE_NOT_FOUND', 'This sign-in attempt is no longer valid. Sign in again.');
    if (typeof code !== 'string') return sendOtpError(res, 'INVALID');
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const row = (await client.query(
            `SELECT c.user_id, c.consumed_at, c.superseded_at, u.id, u.email, u.username, u.full_name, u.role_id
             FROM auth_challenges c JOIN users u ON u.id = c.user_id
             WHERE c.public_id = $1 AND c.purpose = 'login_step_up'
               AND u.is_disabled = false AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL`,
            [challengeId],
        )).rows[0];
        if (!row || row.superseded_at) {
            await client.query('ROLLBACK');
            return sendError(res, 404, 'CHALLENGE_NOT_FOUND', 'This sign-in attempt is no longer valid. Sign in again.');
        }
        if (row.consumed_at) {
            await client.query('ROLLBACK');
            return sendOtpError(res, 'USED');
        }
        const result = await verifyOtp(client, { userId: row.user_id, purpose: 'login_step_up', code, publicId: challengeId });
        if (!result.ok) {
            await auditBestEffort(client, { userId: row.user_id, action: 'LOGIN_STEP_UP_FAILED', tableName: 'session', recordId: row.user_id, newData: { reason: result.reason } }, req.requestId);
            await client.query('COMMIT');
            return sendOtpError(res, result.reason);
        }
        await client.query('COMMIT');
        const user = { id: row.id, email: row.email, username: row.username, fullName: row.full_name, roleId: row.role_id };
        return await completeLogin(req, res, user, { viaStepUp: true });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};

export const logoutUser = async (req, res, next) => {
    try {
        const userId = req.session?.userId;
        if (userId) {
            // Logging out must always succeed, so a failed audit write is reported but not fatal.
            await composeAuditLogs(auditLog({
                userId,
                action: 'LOGOUT',
                tableName: 'session',
                recordId: userId,
            })).catch(() => {
                console.error(JSON.stringify({ event: 'logout_audit_failed', requestId: req.requestId }));
            });
        }
        if (req.session) await destroySession(req);
        res.clearCookie('bean.sid', {
            httpOnly: true,
            secure: config.cookieSecure,
            sameSite: config.cookieSameSite,
            path: '/',
        });
        return res.status(204).end();
    } catch (error) {
        return next(error);
    }
};
