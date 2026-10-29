import { compareToPattern, inRangeOfLength, isPlainObject } from '../../util/validations.js';
import { isValidEmail, isValidFullName, isValidNewPassword, normalizeEmail, normalizeFullName, passwordMessage } from '../../identity/identityHelpers.js';
import { pool } from '../../db/pool.js';
import bcrypt from 'bcrypt';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';

export const validateSignupData = (req, res, next) => {
    const body = req.body;
    if (!isPlainObject(body)) {
        return res.status(400).json({ message: 'A JSON object is required.' });
    }

    const fullName = normalizeFullName(body.fullName);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const email = normalizeEmail(body.email);
    const password = body.password;

    if (!isValidFullName(fullName)) {
        return res.status(400).json({ message: 'Enter your full name (2 to 100 characters, letters, spaces, hyphens and apostrophes).' });
    }
    if (!username || !compareToPattern(username, 'alphanumeric') || !inRangeOfLength(username, 3, 20)) {
        return res.status(400).json({ message: 'Username must be 3 to 20 alphanumeric characters.' });
    }
    if (!isValidEmail(email)) {
        return res.status(400).json({ message: 'A valid email address is required.' });
    }
    if (!isValidNewPassword(password)) {
        return res.status(400).json({ message: passwordMessage });
    }

    // Existence is decided inside the signup transaction (unique indexes), not here, so a
    // concurrent duplicate cannot slip through and the response cannot reveal registered emails.
    req.body = { fullName, username, email, password };
    return next();
};

export const validateLoginData = async (req, res, next) => {
    const body = req.body;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = body?.password;
    if (!email || email.length > 254 || typeof password !== 'string'
        || !password || Buffer.byteLength(password, 'utf8') > 72) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    try {
        const result = await pool.query(
            `SELECT id, email, username, full_name, email_verified_at, password_hash, role_id
             FROM users
             WHERE LOWER(email) = $1 AND is_disabled = false AND deleted_at IS NULL`,
            [email],
        );
        const user = result.rows[0];
        const valid = user ? await bcrypt.compare(password, user.password_hash) : false;

        if (!valid) {
            // Only failures against a real account are recorded, so anonymous guessing cannot
            // grow the audit table. The entry holds no email or password. A failed audit write
            // must not change the (generic) response.
            if (user) {
                await composeAuditLogs(auditLog({
                    userId: user.id,
                    action: 'LOGIN_FAILURE',
                    tableName: 'session',
                    recordId: user.id,
                    newData: { reason: 'invalid_credentials' },
                })).catch(() => {
                    console.error(JSON.stringify({ event: 'login_failure_audit_failed', requestId: req.requestId }));
                });
            }
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        if (!user.email_verified_at) {
            // Correct password, but the address was never proven: no session until it is.
            return res.status(403).json({ error: { code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email address to sign in.', requestId: req.requestId } });
        }
        req.user = {
            id: user.id,
            email: user.email,
            username: user.username,
            fullName: user.full_name,
            roleId: user.role_id,
        };
        return next();
    } catch (error) {
        return next(error);
    }
};
