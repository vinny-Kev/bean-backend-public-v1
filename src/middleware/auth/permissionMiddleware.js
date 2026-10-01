import { pool } from '../../db/pool.js';

export const requirePermission = (requiredPermission) => {
    return async (req, res, next) => {
        try {
            console.log("[PERMISSION MIDDLEWARE]: Start Process - Checking permissions for user:", { userId: req.user.id, requiredPermission });

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
                console.log("[PERMISSION MIDDLEWARE]: End Process - User does not have required permissions.");
                return res.status(403).json({ message: 'Forbidden: You do not have the required permissions.' });
            }

                return next();

        } catch (error) {
            console.error("[PERMISSION MIDDLEWARE]: End Process - Error during permission check:", error);
            return res.status(500).json({ message: 'Internal server error during permission check.' });
        }
    }
};