import { pool } from '../../db/pool.js';
import { findMembershipRole } from '../../tenants/middleware/tenantAccessMiddleware.js';
import { tenantRoleHasPermission } from '../../tenants/tenantPermissions.js';
import { parsePositiveId } from '../../util/validations.js';

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


// ---- Tenant-aware permission check ---------------------------------------------------------------
// requireAccess(permission, tenantFrom): passes when the account role grants `permission` (existing
// behavior), OR the account has no role / the default "standard" role AND its membership role in the
// tenant named by the request grants it (src/tenants/tenantPermissions.js). The tenant is only used to look up the caller's own membership.
export const tenantFromParam = (name) => async (req) => parsePositiveId(req.params[name]);
export const tenantFromQuery = (name) => async (req) => parsePositiveId(req.query[name]);
export const tenantFromBody = (name) => async (req) => parsePositiveId(String(req.body?.[name] ?? ''));
export const tenantFromIntegration = (name = 'integration_id') => async (req) => {
    const id = parsePositiveId(req.params[name]);
    if (!id) return null;
    const row = await pool.query('SELECT tenant_id FROM integrated_apps WHERE id = $1', [id]);
    return row.rows[0] ? Number(row.rows[0].tenant_id) : null;
};

export const requireAccess = (permission, tenantFrom) => async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ message: 'Unauthorized.' });
    try {
        const account = await pool.query(
            `SELECT r.name AS role_name,
                    EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                            WHERE rp.role_id = u.role_id AND p.name = $2) AS ok
             FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
            [req.user.id, permission],
        );
        const { ok, role_name: roleName } = account.rows[0] ?? {};
        if (ok) return next();
        // Only accounts that rely on membership (no role, or the default "standard" role) get tenant-derived
        // permissions. An account with any other role keeps exactly its account-level permissions, so a
        // deliberately read-only role is never elevated by being an organization admin.
        if (roleName === null || roleName === 'standard') {
            const tenantId = await tenantFrom(req);
            if (tenantId && tenantRoleHasPermission(await findMembershipRole(pool, tenantId, req.user.id), permission)) return next();
        }
        const message = 'Forbidden: You do not have the required permissions.';
        return res.status(403).json({ message, error: { code: 'PERMISSION_REQUIRED', message } });
    } catch (error) {
        return next(error);
    }
};
