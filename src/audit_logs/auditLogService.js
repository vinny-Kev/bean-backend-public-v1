import { pool } from '../db/pool.js';

export const composeAuditLogs = async (
    auditLog, client = pool
) => {
    try {    
    console.log("[AUDIT LOG SERVICE]: Start Process - Composing audit log entry:");
    const result = await client.query(
        `INSERT INTO audit_logs (
            user_id,
            action,
            table_name,
            record_id,
            old_data,
            new_data,
            created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING 
         id, user_id, action, table_name, record_id, old_data, new_data, created_at`,
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

        const auditEntry = result.rows[0];

        const responseData = {
            userId: auditEntry.user_id,
            action: auditEntry.action,
            tableName: auditEntry.table_name,
            recordId: auditEntry.record_id,
            oldData: auditEntry.old_data,
            newData: auditEntry.new_data,
            createdAt: auditEntry.created_at,
        }
        
        console.log("[AUDIT LOG SERVICE]: End Process SUCCESS - Audit log entry created successfully:", responseData);
        return responseData;
    } catch (error) {
        console.log("[AUDIT LOG SERVICE]: End Process - Error during composing audit log entry:", error);
        throw error;
    }
}