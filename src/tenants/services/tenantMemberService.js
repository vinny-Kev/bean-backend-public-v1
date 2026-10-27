import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { compareToPattern, inRangeOfLength, isPlainObject, parsePositiveId } from '../../util/validations.js';
import { TENANT_ROLES } from '../middleware/tenantAccessMiddleware.js';

// Membership rules
// - owner: add members with any role, change any other member's role, remove any other member.
// - admin: add and remove plain members only; cannot grant or change roles.
// - member: no membership changes, but may leave the tenant.
// - Nobody can change their own role, and a tenant always keeps at least one owner.
//   Ownership transfer is two steps: an owner promotes another member to owner, then
//   the previous owner leaves or is demoted by the new owner.

const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
const roleRank = `CASE tm.membership_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END`;

const memberView = (row) => ({
    userId: row.user_id, username: row.username, email: row.email, membershipRole: row.membership_role,
    joinedAt: row.joined_at, accountStatus: row.deleted_at ? 'deleted' : row.is_disabled ? 'disabled' : 'active',
});
const memberColumns = `tm.user_id, u.username, u.email, tm.membership_role, tm.created_at AS joined_at, u.is_disabled, u.deleted_at`;

// Runs a membership change with the tenant row locked and the caller's role re-read under the lock.
const withLockedTenant = async (req, res, next, work) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT t.status, tm.membership_role FROM tenants t
             LEFT JOIN tenant_members tm ON tm.tenant_id=t.id AND tm.user_id=$2
             WHERE t.id=$1 FOR UPDATE OF t`, [req.tenant.id, req.user.id],
        );
        const actorRole = locked.rows[0]?.membership_role;
        const outcome = !actorRole ? fail(404, 'TENANT_NOT_FOUND', 'Tenant not found.')
            : locked.rows[0].status !== 'active' ? fail(409, 'TENANT_INACTIVE', 'Membership cannot change while the tenant is not active.')
                : await work(client, actorRole);
        await client.query(outcome.status < 300 ? 'COMMIT' : 'ROLLBACK');
        return res.status(outcome.status).json(outcome.body);
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        // 23001: ON DELETE RESTRICT (mappings, commissions, referrals); 23503: NO ACTION foreign keys.
        if (['23001', '23503'].includes(error.code)) {
            return res.status(409).json({ error: { code: 'MEMBER_HAS_LINKED_RECORDS',
                message: 'This member is referenced by integration user mappings, sales, or commissions and cannot be removed.' } });
        }
        return next(error);
    } finally { client?.release(); }
};

const countOwners = async (client, tenantId) => Number((await client.query(
    `SELECT COUNT(*) FROM tenant_members WHERE tenant_id=$1 AND membership_role='owner'`, [tenantId])).rows[0].count);

const audit = (client, req, action, targetUserId, oldRole, newRole) => composeAuditLogs(auditLog({
    userId: req.user.id, action, tableName: 'tenant_members', recordId: targetUserId,
    oldData: oldRole ? { tenantId: req.tenant.id, userId: targetUserId, membershipRole: oldRole } : null,
    newData: newRole ? { tenantId: req.tenant.id, userId: targetUserId, membershipRole: newRole } : null,
}), client);

export const getTenant = async (req, res, next) => {
    try {
        const members = await pool.query('SELECT COUNT(*)::int AS count FROM tenant_members WHERE tenant_id=$1', [req.tenant.id]);
        const { id, name, slug, status, membershipRole, joinedAt, createdAt, updatedAt } = req.tenant;
        return res.status(200).json({ message: 'Tenant retrieved successfully.', data: {
            id, name, slug, status, membershipRole, joinedAt, memberCount: members.rows[0].count, createdAt, updatedAt,
        } });
    } catch (error) { return next(error); }
};

export const listTenantMembers = async (req, res, next) => {
    try {
        const pagination = req.pagination ?? { limit: 20, offset: 0 };
        const count = await pool.query('SELECT COUNT(*)::int AS total FROM tenant_members WHERE tenant_id=$1', [req.tenant.id]);
        const rows = await pool.query(
            `SELECT ${memberColumns} FROM tenant_members tm JOIN users u ON u.id=tm.user_id
             WHERE tm.tenant_id=$1 ORDER BY ${roleRank}, tm.created_at, tm.user_id LIMIT $2 OFFSET $3`,
            [req.tenant.id, pagination.limit, pagination.offset],
        );
        const total = count.rows[0].total;
        return res.status(200).json({ message: 'Tenant members retrieved successfully.', data: rows.rows.map(memberView),
            pagination: { ...(pagination.page !== undefined && { page: pagination.page }), limit: pagination.limit,
                offset: pagination.offset, total, totalPages: Math.ceil(total / pagination.limit),
                hasMore: pagination.offset + rows.rowCount < total } });
    } catch (error) { return next(error); }
};

export const getTenantMember = async (req, res, next) => {
    const userId = parsePositiveId(req.params.user_id);
    if (!userId) return res.status(400).json({ error: { code: 'INVALID_USER_ID', message: 'A valid user ID is required.' } });
    try {
        const row = (await pool.query(
            `SELECT ${memberColumns} FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=$1 AND tm.user_id=$2`,
            [req.tenant.id, userId])).rows[0];
        if (!row) return res.status(404).json({ error: { code: 'MEMBER_NOT_FOUND', message: 'Member not found.' } });
        return res.status(200).json({ message: 'Tenant member retrieved successfully.', data: memberView(row) });
    } catch (error) { return next(error); }
};

export const addTenantMember = (req, res, next) => {
    const body = req.body;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : null;
    const username = typeof body?.username === 'string' ? body.username.trim() : null;
    const role = body?.role ?? 'member';
    if (!isPlainObject(body) || Object.keys(body).some((key) => !['email', 'username', 'role'].includes(key))
        || (email === null) === (username === null)
        || (email !== null && (email.length > 254 || !compareToPattern(email, 'email')))
        || (username !== null && (!compareToPattern(username, 'alphanumeric') || !inRangeOfLength(username, 3, 20)))
        || !TENANT_ROLES.includes(role)) {
        return res.status(400).json({ error: { code: 'INVALID_MEMBER',
            message: 'Provide exactly one of email or username for an existing account, and an optional role (owner, admin, member).' } });
    }
    return withLockedTenant(req, res, next, async (client, actorRole) => {
        if (!['owner', 'admin'].includes(actorRole)) return fail(403, 'TENANT_ROLE_REQUIRED', 'Only tenant owners and admins can add members.');
        if (actorRole !== 'owner' && role !== 'member') return fail(403, 'OWNER_REQUIRED', 'Only tenant owners can grant the owner or admin role.');
        const user = (await client.query(
            `SELECT id FROM users WHERE ${email !== null ? 'LOWER(email)=$1' : 'LOWER(username)=LOWER($1)'}
             AND is_disabled=false AND deleted_at IS NULL`, [email ?? username])).rows[0];
        if (!user) return fail(404, 'USER_NOT_FOUND', 'No active account matches that identifier.');
        const inserted = await client.query(
            `INSERT INTO tenant_members (tenant_id, user_id, membership_role) VALUES ($1,$2,$3)
             ON CONFLICT (tenant_id, user_id) DO NOTHING RETURNING user_id`, [req.tenant.id, user.id, role]);
        if (!inserted.rowCount) return fail(409, 'ALREADY_MEMBER', 'That account is already a member of this tenant.');
        await audit(client, req, 'ADD TENANT MEMBER', user.id, null, role);
        const row = (await client.query(
            `SELECT ${memberColumns} FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=$1 AND tm.user_id=$2`,
            [req.tenant.id, user.id])).rows[0];
        return { status: 201, body: { message: 'Member added.', data: memberView(row) } };
    });
};

export const updateTenantMemberRole = (req, res, next) => {
    const userId = parsePositiveId(req.params.user_id);
    const role = req.body?.role;
    if (!userId || !isPlainObject(req.body) || Object.keys(req.body).some((key) => key !== 'role') || !TENANT_ROLES.includes(role)) {
        return res.status(400).json({ error: { code: 'INVALID_ROLE_CHANGE', message: 'Provide a valid user ID and a role (owner, admin, member).' } });
    }
    return withLockedTenant(req, res, next, async (client, actorRole) => {
        if (userId === Number(req.user.id)) return fail(403, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role.');
        if (actorRole !== 'owner') return fail(403, 'OWNER_REQUIRED', 'Only tenant owners can change member roles.');
        const target = (await client.query(
            'SELECT membership_role FROM tenant_members WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [req.tenant.id, userId])).rows[0];
        if (!target) return fail(404, 'MEMBER_NOT_FOUND', 'Member not found.');
        if (target.membership_role === 'owner' && role !== 'owner' && await countOwners(client, req.tenant.id) <= 1) {
            return fail(409, 'LAST_OWNER', 'A tenant must keep at least one owner. Promote another owner first.');
        }
        if (target.membership_role !== role) {
            await client.query('UPDATE tenant_members SET membership_role=$3 WHERE tenant_id=$1 AND user_id=$2', [req.tenant.id, userId, role]);
            await audit(client, req, 'UPDATE TENANT MEMBER ROLE', userId, target.membership_role, role);
        }
        const row = (await client.query(
            `SELECT ${memberColumns} FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=$1 AND tm.user_id=$2`,
            [req.tenant.id, userId])).rows[0];
        return { status: 200, body: { message: target.membership_role === role ? 'Role unchanged.' : 'Member role updated.', data: memberView(row) } };
    });
};

export const removeTenantMember = (req, res, next) => {
    const userId = parsePositiveId(req.params.user_id);
    if (!userId) return res.status(400).json({ error: { code: 'INVALID_USER_ID', message: 'A valid user ID is required.' } });
    return withLockedTenant(req, res, next, async (client, actorRole) => {
        const leaving = userId === Number(req.user.id);
        const target = (await client.query(
            'SELECT membership_role FROM tenant_members WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [req.tenant.id, userId])).rows[0];
        if (!target) return fail(404, 'MEMBER_NOT_FOUND', 'Member not found.');
        if (!leaving) {
            if (!['owner', 'admin'].includes(actorRole)) return fail(403, 'TENANT_ROLE_REQUIRED', 'Only tenant owners and admins can remove members.');
            if (actorRole === 'admin' && target.membership_role !== 'member') return fail(403, 'OWNER_REQUIRED', 'Only tenant owners can remove owners or admins.');
        }
        if (target.membership_role === 'owner' && await countOwners(client, req.tenant.id) <= 1) {
            return fail(409, 'LAST_OWNER', 'A tenant must keep at least one owner. Transfer ownership first.');
        }
        await client.query('DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2', [req.tenant.id, userId]);
        await audit(client, req, 'REMOVE TENANT MEMBER', userId, target.membership_role, null);
        return { status: 200, body: { message: leaving ? 'You left the tenant.' : 'Member removed.', data: { userId, removed: true } } };
    });
};
