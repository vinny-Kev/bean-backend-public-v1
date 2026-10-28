import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { compareToPattern, parsePositiveId, parseTimestampRange } from '../../util/validations.js';
import { findMembershipRole } from '../../tenants/middleware/tenantAccessMiddleware.js';

const tenantAccess = (tenantId, userId) => findMembershipRole(pool, tenantId, userId);

const eventView = (row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    integrationId: row.integrated_app_id,
    eventId: row.event_id,
    eventType: row.event_type,
    handlerKey: row.handler_key,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    status: row.status,
    attemptCount: row.attempt_count,
    processedAt: row.processed_at,
    lastAttemptAt: row.last_attempt_at,
    lastFailedAt: row.last_failed_at,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    errorSummary: row.error_message,
    failureClassification: row.failure_classification,
});

export const searchIntegrationEvents = async (req, res, next) => {
    try {
        const tenantId = parsePositiveId(req.query.tenantId);
        if (!tenantId) return res.status(400).json({ message: 'A valid tenantId is required.' });
        if (!await tenantAccess(tenantId, req.user.id)) return res.status(403).json({ message: 'Forbidden.' });

        const where = ['e.tenant_id=$1'];
        const values = [tenantId];
        const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
        if (req.query.eventId !== undefined) {
            if (typeof req.query.eventId !== 'string' || !compareToPattern(req.query.eventId, 'event_id')) return res.status(400).json({ message: 'eventId is invalid.' });
            add('e.event_id=?', req.query.eventId);
        }
        if (req.query.correlationId !== undefined) {
            if (typeof req.query.correlationId !== 'string' || req.query.correlationId.length > 255) return res.status(400).json({ message: 'correlationId is invalid.' });
            add('e.correlation_id=?', req.query.correlationId);
        }
        if (req.query.externalTransactionId !== undefined) {
            if (typeof req.query.externalTransactionId !== 'string' || req.query.externalTransactionId.length > 255) return res.status(400).json({ message: 'externalTransactionId is invalid.' });
            values.push(req.query.externalTransactionId);
            const payloadMatch = `$${values.length}`;
            values.push(req.query.externalTransactionId);
            where.push(`(e.payload->>'externalTransactionId'=${payloadMatch} OR EXISTS
                (SELECT 1 FROM sales_transactions st WHERE st.source_event_id=e.id
                 AND st.external_transaction_id=$${values.length}))`);
        }
        if (req.query.internalEventId !== undefined) {
            const id = parsePositiveId(req.query.internalEventId);
            if (!id) return res.status(400).json({ message: 'internalEventId is invalid.' });
            add('e.id=?', id);
        }
        if (req.query.integrationId !== undefined) {
            const id = parsePositiveId(req.query.integrationId);
            if (!id) return res.status(400).json({ message: 'integrationId is invalid.' });
            add('e.integrated_app_id=?', id);
        }
        const range = parseTimestampRange(req.query);
        if (range.error) return res.status(400).json({ message: range.error });
        if (range.from) add('received_at >= ?', range.from.toISOString());
        if (range.to) add('received_at <= ?', range.to.toISOString());
        if (req.query.eventType !== undefined) {
            if (typeof req.query.eventType !== 'string' || !compareToPattern(req.query.eventType, 'event_type')) return res.status(400).json({ message: 'eventType is invalid.' });
            add('e.event_type=?', req.query.eventType);
        }
        if (req.query.status !== undefined) {
            if (!['pending', 'processing', 'processed', 'failed'].includes(req.query.status)) return res.status(400).json({ message: 'status is invalid.' });
            add('e.status=?', req.query.status);
        }
        if (req.query.errorCode !== undefined) {
            if (typeof req.query.errorCode !== 'string' || req.query.errorCode.length > 100) return res.status(400).json({ message: 'errorCode is invalid.' });
            add('e.error_code=?', req.query.errorCode);
        }
        const pagination = req.pagination ?? { limit: 20, offset: 0 };
        const count = await pool.query(`SELECT COUNT(*)::int AS total FROM integration_events e WHERE ${where.join(' AND ')}`, values);
        const rows = await pool.query(
            `SELECT e.* FROM integration_events e WHERE ${where.join(' AND ')}
             ORDER BY e.received_at DESC,e.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, pagination.limit, pagination.offset],
        );
        const total = count.rows[0].total;
        return res.status(200).json({
            message: rows.rowCount ? 'Integration events retrieved successfully.' : 'No integration events found.',
            data: rows.rows.map(eventView),
            pagination: { limit: pagination.limit, offset: pagination.offset, total,
                totalPages: Math.ceil(total / pagination.limit), hasMore: pagination.offset + rows.rowCount < total },
        });
    } catch (error) { return next(error); }
};

export const getIntegrationEventDetail = async (req, res, next) => {
    try {
        const eventId = parsePositiveId(req.params.event_id);
        const tenantId = parsePositiveId(req.query.tenantId);
        if (!eventId || !tenantId) return res.status(400).json({ message: 'A valid event ID and tenantId are required.' });
        if (!await tenantAccess(tenantId, req.user.id)) return res.status(403).json({ message: 'Forbidden.' });
        const eventResult = await pool.query('SELECT * FROM integration_events WHERE id=$1 AND tenant_id=$2', [eventId, tenantId]);
        if (!eventResult.rowCount) return res.status(404).json({ message: 'Integration event not found.' });
        const [attempts, diagnostics] = await Promise.all([
            pool.query(`SELECT attempt_number, worker_id, correlation_id, started_at, finished_at, outcome,
                        error_code, error_summary, failure_classification, retry_at, initiated_by_user_id, retry_reason
                        FROM integration_event_attempts WHERE integration_event_id=$1 ORDER BY attempt_number`, [eventId]),
            pool.query(`SELECT id, request_id, received_at, outcome, error_code, error_summary, http_status
                        FROM integration_event_diagnostics WHERE tenant_id=$1 AND integrated_app_id=$2 AND event_id=$3
                        ORDER BY received_at`, [tenantId, eventResult.rows[0].integrated_app_id, eventResult.rows[0].event_id]),
        ]);
        return res.status(200).json({ message: 'Integration event timeline retrieved successfully.', data: {
            event: eventView(eventResult.rows[0]),
            handlerKey: eventResult.rows[0].handler_key,
            attempts: attempts.rows.map((row) => ({
                attemptNumber: row.attempt_number, workerId: row.worker_id, correlationId: row.correlation_id,
                startedAt: row.started_at, finishedAt: row.finished_at, outcome: row.outcome,
                errorCode: row.error_code, errorSummary: row.error_summary,
                failureClassification: row.failure_classification, retryAt: row.retry_at,
                initiatedByUserId: row.initiated_by_user_id, retryReason: row.retry_reason,
            })),
            diagnostics: diagnostics.rows.map((row) => ({ id: row.id, requestId: row.request_id,
                receivedAt: row.received_at, outcome: row.outcome, errorCode: row.error_code,
                errorSummary: row.error_summary, httpStatus: row.http_status })),
        } });
    } catch (error) { return next(error); }
};

export const searchIntegrationDiagnostics = async (req, res, next) => {
    try {
        const tenantId = parsePositiveId(req.query.tenantId);
        if (!tenantId) return res.status(400).json({ message: 'A valid tenantId is required.' });
        if (!await tenantAccess(tenantId, req.user.id)) return res.status(403).json({ message: 'Forbidden.' });
        const where = ['tenant_id=$1'];
        const values = [tenantId];
        const add = (clause, value) => { values.push(value); where.push(clause.replace('?', `$${values.length}`)); };
        for (const [key, column, maxLength] of [['eventId', 'event_id', 255], ['correlationId', 'correlation_id', 255],
            ['externalTransactionId', 'external_transaction_id', 255], ['eventType', 'event_type', 100],
            ['errorCode', 'error_code', 100], ['outcome', 'outcome', 30]]) {
            if (req.query[key] !== undefined) {
                if (typeof req.query[key] !== 'string' || req.query[key].length > maxLength) return res.status(400).json({ message: `${key} is invalid.` });
                add(`${column}=?`, req.query[key]);
            }
        }
        if (req.query.integrationId !== undefined) {
            const id = parsePositiveId(req.query.integrationId);
            if (!id) return res.status(400).json({ message: 'integrationId is invalid.' });
            add('integrated_app_id=?', id);
        }
        const range = parseTimestampRange(req.query);
        if (range.error) return res.status(400).json({ message: range.error });
        if (range.from) add('received_at >= ?', range.from.toISOString());
        if (range.to) add('received_at <= ?', range.to.toISOString());
        const pagination = req.pagination ?? { limit: 20, offset: 0 };
        const count = await pool.query(`SELECT COUNT(*)::int AS total FROM integration_event_diagnostics WHERE ${where.join(' AND ')}`, values);
        const rows = await pool.query(
            `SELECT id, request_id, event_id, event_type, correlation_id, integrated_app_id,
                    received_at, outcome, error_code, error_summary, http_status
             FROM integration_event_diagnostics WHERE ${where.join(' AND ')}
             ORDER BY received_at DESC,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, pagination.limit, pagination.offset],
        );
        const total = count.rows[0].total;
        return res.status(200).json({ message: 'Integration diagnostics retrieved successfully.',
            data: rows.rows.map((row) => ({ id: row.id, requestId: row.request_id, eventId: row.event_id,
                eventType: row.event_type, correlationId: row.correlation_id, integrationId: row.integrated_app_id,
                receivedAt: row.received_at, outcome: row.outcome, errorCode: row.error_code,
                errorSummary: row.error_summary, httpStatus: row.http_status })),
            pagination: { limit: pagination.limit, offset: pagination.offset, total,
                totalPages: Math.ceil(total / pagination.limit), hasMore: pagination.offset + rows.rowCount < total },
        });
    } catch (error) { return next(error); }
};

