import { pool } from '../db/pool.js';

export const composeAuditLogs = async (
    auditLog, client = pool
) => {
    try {    
    console.log("[AUDIT LOG SERVICE]: Start Process - Composing audit log entry:", auditLog);
    const result = await client.query(
        `INSERT INTO audit_logs (
            user_id,
            action,
            table_name,
            record_id,
            old_data,
            new_data,
            created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
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

    return result.rows[0];
    } catch (error) {
        console.log("[AUDIT LOG SERVICE]: End Process - Error during composing audit log entry:", error);
        throw error;
    }
}