import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { INVENTORY_SHORTAGE_POLICIES } from './integrationPolicy.js';
import { parsePositiveId } from '../../util/validations.js';
import { findMembershipRole } from '../../tenants/middleware/tenantAccessMiddleware.js';

const requireTenantAdmin = async (tenantId, userId) => ['owner', 'admin'].includes(await findMembershipRole(pool, tenantId, userId));

export const getIntegrationSettings = async (req, res, next) => {
    try {
        const tenantId = parsePositiveId(req.params.tenant_id);
        if (!tenantId) return res.status(400).json({ message: 'A valid tenant ID is required.' });
        if (!await requireTenantAdmin(tenantId, req.user.id)) return res.status(403).json({ message: 'Tenant administrator access is required.' });
        const result = await pool.query('SELECT inventory_shortage_policy, updated_at FROM tenant_integration_settings WHERE tenant_id=$1', [tenantId]);
        return res.status(200).json({ message: 'Integration settings retrieved successfully.', data: {
            tenantId, inventoryShortagePolicy: result.rows[0]?.inventory_shortage_policy ?? 'require_intervention',
            updatedAt: result.rows[0]?.updated_at ?? null,
        } });
    } catch (error) { return next(error); }
};

export const updateInventoryShortagePolicy = async (req, res, next) => {
    const tenantId = parsePositiveId(req.params.tenant_id);
    const policy = req.body?.inventoryShortagePolicy;
    if (!tenantId || Object.keys(req.body ?? {}).length !== 1 || !INVENTORY_SHORTAGE_POLICIES.includes(policy)) {
        return res.status(400).json({ message: 'Provide exactly one supported inventoryShortagePolicy value.' });
    }
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const member = await client.query(
            `SELECT tm.membership_role FROM tenant_members tm JOIN tenants t ON t.id=tm.tenant_id
             WHERE tm.tenant_id=$1 AND tm.user_id=$2 AND t.status<>'deleted' FOR SHARE OF tm`, [tenantId, req.user.id],
        );
        if (!['owner', 'admin'].includes(member.rows[0]?.membership_role)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'Tenant administrator access is required.' });
        }
        const result = await client.query(
            `INSERT INTO tenant_integration_settings (tenant_id, inventory_shortage_policy, updated_by_user_id)
             VALUES ($1,$2,$3)
             ON CONFLICT (tenant_id) DO UPDATE SET inventory_shortage_policy=EXCLUDED.inventory_shortage_policy,
                updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=NOW()
             RETURNING inventory_shortage_policy,updated_at`, [tenantId, policy, req.user.id],
        );
        await client.query(
            `INSERT INTO integration_lifecycle_activity
                (tenant_id, integrated_app_id, actor_user_id, action, outcome, correlation_id)
             SELECT tenant_id,id,$2,'inventory.shortage_policy.updated','succeeded',$3
             FROM integrated_apps WHERE tenant_id=$1`, [tenantId, req.user.id, req.requestId],
        );
        await composeAuditLogs(auditLog({ userId: req.user.id, tenantId, action: 'UPDATE INTEGRATION INVENTORY POLICY',
            tableName: 'tenant_integration_settings', recordId: tenantId,
            newData: { tenantId, inventoryShortagePolicy: policy } }), client);
        await client.query('COMMIT');
        return res.status(200).json({ message: 'Inventory shortage policy updated successfully.', data: {
            tenantId, inventoryShortagePolicy: result.rows[0].inventory_shortage_policy,
            updatedAt: result.rows[0].updated_at,
        } });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally { client?.release(); }
};