export const searchUnauthorizedIntegrationAttempts = async (req, res, next) => {
    try {
        const pagination = req.pagination ?? { limit: 20, offset: 0 };
        const count = await pool.query(
            `SELECT COUNT(*)::int AS total FROM integration_event_diagnostics
             WHERE tenant_id IS NULL AND integrated_app_id IS NULL AND outcome='unauthorized'`,
        );
        const result = await pool.query(
            `SELECT id, request_id, received_at, error_code, http_status
             FROM integration_event_diagnostics
             WHERE tenant_id IS NULL AND integrated_app_id IS NULL AND outcome='unauthorized'
             ORDER BY received_at DESC,id DESC LIMIT $1 OFFSET $2`,
            [pagination.limit, pagination.offset],
        );
        const total = count.rows[0].total;
        return res.status(200).json({ message: 'Unauthorized integration attempts retrieved successfully.',
            data: result.rows.map((row) => ({ id: row.id, requestId: row.request_id,
                receivedAt: row.received_at, errorCode: row.error_code, httpStatus: row.http_status })),
            pagination: { limit: pagination.limit, offset: pagination.offset, total,
                totalPages: Math.ceil(total / pagination.limit), hasMore: pagination.offset + result.rowCount < total },
        });
    } catch (error) { return next(error); }
};

