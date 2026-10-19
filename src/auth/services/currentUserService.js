import { pool } from '../../db/pool.js';

export const findCurrentUserById = async (userId) => {
    const result = await pool.query(
        'SELECT id, username, email, role_id FROM users WHERE id = $1 AND is_disabled = false AND deleted_at IS NULL',
        [userId],
    );

    const user = result.rows[0];
    if (!user) return null;

    return {
        id: user.id,
        username: user.username,
        email: user.email,
        roleId: user.role_id,
    };
};
