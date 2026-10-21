import { pool } from '../db/pool.js';

export const composeAuditLogs = async (
    auditLog, client = pool
) => {
    try {    
    console.log("[AUDIT LOG SERVICE]: Start Process - Composing audit log entry:");
    await client.query(
        `INSERT INTO audit_logs (
            user_id,
            action,
            table_name,
            record_id,
            old_data,
            new_data,
            created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            auditLog.userId,
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

export const getAuditLogs = async (req, res, next) => {
    try {
        console.log("[AUDIT LOG SERVICE]: Start Process - Retrieving audit logs.");

        const pagination = req.pagination;
        const hasPagination = Boolean(pagination);
        const { page, limit, offset } = pagination ?? {};

        const query = `
            SELECT id, user_id, action, table_name, record_id, old_data, new_data, created_at
            FROM audit_logs
            ORDER BY created_at DESC, id DESC
            ${hasPagination ? 'LIMIT $1 OFFSET $2' : ''}
        `;
        const result = hasPagination
            ? await pool.query(query, [limit, offset])
            : await pool.query(query);

        if (result.rows.length === 0) {
            console.log("[AUDIT LOG SERVICE]: End Process - No audit logs found.");
            const countResult = hasPagination
                ? await pool.query('SELECT COUNT(*)::int AS total FROM audit_logs')
                : null;
            const total = countResult?.rows[0].total ?? 0;
            return res.status(200).json({
                message: 'No audit logs found.',
                data: [],
                ...(hasPagination && {
                    pagination: {
                        ...(page !== undefined && { page }),
                        limit,
                        offset,
                        total,
                        totalPages: Math.ceil(total / limit),
                        hasMore: false,
                    },
                }),
            });
        }

        const responseObject = result.rows.map(item => ({
            id: item.id,
            userId: item.user_id,
            action: item.action,
            tableName: item.table_name,
            recordId: item.record_id,
            oldData: item.old_data,
            newData: item.new_data,
            createdAt: item.created_at,
        }))

        if (hasPagination) {
            const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM audit_logs');
            const total = countResult.rows[0].total;

            return res.status(200).json({
                message: 'Audit logs retrieved successfully.',
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

        return res.status(200).json({ message: 'Audit logs retrieved successfully.', data: responseObject });
    } catch (error) {
        return next(error);
    }
}
