import { pool } from '../../db/pool.js';
import { compareToPattern, parsePositiveId, parseTimestampRange } from '../../util/validations.js';
import { findIntegrationForMember } from './integrationLifecycleService.js';

const ACTIVITY_STATUSES = new Set([
    'pending', 'processing', 'processed', 'failed',
    'accepted', 'duplicate', 'invalid', 'ingestion_failed',
    'started', 'retry_scheduled', 'lease_expired', 'completed',
]);
const ACTIVITY_RECORD_TYPES = new Set(['integration_event', 'delivery_diagnostic', 'processing_attempt', 'sale', 'analytics_outbox']);

export const resolveDashboardIntegration = async (req, res) => {
    const integrationId = parsePositiveId(req.params.integration_id);
    const requestedTenantId = req.query.tenantId === undefined ? null : parsePositiveId(req.query.tenantId);
    if (!integrationId || (req.query.tenantId !== undefined && !requestedTenantId)) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid integration ID (and tenantId, if given) is required.' } });
        return null;
    }
    const integration = await findIntegrationForMember(pool, integrationId, req.user.id);
    if (!integration || (requestedTenantId && Number(integration.tenant_id) !== requestedTenantId)) {
        res.status(404).json({ error: { code: 'INTEGRATION_NOT_FOUND', message: 'Integration not found.' } });
        return null;
    }
    return integration;
};

// Every branch is filtered by tenant and integration ($1, $2) so each uses its own index.
const activityCte = `WITH activity AS (
    SELECT 'integration_event'::text record_type, e.id record_id, e.event_id, e.event_type,
        e.payload->>'externalTransactionId' external_transaction_id, e.correlation_id,
        e.received_at occurred_at, 'queue'::text stage, e.status::text outcome,
        e.error_code, e.error_message::text error_summary, e.id internal_event_id, NULL::text related_record_id,
        e.received_at, e.occurred_at event_occurred_at, e.processed_at, e.attempt_count
    FROM integration_events e
    WHERE e.tenant_id=$1 AND e.integrated_app_id=$2
    UNION ALL
    SELECT 'delivery_diagnostic', d.id, d.event_id, d.event_type, d.external_transaction_id, d.correlation_id,
        d.received_at, 'ingestion', d.outcome, d.error_code, d.error_summary, e.id, d.request_id::text,
        d.received_at, NULL, NULL, NULL
    FROM integration_event_diagnostics d
    LEFT JOIN integration_events e ON e.integrated_app_id=d.integrated_app_id AND e.event_id=d.event_id
    WHERE d.tenant_id=$1 AND d.integrated_app_id=$2
    UNION ALL
    SELECT 'processing_attempt', a.id, COALESCE(a.event_id, e.event_id), COALESCE(a.event_type, e.event_type),
        COALESCE(a.external_transaction_id, e.payload->>'externalTransactionId'), a.correlation_id,
        COALESCE(a.finished_at, a.started_at), 'worker_attempt', a.outcome, a.error_code, a.error_summary,
        a.integration_event_id, a.attempt_number::text, NULL, NULL, NULL, NULL
    FROM integration_event_attempts a LEFT JOIN integration_events e ON e.id=a.integration_event_id
    WHERE (a.tenant_id=$1 AND a.integrated_app_id=$2)
       OR (a.tenant_id IS NULL AND e.tenant_id=$1 AND e.integrated_app_id=$2)
    UNION ALL
    SELECT 'sale', st.id, st.source_event_key, 'transaction.completed', st.external_transaction_id, st.correlation_id,
        st.created_at, 'business_effect', st.status, NULL, NULL, st.source_event_id, st.id::text,
        NULL, st.occurred_at, NULL, NULL
    FROM sales_transactions st
    WHERE st.tenant_id=$1 AND st.integrated_app_id=$2
    UNION ALL
    SELECT 'analytics_outbox', o.id, o.source_event_key, o.event_type, o.payload->>'externalTransactionId', o.correlation_id,
        COALESCE(o.processed_at, o.created_at), 'analytics_delivery', o.status,
        CASE WHEN o.status='failed' THEN 'OUTBOX_DELIVERY_FAILED' END, o.error_message, o.source_event_id, o.id::text,
        NULL, NULL, o.processed_at, NULL
    FROM analytics_outbox o
    WHERE o.tenant_id=$1 AND o.source_integration_id=$2
)`;

export const getIntegrationActivity = async (req, res, next) => {
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
        if (req.query.eventType !== undefined) {
            if (typeof req.query.eventType !== 'string' || !compareToPattern(req.query.eventType, 'event_type')) return res.status(400).json({ message: 'eventType is invalid.' });
            add('event_type=?', req.query.eventType);
        }
        if (req.query.status !== undefined) {
            if (!ACTIVITY_STATUSES.has(req.query.status)) return res.status(400).json({ message: 'status is invalid.' });
            add('outcome=?', req.query.status);
        }
        if (req.query.recordType !== undefined) {
            if (!ACTIVITY_RECORD_TYPES.has(req.query.recordType)) return res.status(400).json({ message: 'recordType is invalid.' });
            add('record_type=?', req.query.recordType);
        }
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const pagination = req.pagination ?? { limit: 20, offset: 0 };
        const count = await pool.query(`${activityCte} SELECT COUNT(*)::int total FROM activity ${where}`, values);
        const rows = await pool.query(
            `${activityCte} SELECT * FROM activity ${where}
             ORDER BY occurred_at DESC, record_type, record_id DESC
             LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, pagination.limit, pagination.offset],
        );
        const total = count.rows[0].total;
        return res.status(200).json({ message: 'Integration activity retrieved successfully.',
            data: rows.rows.map((row) => ({ id: row.record_id, recordType: row.record_type,
                eventId: row.event_id, internalEventId: row.internal_event_id,
                eventType: row.event_type, externalTransactionId: row.external_transaction_id,
                correlationId: row.correlation_id, occurredAt: row.occurred_at, stage: row.stage,
                status: row.outcome, errorCode: row.error_code, errorSummary: row.error_summary?.slice(0, 500) ?? null,
                relatedRecordId: row.related_record_id, receivedAt: row.received_at,
                eventOccurredAt: row.event_occurred_at, processedAt: row.processed_at, attemptCount: row.attempt_count })),
            pagination: { ...(pagination.page !== undefined && { page: pagination.page }), limit: pagination.limit,
                offset: pagination.offset, total, totalPages: Math.ceil(total / pagination.limit),
                hasMore: pagination.offset + rows.rowCount < total },
        });
    } catch (error) { return next(error); }
};
