import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { parsePositiveId } from '../../util/validations.js';

// The integration protocol is an app key plus a bearer secret; only the bcrypt hash is stored.
export const generateIntegrationCredential = async () => {
    const secret = randomBytes(48).toString('base64url');
    return { secret, credentialHash: await bcrypt.hash(secret, 12) };
};

export const rotateIntegrationCredential = async (req, res, next) => {
    const integrationId = parsePositiveId(req.params.integration_id);
    const tenantId = parsePositiveId(req.body?.tenantId);
    if (!integrationId || !tenantId || Object.keys(req.body ?? {}).some((key) => key !== 'tenantId')) {
        return res.status(400).json({ message: 'A valid tenantId is required; no other fields are accepted.' });
    }
    let client;
    let integration;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT ia.id, ia.tenant_id, ia.app_key, ia.status, tm.membership_role
             FROM integrated_apps ia JOIN tenant_members tm ON tm.tenant_id=ia.tenant_id
             JOIN tenants t ON t.id=ia.tenant_id AND t.status<>'deleted'
             WHERE ia.id=$1 AND ia.tenant_id=$2 AND tm.user_id=$3 FOR UPDATE OF ia,tm`,
            [integrationId, tenantId, req.user.id],
        );
        integration = result.rows[0];
        if (!integration) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Integration not found for this tenant.' });
        }
        if (!['owner', 'admin'].includes(integration.membership_role)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'Tenant administrator access is required.' });
        }
        if (integration.status === 'revoked') {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'A revoked integration cannot rotate credentials.' });
        }
        const { secret, credentialHash } = await generateIntegrationCredential();
        await client.query(
            'UPDATE integrated_apps SET credential_hash=$1, credential_rotated_at=NOW(), updated_at=NOW() WHERE id=$2 AND tenant_id=$3',
            [credentialHash, integrationId, tenantId],
        );
        await client.query(
            `INSERT INTO integration_lifecycle_activity
                (tenant_id, integrated_app_id, actor_user_id, action, outcome, correlation_id)
             VALUES ($1,$2,$3,'credential.rotated','succeeded',$4)`,
            [tenantId, integrationId, req.user.id, req.requestId],
        );
        await composeAuditLogs(auditLog({ userId: req.user.id, tenantId, action: 'ROTATE INTEGRATION CREDENTIAL',
            tableName: 'integrated_apps', recordId: integrationId,
            newData: { tenantId, integrationId, appKey: integration.app_key,
                rotatedAt: new Date().toISOString(), outcome: 'succeeded' } }), client);
        await client.query('COMMIT');
        return res.status(200).json({ message: 'Integration credential rotated. Store this secret now; it will not be shown again.',
            data: { integrationId, appKey: integration.app_key, credential: secret } });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (integration) {
            await pool.query(
                `INSERT INTO integration_lifecycle_activity
                    (tenant_id, integrated_app_id, actor_user_id, action, outcome, correlation_id,
                     error_code, error_summary)
                 VALUES ($1,$2,$3,'credential.rotated','failed',$4,'CREDENTIAL_ROTATION_FAILED',
                     'Credential rotation failed before it could be committed.')`,
                [tenantId, integrationId, req.user.id, req.requestId],
            ).catch(() => {});
        }
        return next(error);
    } finally {
        client?.release();
    }
};
