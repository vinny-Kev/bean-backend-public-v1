export const auditLog = ({
    userId = null,
    action,
    tableName = null,
    recordId = null,
    oldData = null,
    newData = null,
    created_at = new Date().toISOString(),
}) =>({
    userId,
    action,
    tableName,
    recordId,
    oldData,
    newData,
    created_at
})