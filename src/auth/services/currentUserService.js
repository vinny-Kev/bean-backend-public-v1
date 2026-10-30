import { pool } from '../../db/pool.js';

export const findCurrentUserById = async (userId) => {
    const result = await pool.query(
        `SELECT id, username, email, full_name, role_id FROM users
         WHERE id = $1 AND is_disabled = false AND deleted_at IS NULL AND email_verified_at IS NOT NULL`,
        [userId],
    );

    const user = result.rows[0];
    if (!user) return null;

    return {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        roleId: user.role_id,
    };
};

// Account-level permissions from the user's role, read the same way requirePermission checks them.
export const findAccountPermissions = async (userId) => {
    const result = await pool.query(
        `SELECT p.name FROM users u
         JOIN role_permissions rp ON rp.role_id = u.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE u.id = $1 ORDER BY p.name`,
        [userId],
    );
    return result.rows.map((row) => row.name);
};
