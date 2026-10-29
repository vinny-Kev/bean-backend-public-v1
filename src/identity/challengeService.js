import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// One-time codes (6 digit OTPs) and tokens (32 random bytes) for verification, step-up, password
// reset, email change and sensitive actions. See db/migrations/014_auth_challenges.sql.
//
// Policy (documented in docs/identity/security-model.md):
//   * OTP: 6 digits, 10 minutes, 5 attempts. Token: 256 bits, password reset 60 min.
//   * Only an HMAC (server pepper) is stored. HMAC input includes the purpose, so a code issued for one
//     purpose can never satisfy another, and OTPs also include the challenge id.
//   * A new challenge supersedes the previous live one for the same (user, purpose).
//   * Resend cooldown 60 s; at most 5 challenges per (user, purpose) per hour.
//   * Failed attempts are counted in the database before the answer is returned.

export const policy = Object.freeze({
    otpMinutes: 10,
    tokenMinutes: { password_reset: 60 },
    maxAttempts: 5,
    cooldownSeconds: 60,
    maxPerHour: 5,
});

const hmac = (parts) => createHmac('sha256', config.otpPepper).update(parts.join('\u0000')).digest('hex');
const safeEqual = (a, b) => {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
};
export const hashIp = (ip) => createHash('sha256').update(`ip:${ip ?? ''}`).digest('hex');
export const hashDeviceToken = (token) => hmac(['device', token]);
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (purpose, token) => hmac(['token', purpose, token]);
const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const otpHash = (purpose, challengePublicId, code) => hmac(['otp', purpose, challengePublicId, code]);

// Throttle check: returns { allowed } or { allowed:false, reason, retryAfterSeconds }.
export const checkIssueAllowed = async (client, userId, purpose) => {
    const recent = await client.query(
        `SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hourly,
                EXTRACT(EPOCH FROM (now() - MAX(created_at)))::int AS seconds_since_last
         FROM auth_challenges WHERE user_id = $1 AND purpose = $2`,
        [userId, purpose],
    );
    const { hourly, seconds_since_last: sinceLast } = recent.rows[0];
    if (sinceLast !== null && sinceLast < policy.cooldownSeconds) {
        return { allowed: false, reason: 'COOLDOWN', retryAfterSeconds: policy.cooldownSeconds - sinceLast };
    }
    if (hourly >= policy.maxPerHour) return { allowed: false, reason: 'HOURLY_LIMIT', retryAfterSeconds: 3600 };
    return { allowed: true };
};

// Creates a challenge, superseding any live one. Returns { secret, publicId, expiresAt }; `secret` is
// the plaintext code/token to email and must never be logged or returned over the API.
export const issueChallenge = async (client, { userId, purpose, kind = 'otp', email = null, context = {}, ipHash = null }) => {
    const publicId = randomUUID();
    const secret = kind === 'otp' ? newOtp() : newToken();
    const minutes = kind === 'otp' ? policy.otpMinutes : (policy.tokenMinutes[purpose] ?? 60);
    await client.query(
        `UPDATE auth_challenges SET superseded_at = now()
         WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND superseded_at IS NULL`,
        [userId, purpose],
    );
    const secretHash = kind === 'otp' ? otpHash(purpose, publicId, secret) : hashToken(purpose, secret);
    const result = await client.query(
        `INSERT INTO auth_challenges (public_id, user_id, purpose, kind, email, context, secret_hash, max_attempts, expires_at, request_ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8, now() + ($9 || ' minutes')::interval, $10)
         RETURNING expires_at`,
        [publicId, userId, purpose, kind, email, JSON.stringify(context), secretHash, policy.maxAttempts, String(minutes), ipHash],
    );
    return { secret, publicId, expiresAt: result.rows[0].expires_at, minutes };
};

// Verifies an OTP for a user+purpose (optionally a specific challenge by public id, and optionally
// required to match an address). Counts a failed attempt in the database. Returns
// { ok:true, challenge } or { ok:false, reason: 'INVALID' | 'EXPIRED' | 'LOCKED' }.
// The caller must run this inside a transaction and COMMIT even when ok is false, so the attempt
// counter persists. The same generic reason is returned whether or not a challenge exists.
export const verifyOtp = async (client, { userId, purpose, code, publicId = null, email = null }) => {
    const found = await client.query(
        `SELECT id, public_id, email, context, secret_hash, attempts, max_attempts, expires_at
         FROM auth_challenges
         WHERE user_id = $1 AND purpose = $2 AND kind = 'otp' AND consumed_at IS NULL AND superseded_at IS NULL
           AND ($3::uuid IS NULL OR public_id = $3)
         FOR UPDATE`,
        [userId, purpose, publicId],
    );
    const challenge = found.rows[0];
    const supplied = typeof code === 'string' && /^\d{6}$/.test(code) ? code : '000000';
    if (!challenge) {
        otpHash(purpose, randomUUID(), supplied); // keep timing similar
        return { ok: false, reason: 'INVALID' };
    }
    if (challenge.attempts >= challenge.max_attempts) return { ok: false, reason: 'LOCKED' };
    if (new Date(challenge.expires_at) <= new Date()) return { ok: false, reason: 'EXPIRED' };
    const matches = safeEqual(challenge.secret_hash, otpHash(purpose, challenge.public_id, supplied))
        && supplied === code && (email === null || challenge.email === email);
    if (!matches) {
        await client.query('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
        return { ok: false, reason: challenge.attempts + 1 >= challenge.max_attempts ? 'LOCKED' : 'INVALID' };
    }
    await client.query('UPDATE auth_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);
    return { ok: true, challenge };
};

// Consumes a single-use token (password reset). Returns { ok, challenge } like verifyOtp.
export const consumeToken = async (client, { purpose, token }) => {
    const supplied = typeof token === 'string' && token.length >= 20 && token.length <= 200 ? token : 'x';
    const found = await client.query(
        `SELECT id, user_id, email, context, expires_at FROM auth_challenges
         WHERE secret_hash = $1 AND purpose = $2 AND kind = 'token' AND consumed_at IS NULL AND superseded_at IS NULL
         FOR UPDATE`,
        [hashToken(purpose, supplied), purpose],
    );
    const challenge = found.rows[0];
    if (!challenge) return { ok: false, reason: 'INVALID' };
    if (new Date(challenge.expires_at) <= new Date()) return { ok: false, reason: 'EXPIRED' };
    await client.query('UPDATE auth_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);
    return { ok: true, challenge };
};

// Housekeeping: finished challenges older than a week.
export const purgeOldChallenges = (client) => client.query(
    `DELETE FROM auth_challenges WHERE created_at < now() - interval '7 days'`,
);
