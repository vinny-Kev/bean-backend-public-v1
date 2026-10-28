import { compareToPattern, inRangeOfLength, isPlainObject } from '../../util/validations.js';
import { pool } from '../../db/pool.js';
import bcrypt from 'bcrypt';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';

export const validateSignupData = async (req, res, next) => {
    const body = req.body;
    if (!isPlainObject(body)) {
        return res.status(400).json({ message: 'A JSON object is required.' });
    }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = body.password;

    if (!username || !compareToPattern(username, 'alphanumeric') || !inRangeOfLength(username, 3, 20)) {
        return res.status(400).json({ message: 'Username must be 3 to 20 alphanumeric characters.' });
    }
    if (!email || email.length > 254 || !compareToPattern(email, 'email')) {
        return res.status(400).json({ message: 'A valid email address is required.' });
    }
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72
        || !compareToPattern(password, 'password') || !inRangeOfLength(password, 8, 20)) {
        return res.status(400).json({
            message: 'Password must be 8 to 20 characters, include upper and lower case letters, a number and a symbol, and use at most 72 UTF-8 bytes.',
        });
    }

    try {
        const existing = await pool.query(
            'SELECT EXISTS (SELECT 1 FROM users WHERE LOWER(email) = $1 OR LOWER(username) = LOWER($2)) AS exists',
            [email, username],
        );
        if (existing.rows[0].exists) {
            return res.status(409).json({ message: 'An account with those details already exists.' });
        }

        req.body = { username, email, password };
        return next();
    } catch (error) {
        return next(error);
    }
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
            `SELECT id, email, username, password_hash, role_id
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

        req.user = {
            id: user.id,
            email: user.email,
            username: user.username,
            roleId: user.role_id,
        };
        return next();
    } catch (error) {
        return next(error);
    }
};
