import { auditLog } from '../audit_logs/auditLog.js';
import { composeAuditLogs } from '../audit_logs/auditLogService.js';
import { config } from '../config.js';
import { compareToPattern, inRangeOfLength } from '../util/validations.js';

export const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
export const isValidEmail = (email) => email.length > 0 && email.length <= 254 && compareToPattern(email, 'email');

// Same rule as signup has always used: 8-20 chars, upper+lower+digit+symbol, no whitespace, <= 72 bytes.
export const isValidNewPassword = (password) => typeof password === 'string'
    && Buffer.byteLength(password, 'utf8') <= 72 && compareToPattern(password, 'password') && inRangeOfLength(password, 8, 20);

export const passwordMessage = 'Password must be 8 to 20 characters, include upper and lower case letters, a number and a symbol, and use at most 72 UTF-8 bytes.';

// Letters (any script), single spaces, apostrophes, hyphens and periods; 2-100 characters.
const fullNamePattern = /^\p{L}[\p{L}\p{M}\p{N}.'’-]*(?: \p{L}[\p{L}\p{M}\p{N}.'’-]*)*$/u;
export const normalizeFullName = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');
export const isValidFullName = (name) => name.length >= 2 && name.length <= 100 && fullNamePattern.test(name);

export const maskEmail = (email) => {
    const [local = '', domain = ''] = email.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
};

// Audit helper: never pass secrets, codes, tokens or full request bodies into newData.
export const audit = (client, { userId = null, tenantId = null, action, tableName = null, recordId = null, oldData = null, newData = null }) =>
    composeAuditLogs(auditLog({ userId, tenantId, action, tableName, recordId, oldData, newData }), client);

// Best-effort audit for events outside a business transaction (failures must not change the response).
export const auditBestEffort = async (client, entry, requestId) => {
    try {
        await audit(client, entry);
    } catch {
        console.error(JSON.stringify({ event: 'audit_write_failed', action: entry.action, requestId }));
    }
};

// Ends every session of a user, optionally keeping one (the session that is making the change).
export const revokeUserSessions = async (client, userId, { exceptSid = null } = {}) => {
    const result = await client.query(
        `DELETE FROM session WHERE (sess::jsonb)->>'userId' = $1::text AND ($2::text IS NULL OR sid <> $2)`,
        [String(userId), exceptSid],
    );
    return result.rowCount;
};

// A verified user with no account role becomes a "standard" user (may create an organization).
export const ensureDefaultRole = (client, userId) => client.query(
    `UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'standard') WHERE id = $1 AND role_id IS NULL`,
    [userId],
);

export const clientIp = (req) => req.ip ?? req.socket?.remoteAddress ?? '';

// One trusted-device cookie per account (bean.dev.<userId>), so several people (or one person testing
// several accounts) can share a browser without invalidating each other's trust.
export const deviceCookieName = (userId) => `bean.dev.${userId}`;
export const readCookie = (req, name) => {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
    }
    return null;
};
export const deviceCookieOptions = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    maxAge: 1000 * 60 * 60 * 24 * 180,
    path: '/',
};

// Standard error envelope used by all new identity endpoints.
export const sendError = (res, status, code, message, extra = {}) => res.status(status).json({
    error: { code, message, ...extra, requestId: res.req?.requestId },
});

// Error codes shared with the frontend (bean-frontend docs/identity-frontend-contract.md).
export const codeLength = 6;
export const resendSeconds = 60;
const otpErrors = {
    INVALID: [400, 'OTP_INVALID', 'That code is not correct.'],
    EXPIRED: [400, 'OTP_EXPIRED', 'That code has expired. Request a new one.'],
    LOCKED: [400, 'OTP_LOCKED', 'Too many incorrect attempts. Request a new code.'],
    USED: [400, 'OTP_ALREADY_USED', 'That code was already used. Request a new one.'],
};
export const sendOtpError = (res, reason) => sendError(res, ...otpErrors[reason] ?? otpErrors.INVALID);
export const sendCooldown = (res, retryAfterSeconds) => {
    res.set('Retry-After', String(retryAfterSeconds));
    return sendError(res, 429, 'OTP_RATE_LIMITED', 'A code was just sent. Wait a moment before requesting another.', { retryAfterSeconds });
};
