import bcrypt from 'bcrypt';
import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';

export const signupUserService = async (req, res, next) => {
    const { username, email, password } = req.body;

    let client;
    try {
        const hashedPassword = await bcrypt.hash(password, 12);
        client = await pool.connect();
        await client.query('BEGIN');
        const result = await client.query(
            `INSERT INTO users (username, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, email, username, created_at`,
            [username, email, hashedPassword]
        );

        const user = result.rows[0];
        // Account-level event: no tenant, and no email or credential material in the entry.
        await composeAuditLogs(auditLog({
            userId: user.id,
            action: 'SIGNUP',
            tableName: 'users',
            recordId: user.id,
            newData: { username: user.username },
        }), client);
        await client.query('COMMIT');

        const responseData = {
            id: user.id,
            username: user.username,
            email: user.email,
            createdAt: user.created_at,
        }

        return res.status(201).json({ message: 'User registered successfully.', responseData });
    } catch (error){
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (error.code === '23505') {
            return res.status(409).json({ message: 'An account with those details already exists.' });
        }
        return next(error);
    } finally {
        client?.release();
    }
};
