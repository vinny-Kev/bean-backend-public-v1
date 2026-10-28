import { pool } from '../../db/pool.js';

export const requirePermission = (requiredPermission) => {
    return async (req, res, next) => {
        if (!req.user?.id) {
            return res.status(401).json({ message: 'Unauthorized.' });
        }
        try {
            const requiredPermissions = Array.isArray(requiredPermission)
                 ? requiredPermission 
                 : [requiredPermission];

            if(requiredPermissions.length ===0) {
                return res.status(403).json({message: 'At least one permission is required.'})
            }

            const result =  await pool.query(`
                SELECT NOT EXISTS (
                    SELECT 1
                    FROM unnest($2::text[]) AS required(permission_name)
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM users u
                        JOIN role_permissions rp
                            ON rp.role_id = u.role_id
                        JOIN permissions p
                            ON p.id = rp.permission_id
                        WHERE u.id = $1
                          AND p.name = required.permission_name
                    )
                ) AS has_all_permissions
            `,
            [
                req.user.id,
                requiredPermissions
            ]);

 
            if (!result.rows[0].has_all_permissions) {
                // `message` is the original contract; `error` adds the common shape and a stable code.
                const message = 'Forbidden: You do not have the required permissions.';
                return res.status(403).json({ message, error: { code: 'PERMISSION_REQUIRED', message } });
            }

            return next();

        } catch (error) {
            return next(error);
        }
    }
};
