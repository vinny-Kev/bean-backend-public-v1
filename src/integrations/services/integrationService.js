import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
export const getTenantIntegrations = async (req, res, next) => {
    try {
        const tenantId = Number(req.params.tenant_id);
        if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
            return res.status(400).json({ message: 'A valid tenant_id is required.' });
        }

        const pagination = req.pagination;
        const hasPagination = Boolean(pagination);
        const { page, limit, offset } = pagination ?? {};
        const sql = `
                SELECT
                    ia.id,
                    ia.tenant_id,
                    ia.name,
                    ia.description,
                    ia.status,
                    ia.created_by_user_id,
                    ia.last_event_at,
                    ia.created_at,
                    ia.updated_at,
                    ia.app_url,
                    ia.webhook_url
                FROM integrated_apps ia
                INNER JOIN tenant_members tm
                    ON tm.tenant_id = ia.tenant_id
                WHERE tm.user_id = $1
                ORDER BY ia.created_at DESC, ia.id DESC
                ${hasPagination ? 'LIMIT $2 OFFSET $3' : ''}
            `;
                
            const params = hasPagination
                ? [req.user.id, limit, offset]
                : [req.user.id];
                
const result = await pool.query(sql, params);

        if (result.rows.length > 0) {
            const auditEntry = auditLog({
                userId: req.user.id,
                action: 'GET TENANT INTEGRATIONS',
                tableName: 'integrations',
                recordId: null,
                oldData: null,
                newData: result.rows,
            });

            // Audit logging should not make a successful read fail (same policy as inventory reads).
            try {
                await composeAuditLogs(auditEntry);
            } catch {
                console.error(JSON.stringify({
                    event: 'integration_read_audit_failed',
                    requestId: req.requestId,
                }));
            }
        }

        const data = result.rows.map(row => ({
            id: row.id,
            tenantId: row.tenant_id,
            name: row.name,
            description: row.description,
            status: row.status,
            createdByUserId: row.created_by_user_id,
            lastEventAt: row.last_event_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            appUrl: row.app_url,
            webhookUrl: row.webhook_url,
        }));

        if (hasPagination) {
            const countResult = await pool.query(
                'SELECT COUNT(*)::int AS total FROM integrated_apps WHERE tenant_id = $1',
                [tenantId],
            );
            const total = countResult.rows[0].total;

            return res.status(200).json({
                data,
                message: data.length
                    ? 'Tenant integrations retrieved successfully.'
                    : 'No integrations found for tenant.',
                pagination: {
                    ...(page !== undefined && { page }),
                    limit,
                    offset,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasMore: offset + data.length < total,
                },
            });
        }

        return res.status(200).json({
            data,
            message: data.length
                ? 'Tenant integrations retrieved successfully.'
                : 'No integrations found for tenant.',
        });
    } catch (error) {
        return next(error);
    }
};
