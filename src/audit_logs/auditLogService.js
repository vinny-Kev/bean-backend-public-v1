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

        const responseData = {
            userId: auditLog.userId,
            action: auditLog.action,
            tableName: auditLog.tableName,
            recordId: auditLog.recordId,
            oldData: auditLog.oldData,
            newData: auditLog.newData,
            createdAt: auditLog.created_at,
        }
        
        console.log("[AUDIT LOG SERVICE]: End Process SUCCESS - Audit log entry created successfully:", responseData);
        return responseData;
    } catch (error) {
        console.log("[AUDIT LOG SERVICE]: End Process - Error during composing audit log entry:", error);
        throw error;
    }
}