export const retryIntegrationEvent = async (req, res, next) => {
    let client;
    try {
        const eventId = parsePositiveId(req.params.event_id);
        const tenantId = parsePositiveId(req.body?.tenantId);
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (!eventId || !tenantId || reason.length < 10 || reason.length > 500
            || Object.keys(req.body ?? {}).some((key) => !['tenantId', 'reason'].includes(key))) {
            return res.status(400).json({ message: 'A valid tenantId and a 10 to 500 character retry reason are required.' });
        }
        const role = await tenantAccess(tenantId, req.user.id);
        if (!['owner', 'admin'].includes(role)) return res.status(403).json({ message: 'Tenant administrator access is required.' });
        client = await pool.connect();
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE integration_events SET status='pending', automatic_attempt_count=0,
                next_attempt_at=NULL, processed_at=NULL, processing_started_at=NULL, lease_expires_at=NULL,
                error_code=NULL, error_message=NULL, failure_classification=NULL,
                retry_requested_by_user_id=$3, retry_reason=$4
             WHERE id=$1 AND tenant_id=$2 AND status='failed'
               AND failure_classification='action_required'
             RETURNING id,event_id,event_type,correlation_id,received_at`,
            [eventId, tenantId, req.user.id, reason],
        );
        if (!result.rowCount) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'This event is not eligible for manual retry.' });
        }
        await composeAuditLogs(auditLog({ userId: req.user.id, tenantId, action: 'RETRY INTEGRATION EVENT',
            tableName: 'integration_events', recordId: eventId,
            newData: { eventId: result.rows[0].event_id, eventType: result.rows[0].event_type,
                correlationId: result.rows[0].correlation_id, reason } }), client);
        await client.query('COMMIT');
        return res.status(202).json({ message: 'Integration event queued for manual retry.', data: {
            id: result.rows[0].id, eventId: result.rows[0].event_id, status: 'pending',
        } });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally { client?.release(); }
};
