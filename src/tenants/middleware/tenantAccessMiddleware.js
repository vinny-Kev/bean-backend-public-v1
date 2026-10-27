import { pool } from '../../db/pool.js';
import { parsePositiveId } from '../../util/validations.js';

export const TENANT_ROLES = Object.freeze(['owner', 'admin', 'member']);

// Resolves :tenant_id against the caller's membership. The URL value only selects a
// tenant; authority comes from tenant_members. Non-members (and deleted tenants) get
// 404 so tenant IDs cannot be probed. Services that change membership re-check the
// caller's role under a tenant lock, since this snapshot can be stale.
export const requireTenantMember = ({ roles = null, requireActive = false } = {}) => async (req, res, next) => {
    const tenantId = parsePositiveId(req.params.tenant_id);
    if (!tenantId) return res.status(400).json({ error: { code: 'INVALID_TENANT_ID', message: 'A valid tenant ID is required.' } });
    try {
        const result = await pool.query(
            `SELECT t.id, t.name, t.slug, t.status, t.created_at, t.updated_at, tm.membership_role, tm.created_at AS joined_at
             FROM tenants t JOIN tenant_members tm ON tm.tenant_id=t.id AND tm.user_id=$2
             WHERE t.id=$1 AND t.status<>'deleted'`,
            [tenantId, req.user.id],
        );
        const tenant = result.rows[0];
        if (!tenant) return res.status(404).json({ error: { code: 'TENANT_NOT_FOUND', message: 'Tenant not found.' } });
        if (roles && !roles.includes(tenant.membership_role)) {
            return res.status(403).json({ error: { code: 'TENANT_ROLE_REQUIRED',
                message: `This action requires one of these tenant roles: ${roles.join(', ')}.` } });
        }
        if (requireActive && tenant.status !== 'active') {
            return res.status(409).json({ error: { code: 'TENANT_INACTIVE', message: 'This tenant is not active.' } });
        }
        req.tenant = { id: Number(tenant.id), name: tenant.name, slug: tenant.slug, status: tenant.status,
            membershipRole: tenant.membership_role, joinedAt: tenant.joined_at, createdAt: tenant.created_at, updatedAt: tenant.updated_at };
        return next();
    } catch (error) { return next(error); }
};
