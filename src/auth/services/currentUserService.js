import { pool } from '../../db/pool.js';

export const findCurrentUserById = async (userId) => {
    try {
        console.log('[CURRENT USER SERVICE]: Start Process - Finding current user by ID:', userId);
        const result = await pool.query('SELECT id, username, email, role_id  FROM users WHERE id = $1 AND is_disabled = false AND deleted_at IS NULL', [userId]);

        const user = result.rows[0];
     
        if (!user){
            console.log('[CURRENT USER SERVICE]: End Process - No current user found for ID:', userId);
            return null;
        }

        const responseObject = {
            id: user.id,
            username: user.username,
            email: user.email,
            role_id: user.role_id,
        }

        console.log('[CURRENT USER SERVICE]: End Process SUCCESS - Current user found:', responseObject);
        return responseObject;
    } catch (error) {
        console.error('[CURRENT USER SERVICE]: End Process - Error finding current user by ID:', error);
        throw new Error('Error finding current user by ID.');
    }
}