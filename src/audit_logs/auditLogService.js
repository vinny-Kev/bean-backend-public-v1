import { pool } from '../db/pool.js';

export const composeAuditLogs = async (
    auditLog, client = pool
) => {
    try {
    console.log("[AUDIT LOG SERVICE]: Start Process - Composing audit log entry:");
    await client.query(
        `INSERT INTO audit_logs (
            user_id,
            tenant_id,
            action,
            table_name,
            record_id,
            old_data,
            new_data,
            created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            auditLog.userId,
            auditLog.tenantId,
            auditLog.action,
            auditLog.tableName,
            auditLog.recordId,
            auditLog.oldData,
            auditLog.newData,
            auditLog.created_at
        ]
        );

        return true;
    } catch (error) {
        throw error;
    }
}

// Lists audit entries newest first. With a tenantId only that tenant's entries are read
// (rows, count and pagination alike); without one the listing is global, so the route
// must restrict it to platform operators.
const listAuditLogs = ({ tenantScoped }) => async (req, res, next) => {
    try {
        console.log("[AUDIT LOG SERVICE]: Start Process - Retrieving audit logs.");

        const pagination = req.pagination;
        const hasPagination = Boolean(pagination);
        const { page, limit, offset } = pagination ?? {};
        const where = tenantScoped ? 'WHERE tenant_id = $1' : '';
        const scope = tenantScoped ? [req.tenant.id] : [];

        const query = `
            SELECT id, user_id, tenant_id, action, table_name, record_id, old_data, new_data, created_at
            FROM audit_logs
            ${where}
            ORDER BY created_at DESC, id DESC
            ${hasPagination ? `LIMIT $${scope.length + 1} OFFSET $${scope.length + 2}` : ''}
        `;
        const result = await pool.query(query, hasPagination ? [...scope, limit, offset] : scope);

        const responseObject = result.rows.map(item => ({
            id: item.id,
            userId: item.user_id,
            tenantId: item.tenant_id,
            action: item.action,
            tableName: item.table_name,
            recordId: item.record_id,
            oldData: item.old_data,
            newData: item.new_data,
            createdAt: item.created_at,
        }))
        const message = responseObject.length ? 'Audit logs retrieved successfully.' : 'No audit logs found.';

        if (hasPagination) {
            const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM audit_logs ${where}`, scope);
            const total = countResult.rows[0].total;

            return res.status(200).json({
                message,
                data: responseObject,
                pagination: {
                    ...(page !== undefined && { page }),
                    limit,
                    offset,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasMore: offset + responseObject.length < total,
                },
            });
        }

        return res.status(200).json({ message, data: responseObject });
    } catch (error) {
        return next(error);
    }
}

export const getAuditLogs = listAuditLogs({ tenantScoped: false });
export const getTenantAuditLogs = listAuditLogs({ tenantScoped: true });
