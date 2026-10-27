import { randomBytes } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { generateIntegrationCredential } from './integrationCredentialService.js';
import { resolveIntegrationHandlerKind } from './integrationHandlerRegistry.js';
import { compareToPattern, inRangeOfLength, isPlainObject, parsePositiveId } from '../../util/validations.js';

// Lifecycle: pending -> active <-> suspended; any non-revoked state -> revoked (terminal).
// Every app-scoped operation derives the tenant from the integration row and then
// checks the caller's membership in that tenant; clients never supply a tenant ID.

const fail = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });
const isAdmin = (role) => ['owner', 'admin'].includes(role);

const optionalUrl = (value) => {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== 'string' || value.length > 2048) return { ok: false };
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? { ok: true, value: url.toString() } : { ok: false };
    } catch { return { ok: false }; }
};

const integrationView = (row) => ({
    id: row.id, tenantId: row.tenant_id, name: row.name, description: row.description, appKey: row.app_key,
    status: row.status, appUrl: row.app_url, webhookUrl: row.webhook_url, lastEventAt: row.last_event_at,
    credentialConfigured: Boolean(row.credential_hash), credentialRotatedAt: row.credential_rotated_at,
    createdByUserId: row.created_by_user_id, createdAt: row.created_at, updatedAt: row.updated_at,
});

