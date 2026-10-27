import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { compareToPattern, inRangeOfLength, isPlainObject } from '../../util/validations.js';

// Any authenticated, active user may create an organization and becomes its owner.
// Tenant-scoped authority afterwards comes only from tenant_members.
export const createTenant = async (req, res, next) => {
    const body = req.body;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    if (!isPlainObject(body)
        || Object.keys(body).some((key) => !['name', 'slug'].includes(key))
        || !inRangeOfLength(name, 1, 255) || !inRangeOfLength(slug, 3, 100) || !compareToPattern(slug, 'slug')) {
        return res.status(400).json({ error: { code: 'INVALID_TENANT',
            message: 'Provide a name (1-255 characters) and a lowercase slug (3-100 characters, letters, digits and single hyphens).' } });
    }
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const tenant = await client.query(
            `INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id, name, slug, status, created_at`, [name, slug],
        );
        const created = tenant.rows[0];
        await client.query(
            `INSERT INTO tenant_members (tenant_id, user_id, membership_role) VALUES ($1,$2,'owner')`, [created.id, req.user.id],
        );
        await composeAuditLogs(auditLog({ userId: req.user.id, action: 'CREATE TENANT', tableName: 'tenants',
            recordId: created.id, newData: { name, slug, ownerUserId: req.user.id } }), client);
        await client.query('COMMIT');
        return res.status(201).json({ message: 'Tenant created.', data: {
            id: created.id, name: created.name, slug: created.slug, status: created.status,
            membershipRole: 'owner', createdAt: created.created_at,
        } });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (error.code === '23505' && error.constraint === 'tenants_slug_key') {
            return res.status(409).json({ error: { code: 'TENANT_SLUG_TAKEN', message: 'That tenant slug is already in use.' } });
        }
        return next(error);
    } finally { client?.release(); }
};

export const listMyTenants = async (req, res, next) => {
    try {
        const result = await pool.query(
            `SELECT t.id, t.name, t.slug, t.status, tm.membership_role, tm.created_at AS joined_at
             FROM tenant_members tm JOIN tenants t ON t.id=tm.tenant_id
             WHERE tm.user_id=$1 AND t.status<>'deleted' ORDER BY t.name, t.id`, [req.user.id],
        );
        return res.status(200).json({ message: 'Tenants retrieved successfully.', data: result.rows.map((row) => ({
            id: row.id, name: row.name, slug: row.slug, status: row.status,
            membershipRole: row.membership_role, joinedAt: row.joined_at,
        })) });
    } catch (error) { return next(error); }
};
