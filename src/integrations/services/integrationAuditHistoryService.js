import { pool } from '../../db/pool.js';
import { isPlainObject, parseTimestampRange } from '../../util/validations.js';
import { resolveDashboardIntegration } from './integrationActivityService.js';

// Only these audit fields are returned; anything else stored in old_data/new_data is dropped.
const SAFE_AUDIT_KEYS = new Set([
    'tenantId', 'integrationId', 'name', 'appKey', 'status', 'outcome', 'rotatedAt',
    'enabledEventTypes', 'externalUserId', 'userId', 'isActive',
    'eventId', 'eventType', 'handler', 'errorCode', 'retryAt', 'reason', 'correlationId',
]);
const HISTORY_SOURCES = new Set(['audit_log', 'lifecycle']);

export const sanitizeAuditData = (data) => {
    if (!isPlainObject(data)) return null;
    const safe = {};
    for (const [key, value] of Object.entries(data)) {
        if (!SAFE_AUDIT_KEYS.has(key)) continue;
        if (typeof value === 'string') safe[key] = value.slice(0, 500);
        else if (value === null || typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
        else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) safe[key] = value.slice(0, 50).map((item) => item.slice(0, 150));
    }
    return Object.keys(safe).length ? safe : null;
};

// audit_logs has no tenant or integration column. Rows are attributed to an integration only
// through relationships the writers establish: integrated_apps and subscription audits use the
// integration ID as record_id; mapping and event audits are resolved through their own rows
// (event audits disappear from this view once retention removes the source event).
// Tenant-wide audits such as inventory-policy changes are not attributable to one integration.
const historyCte = `WITH history AS (
    SELECT 'audit_log'::text source, al.id, al.created_at occurred_at, al.action::text action, al.user_id actor_user_id,
        al.table_name::text resource_type, al.record_id resource_id, NULL::text outcome, NULL::text error_code,
        NULL::text error_summary, NULL::text correlation_id, al.old_data, al.new_data
    FROM audit_logs al
    WHERE (al.table_name IN ('integrated_apps', 'integrated_app_event_subscriptions') AND al.record_id=$2)
       OR (al.table_name='integration_user_mappings' AND EXISTS (SELECT 1 FROM integration_user_mappings m
            WHERE m.id=al.record_id AND m.tenant_id=$1 AND m.integrated_app_id=$2))
       OR (al.table_name='integration_events' AND EXISTS (SELECT 1 FROM integration_events e
            WHERE e.id=al.record_id AND e.tenant_id=$1 AND e.integrated_app_id=$2))
    UNION ALL
    SELECT 'lifecycle', l.id, l.occurred_at, l.action, l.actor_user_id, 'integrated_apps', l.integrated_app_id,
        l.outcome, l.error_code, l.error_summary, l.correlation_id, NULL, NULL
    FROM integration_lifecycle_activity l
    WHERE l.tenant_id=$1 AND l.integrated_app_id=$2
)`;

export const getIntegrationAuditHistory = async (req, res, next) => {
    try {
        const integration = await resolveDashboardIntegration(req, res);
        if (!integration) return undefined;

        const filters = [];
        const values = [integration.tenant_id, integration.id];
        const add = (clause, value) => { values.push(value); filters.push(clause.replace('?', `$${values.length}`)); };
        const range = parseTimestampRange(req.query);
        if (range.error) return res.status(400).json({ message: range.error });
        if (range.from) add('occurred_at >= ?', range.from.toISOString());
        if (range.to) add('occurred_at <= ?', range.to.toISOString());
        if (req.query.source !== undefined) {
            if (!HISTORY_SOURCES.has(req.query.source)) return res.status(400).json({ message: 'source must be audit_log or lifecycle.' });
            add('source=?', req.query.source);
        }
        if (req.query.actor !== undefined) {
            if (!['user', 'system'].includes(req.query.actor)) return res.status(400).json({ message: 'actor must be user or system.' });
            filters.push(req.query.actor === 'user' ? 'actor_user_id IS NOT NULL' : 'actor_user_id IS NULL');
        }
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const pagination = req.pagination ?? { limit: 20, offset: 0 };
        const count = await pool.query(`${historyCte} SELECT COUNT(*)::int total FROM history ${where}`, values);
        const rows = await pool.query(
            `${historyCte} SELECT * FROM history ${where}
             ORDER BY occurred_at DESC, source, id DESC
             LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, pagination.limit, pagination.offset],
        );
        const total = count.rows[0].total;
        return res.status(200).json({ message: 'Integration audit history retrieved successfully.',
            data: rows.rows.map((row) => ({ id: row.id, source: row.source, occurredAt: row.occurred_at,
                action: row.action, actorUserId: row.actor_user_id, actorType: row.actor_user_id ? 'user' : 'system',
                resourceType: row.resource_type, resourceId: row.resource_id, outcome: row.outcome,
                errorCode: row.error_code, errorSummary: row.error_summary, correlationId: row.correlation_id,
                changes: row.source === 'audit_log'
                    ? { before: sanitizeAuditData(row.old_data), after: sanitizeAuditData(row.new_data) } : null })),
            pagination: { ...(pagination.page !== undefined && { page: pagination.page }), limit: pagination.limit,
                offset: pagination.offset, total, totalPages: Math.ceil(total / pagination.limit),
                hasMore: pagination.offset + rows.rowCount < total },
        });
    } catch (error) { return next(error); }
};