const recordLifecycle = async (client, { integration, req, action, outcome = 'succeeded', errorCode = null, errorSummary = null }) => {
    await client.query(
        `INSERT INTO integration_lifecycle_activity
            (tenant_id, integrated_app_id, actor_user_id, action, outcome, correlation_id, error_code, error_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [integration.tenant_id, integration.id, req.user.id, action, outcome, req.requestId, errorCode, errorSummary],
    );
};

// Resolves an integration only if the user is a member of the tenant that owns it.
export const findIntegrationForMember = async (client, integrationId, userId, { lock = false } = {}) => {
    const result = await client.query(
        `SELECT ia.*, t.status AS tenant_status, tm.membership_role
         FROM integrated_apps ia
         JOIN tenants t ON t.id=ia.tenant_id
         JOIN tenant_members tm ON tm.tenant_id=ia.tenant_id AND tm.user_id=$2
         WHERE ia.id=$1 ${lock ? 'FOR UPDATE OF ia' : ''}`,
        [integrationId, userId],
    );
    return result.rows[0] ?? null;
};

export const getReadiness = async (client, integration) => {
    const subscriptions = await client.query(
        `SELECT s.event_type, er.handler_key FROM integrated_app_event_subscriptions s
         JOIN event_registry er ON er.event_type=s.event_type AND er.is_active=true
         WHERE s.integrated_app_id=$1 AND s.tenant_id=$2 AND s.is_enabled=true`,
        [integration.id, integration.tenant_id],
    );
    const checks = {
        tenantActive: integration.tenant_status === 'active',
        credentialConfigured: Boolean(integration.credential_hash),
        supportedSubscriptionEnabled: subscriptions.rows.some((row) => resolveIntegrationHandlerKind(row.handler_key)),
    };
    return { ready: Object.values(checks).every(Boolean), checks };
};

// Runs a locked, audited, owner/admin-only change on one integration.
const withAdminIntegration = async (req, res, next, work) => {
    const integrationId = parsePositiveId(req.params.integration_id);
    if (!integrationId) return fail(res, 400, 'INVALID_INTEGRATION_ID', 'A valid integration ID is required.');
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const integration = await findIntegrationForMember(client, integrationId, req.user.id, { lock: true });
        if (!integration) {
            await client.query('ROLLBACK');
            return fail(res, 404, 'INTEGRATION_NOT_FOUND', 'Integration not found.');
        }
        if (!isAdmin(integration.membership_role)) {
            await client.query('ROLLBACK');
            return fail(res, 403, 'TENANT_ADMIN_REQUIRED', 'Tenant administrator access is required.');
        }
        const response = await work(client, integration);
        await client.query(response.commit === false ? 'ROLLBACK' : 'COMMIT');
        if (response.afterRollback) await response.afterRollback();
        return res.status(response.status).json(response.body);
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally { client?.release(); }
};

export const createIntegration = async (req, res, next) => {
    const tenantId = parsePositiveId(req.params.tenant_id);
    const body = req.body;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const appUrl = optionalUrl(body?.appUrl);
    const webhookUrl = optionalUrl(body?.webhookUrl);
    if (!tenantId || !isPlainObject(body)
        || Object.keys(body).some((key) => !['name', 'description', 'appUrl', 'webhookUrl'].includes(key))
        || !inRangeOfLength(name, 1, 255)
        || (body.description !== undefined && (typeof body.description !== 'string' || !inRangeOfLength(body.description, 0, 2000)))
        || !appUrl.ok || !webhookUrl.ok) {
        return fail(res, 400, 'INVALID_INTEGRATION', 'Provide a name (1-255 characters) and optional description, appUrl and webhookUrl (http/https).');
    }
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const member = await client.query(
            `SELECT tm.membership_role, t.status FROM tenant_members tm JOIN tenants t ON t.id=tm.tenant_id
             WHERE tm.tenant_id=$1 AND tm.user_id=$2 FOR SHARE OF t`, [tenantId, req.user.id],
        );
        if (!member.rowCount) {
            await client.query('ROLLBACK');
            return fail(res, 404, 'TENANT_NOT_FOUND', 'Tenant not found.');
        }
        if (!isAdmin(member.rows[0].membership_role)) {
            await client.query('ROLLBACK');
            return fail(res, 403, 'TENANT_ADMIN_REQUIRED', 'Tenant administrator access is required.');
        }
        if (member.rows[0].status !== 'active') {
            await client.query('ROLLBACK');
            return fail(res, 409, 'TENANT_INACTIVE', 'Integrations can only be registered for an active tenant.');
        }
        const appKey = `bean_${randomBytes(18).toString('base64url')}`;
        const { secret, credentialHash } = await generateIntegrationCredential();
        const inserted = await client.query(
            `INSERT INTO integrated_apps
                (tenant_id, name, description, app_key, status, created_by_user_id, credential_hash, credential_rotated_at, app_url, webhook_url)
             VALUES ($1,$2,$3,$4,'pending',$5,$6,NOW(),$7,$8) RETURNING *`,
            [tenantId, name, body.description ?? null, appKey, req.user.id, credentialHash, appUrl.value, webhookUrl.value],
        );
        const integration = inserted.rows[0];
        await recordLifecycle(client, { integration, req, action: 'integration.created' });
        await composeAuditLogs(auditLog({ userId: req.user.id, action: 'CREATE INTEGRATION', tableName: 'integrated_apps',
            recordId: integration.id, newData: { tenantId, name, appKey, status: 'pending' } }), client);
        await client.query('COMMIT');
        return res.status(201).json({
            message: 'Integration registered. Store this credential now; it will not be shown again.',
            data: { ...integrationView(integration), credential: secret },
        });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally { client?.release(); }
};

export const getIntegration = async (req, res, next) => {
    const integrationId = parsePositiveId(req.params.integration_id);
    if (!integrationId) return fail(res, 400, 'INVALID_INTEGRATION_ID', 'A valid integration ID is required.');
    try {
        const integration = await findIntegrationForMember(pool, integrationId, req.user.id);
        if (!integration) return fail(res, 404, 'INTEGRATION_NOT_FOUND', 'Integration not found.');
        const [subscriptions, readiness] = await Promise.all([
            pool.query(`SELECT event_type, is_enabled FROM integrated_app_event_subscriptions
                        WHERE integrated_app_id=$1 AND tenant_id=$2 ORDER BY event_type`, [integration.id, integration.tenant_id]),
            getReadiness(pool, integration),
        ]);
        return res.status(200).json({ message: 'Integration retrieved successfully.', data: {
            ...integrationView(integration),
            subscriptions: subscriptions.rows.map((row) => ({ eventType: row.event_type, enabled: row.is_enabled })),
            readiness,
        } });
    } catch (error) { return next(error); }
};

export const updateSubscriptions = (req, res, next) => {
    const eventTypes = req.body?.eventTypes;
    if (!isPlainObject(req.body) || Object.keys(req.body).some((key) => key !== 'eventTypes') || !Array.isArray(eventTypes)
        || eventTypes.length > 50 || eventTypes.some((type) => typeof type !== 'string' || !compareToPattern(type, 'event_type'))
        || new Set(eventTypes).size !== eventTypes.length) {
        return fail(res, 400, 'INVALID_SUBSCRIPTIONS', 'Provide eventTypes as a list of distinct registered event types.');
    }
    return withAdminIntegration(req, res, next, async (client, integration) => {
        if (integration.status === 'revoked') {
            return { status: 409, commit: false, body: { error: { code: 'INTEGRATION_REVOKED', message: 'A disconnected integration cannot be configured.' } } };
        }
        const registry = await client.query(
            'SELECT event_type, handler_key FROM event_registry WHERE event_type = ANY($1::text[]) AND is_active=true', [eventTypes],
        );
        const supported = new Set(registry.rows.filter((row) => resolveIntegrationHandlerKind(row.handler_key)).map((row) => row.event_type));
        const unsupported = eventTypes.filter((type) => !supported.has(type));
        if (unsupported.length) {
            return { status: 422, commit: false, body: { error: { code: 'UNSUPPORTED_EVENT_TYPES',
                message: 'These event types are not registered with a supported handler.', eventTypes: unsupported } } };
        }
        await client.query(
            `UPDATE integrated_app_event_subscriptions SET is_enabled = (event_type = ANY($3::text[]))
             WHERE integrated_app_id=$1 AND tenant_id=$2`, [integration.id, integration.tenant_id, eventTypes],
        );
        await client.query(
            `INSERT INTO integrated_app_event_subscriptions (tenant_id, integrated_app_id, event_type, is_enabled)
             SELECT $2, $1, unnest($3::text[]), true
             ON CONFLICT (integrated_app_id, event_type) DO UPDATE SET is_enabled=true`,
            [integration.id, integration.tenant_id, eventTypes],
        );
        await recordLifecycle(client, { integration, req, action: 'subscriptions.updated' });
        await composeAuditLogs(auditLog({ userId: req.user.id, action: 'UPDATE INTEGRATION SUBSCRIPTIONS', tableName: 'integrated_app_event_subscriptions',
            recordId: integration.id, newData: { tenantId: integration.tenant_id, enabledEventTypes: eventTypes } }), client);
        return { status: 200, body: { message: 'Subscriptions updated.', data: { integrationId: integration.id, enabledEventTypes: eventTypes } } };
    });
};

export const upsertUserMapping = (req, res, next) => {
    const body = req.body;
    const externalUserId = typeof body?.externalUserId === 'string' ? body.externalUserId.trim() : '';
    const userId = Number.isSafeInteger(body?.userId) && body.userId > 0 ? body.userId : null;
    if (!isPlainObject(body) || Object.keys(body).some((key) => !['externalUserId', 'userId', 'isActive'].includes(key))
        || !inRangeOfLength(externalUserId, 1, 255) || !userId
        || (body.isActive !== undefined && typeof body.isActive !== 'boolean')) {
        return fail(res, 400, 'INVALID_USER_MAPPING', 'Provide externalUserId, a numeric userId, and an optional boolean isActive.');
    }
    return withAdminIntegration(req, res, next, async (client, integration) => {
        if (integration.status === 'revoked') {
            return { status: 409, commit: false, body: { error: { code: 'INTEGRATION_REVOKED', message: 'A disconnected integration cannot be configured.' } } };
        }
        const member = await client.query('SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND user_id=$2', [integration.tenant_id, userId]);
        if (!member.rowCount) {
            return { status: 422, commit: false, body: { error: { code: 'USER_NOT_TENANT_MEMBER', message: 'The mapped user must be a member of this tenant.' } } };
        }
        const isActive = body.isActive ?? true;
        const mapping = await client.query(
            `INSERT INTO integration_user_mappings (tenant_id, integrated_app_id, external_user_id, user_id, is_active)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (tenant_id, integrated_app_id, external_user_id)
             DO UPDATE SET user_id=EXCLUDED.user_id, is_active=EXCLUDED.is_active, updated_at=NOW()
             RETURNING id, external_user_id, user_id, is_active`,
            [integration.tenant_id, integration.id, externalUserId, userId, isActive],
        );
        await recordLifecycle(client, { integration, req, action: 'user_mapping.updated' });
        await composeAuditLogs(auditLog({ userId: req.user.id, action: 'UPDATE INTEGRATION USER MAPPING', tableName: 'integration_user_mappings',
            recordId: mapping.rows[0].id, newData: { tenantId: integration.tenant_id, integrationId: integration.id, externalUserId, userId, isActive } }), client);
        return { status: 200, body: { message: 'User mapping saved.', data: {
            id: mapping.rows[0].id, externalUserId, userId, isActive: mapping.rows[0].is_active } } };
    });
};

const transition = ({ action, auditAction, from, to, requireReady = false, extraSql = null }) => (req, res, next) => {
    if (req.body !== undefined && (!isPlainObject(req.body) || Object.keys(req.body).length)) {
        return fail(res, 400, 'INVALID_REQUEST', 'This operation does not accept a request body.');
    }
    return withAdminIntegration(req, res, next, async (client, integration) => {
        if (!from.includes(integration.status)) {
            return { status: 409, commit: false, body: { error: { code: 'INVALID_LIFECYCLE_TRANSITION',
                message: `An integration in status ${integration.status} cannot be ${to === 'revoked' ? 'disconnected' : `moved to ${to}`}.` } } };
        }
        if (requireReady) {
            const readiness = await getReadiness(client, integration);
            if (!readiness.ready) {
                const failed = Object.entries(readiness.checks).filter(([, ok]) => !ok).map(([name]) => name);
                // The refused activation is still recorded, after this transaction rolls back.
                return { status: 409, commit: false, afterRollback: async () => {
                    await recordLifecycle(pool, { integration, req, action, outcome: 'failed',
                        errorCode: 'INTEGRATION_NOT_READY', errorSummary: `Failed readiness checks: ${failed.join(', ')}` });
                }, body: { error: { code: 'INTEGRATION_NOT_READY', message: 'The integration is not ready to activate.', checks: readiness.checks } } };
            }
        }
        const updated = await client.query(
            `UPDATE integrated_apps SET status=$2, updated_at=NOW() ${extraSql ? `, ${extraSql}` : ''}
             WHERE id=$1 RETURNING *`, [integration.id, to],
        );
        if (to === 'revoked') {
            await client.query('UPDATE integrated_app_event_subscriptions SET is_enabled=false WHERE integrated_app_id=$1 AND tenant_id=$2',
                [integration.id, integration.tenant_id]);
        }
        await recordLifecycle(client, { integration, req, action });
        await composeAuditLogs(auditLog({ userId: req.user.id, action: auditAction, tableName: 'integrated_apps', recordId: integration.id,
            oldData: { status: integration.status }, newData: { tenantId: integration.tenant_id, status: to } }), client);
        return { status: 200, body: { message: `Integration ${to === 'revoked' ? 'disconnected' : to}.`,
            data: integrationView({ ...updated.rows[0] }) } };
    });
};

export const activateIntegration = transition({ action: 'integration.activated', auditAction: 'ACTIVATE INTEGRATION',
    from: ['pending', 'suspended'], to: 'active', requireReady: true });
export const suspendIntegration = transition({ action: 'integration.suspended', auditAction: 'SUSPEND INTEGRATION',
    from: ['active'], to: 'suspended' });
// Disconnecting is terminal: the credential is destroyed and subscriptions are disabled.
// Events accepted before disconnection were authenticated and are still processed.
export const disconnectIntegration = transition({ action: 'integration.disconnected', auditAction: 'DISCONNECT INTEGRATION',
    from: ['pending', 'active', 'suspended'], to: 'revoked', extraSql: 'credential_hash=NULL' });
