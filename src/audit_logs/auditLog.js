// tenantId is the tenant the entry belongs to; leave it null only for account-level
// events (such as logins) that no tenant should see in its audit history.
export const auditLog = ({
    userId = null,
    tenantId = null,
    action,
    tableName = null,
    recordId = null,
    oldData = null,
    newData = null,
    created_at = new Date().toISOString(),
}) =>({
    userId,
    tenantId,
    action,
    tableName,
    recordId,
    oldData,
    newData,
    created_at
})
