import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { recordIntegrationDiagnostic } from './integrationDiagnostics.js';
import { validateAgainstSchema, validateBusinessEvent } from '../middleware/integrationOriginMiddleware.js';
import { resolveIntegrationHandlerKind } from './integrationHandlerRegistry.js';
import { parsePositiveId } from '../../util/validations.js';
export const getTenantIntegrations = async (req, res, next) => {
    try {
        const tenantId = parsePositiveId(req.params.tenant_id);
        if (!tenantId) {
            return res.status(400).json({ message: 'A valid tenant_id is required.' });
        }

        const pagination = req.pagination;
        const hasPagination = Boolean(pagination);
        const { page, limit, offset } = pagination ?? {};
        const sql = `
                SELECT
                    ia.id,
                    ia.tenant_id,
                    ia.name,
                    ia.description,
                    ia.status,
                    ia.created_by_user_id,
                    ia.last_event_at,
                    ia.created_at,
                    ia.updated_at,
                    ia.app_url,
                    ia.webhook_url
                FROM integrated_apps ia
                INNER JOIN tenant_members tm
                    ON tm.tenant_id = ia.tenant_id
                WHERE ia.tenant_id = $1
                    AND tm.user_id = $2
                ORDER BY ia.created_at DESC, ia.id DESC
                ${hasPagination ? 'LIMIT $3 OFFSET $4' : ''}
            `;

            const params = hasPagination
                ? [tenantId, req.user.id, limit, offset]
                : [tenantId, req.user.id];
        const result = await pool.query(sql, params);

        if (result.rows.length > 0) {
            const auditEntry = auditLog({
                userId: req.user.id,
                action: 'GET TENANT INTEGRATIONS',
                tableName: 'integrations',
                recordId: null,
                oldData: null,
                newData: result.rows,
            });

            // Audit logging should not make a successful read fail (same policy as inventory reads).
            try {
                await composeAuditLogs(auditEntry);
            } catch {
                console.error(JSON.stringify({
                    event: 'integration_read_audit_failed',
                    requestId: req.requestId,
                }));
            }
        }

        const data = result.rows.map(row => ({
            id: row.id,
            tenantId: row.tenant_id,
            name: row.name,
            description: row.description,
            status: row.status,
            createdByUserId: row.created_by_user_id,
            lastEventAt: row.last_event_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            appUrl: row.app_url,
            webhookUrl: row.webhook_url,
        }));

        if (hasPagination) {
            const countResult = await pool.query(
                `SELECT COUNT(*)::int AS total FROM integrated_apps ia
                 JOIN tenant_members tm ON tm.tenant_id = ia.tenant_id
                 WHERE ia.tenant_id = $1 AND tm.user_id = $2`,
                [tenantId, req.user.id],
            );
            const total = countResult.rows[0].total;

            return res.status(200).json({
                data,
                message: data.length
                    ? 'Tenant integrations retrieved successfully.'
                    : 'No integrations found for tenant.',
                pagination: {
                    ...(page !== undefined && { page }),
                    limit,
                    offset,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasMore: offset + data.length < total,
                },
            });
        }

        return res.status(200).json({
            data,
            message: data.length
                ? 'Tenant integrations retrieved successfully.'
                : 'No integrations found for tenant.',
        });
    } catch (error) {
        return next(error);
    }
};

export const receiveIntegrationEvent = async (req, res, next) => {
    let client;
    try {
        const integrationId = req.integration.id;
        const event = req.integrationEvent;
        client = await pool.connect();
        await client.query('BEGIN');
        // The integration row is updated (last_event_at) later in this transaction. Taking the
        // update lock up front avoids share-lock upgrade deadlocks between concurrent deliveries.
        const authorization = await client.query(
            `SELECT er.payload_schema, er.handler_key
             FROM integrated_apps ia
             JOIN integrated_app_event_subscriptions s
               ON s.integrated_app_id=ia.id AND s.tenant_id=ia.tenant_id AND s.is_enabled=true
             JOIN event_registry er ON er.event_type=s.event_type AND er.is_active=true
             JOIN tenants t ON t.id=ia.tenant_id AND t.status='active'
             WHERE ia.id=$1 AND ia.tenant_id=$2 AND ia.status='active' AND er.event_type=$3
             FOR NO KEY UPDATE OF ia FOR SHARE OF s,er,t`,
            [integrationId, req.integration.tenantId, event.eventType],
        );
        const currentPolicy = authorization.rows[0];
        const kind = resolveIntegrationHandlerKind(currentPolicy?.handler_key);
        const policyError = !currentPolicy ? 'Event subscription or integration is no longer active.'
            : !kind ? 'Event handler is no longer supported.'
                : validateAgainstSchema(event.payload, currentPolicy.payload_schema)
                    ?? (kind === 'sale' ? validateBusinessEvent('transaction.completed', event.payload)
                        : validateBusinessEvent('inventory.adjusted', event.payload));
        if (policyError) {
            await client.query(
                `INSERT INTO integration_event_diagnostics
                    (tenant_id, integrated_app_id, request_id, event_id, event_type,
                     external_transaction_id, correlation_id, outcome, error_code, error_summary, http_status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'invalid','EVENT_POLICY_CHANGED',$8,422)`,
                [req.integration.tenantId, integrationId, req.requestId, event.eventId, event.eventType,
                    typeof event.payload.externalTransactionId === 'string' ? event.payload.externalTransactionId.slice(0, 255) : null,
                    event.correlationId, policyError.slice(0, 500)],
            );
            await client.query('COMMIT');
            return res.status(422).json({ error: { code: 'EVENT_POLICY_CHANGED',
                message: 'Event authorization or validation policy changed before acceptance.' } });
        }
        const dedupe = await client.query(
            `INSERT INTO integration_event_deduplication
                (tenant_id, integrated_app_id, event_id, event_type, external_transaction_id, correlation_id)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (integrated_app_id,event_id) DO NOTHING RETURNING event_id`,
            [req.integration.tenantId, integrationId, event.eventId, event.eventType,
                typeof event.payload.externalTransactionId === 'string' ? event.payload.externalTransactionId.slice(0, 255) : null,
                event.correlationId],
        );
        if (!dedupe.rowCount) {
            await client.query(
                `INSERT INTO integration_event_diagnostics
                    (tenant_id, integrated_app_id, request_id, event_id, event_type,
                     external_transaction_id, correlation_id, outcome, http_status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'duplicate',200)`,
                [req.integration.tenantId, integrationId, req.requestId, event.eventId, event.eventType,
                    typeof event.payload.externalTransactionId === 'string' ? event.payload.externalTransactionId.slice(0, 255) : null,
                    event.correlationId],
            );
            await client.query('COMMIT');
            return res.status(200).json({ message: 'Integration event was already received.',
                data: { integrationId, eventId: event.eventId, status: 'duplicate' } });
        }
        const result = await client.query(
            `INSERT INTO integration_events
                (tenant_id, integrated_app_id, event_id, event_type, handler_key, occurred_at, correlation_id, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
             RETURNING id, received_at`,
            [req.integration.tenantId, integrationId, event.eventId, event.eventType,
                currentPolicy.handler_key, event.occurredAt, event.correlationId, JSON.stringify(event.payload)],
        );
        if (result.rowCount === 0) {
            await client.query(
                `INSERT INTO integration_event_diagnostics
                    (tenant_id, integrated_app_id, request_id, event_id, event_type,
                     external_transaction_id, correlation_id, outcome, http_status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'duplicate',200)`,
                [req.integration.tenantId, integrationId, req.requestId, event.eventId, event.eventType,
                    typeof event.payload.externalTransactionId === 'string' ? event.payload.externalTransactionId.slice(0, 255) : null,
                    event.correlationId],
            );
            await client.query('COMMIT');
            return res.status(200).json({
                message: 'Integration event was already queued.',
                data: { integrationId, eventId: event.eventId, status: 'duplicate' },
            });
        }
        await client.query('UPDATE integrated_apps SET last_event_at = NOW(), updated_at = NOW() WHERE id = $1', [integrationId]);
        await client.query(
            `INSERT INTO integration_event_diagnostics
                (tenant_id, integrated_app_id, request_id, event_id, event_type,
                 external_transaction_id, correlation_id, outcome, http_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted',202)`,
            [req.integration.tenantId, integrationId, req.requestId, event.eventId, event.eventType,
                typeof event.payload.externalTransactionId === 'string' ? event.payload.externalTransactionId.slice(0, 255) : null,
                event.correlationId],
        );
        await client.query('COMMIT');
        return res.status(202).json({
            message: 'Integration event accepted for processing.',
            data: {
                integrationId,
                eventId: event.eventId,
                status: 'pending',
                receivedAt: result.rows[0].received_at,
            },
        });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {
            console.error(JSON.stringify({ event: 'transaction_rollback_failed', requestId: req.requestId }));
        });
        await recordIntegrationDiagnostic({ req, integration: req.integration, event: req.integrationEvent,
            outcome: 'ingestion_failed', errorCode: 'INGESTION_FAILED',
            errorSummary: 'The event could not be durably queued.', httpStatus: 500 });
        return next(error);
    } finally {
        client?.release();
    }
};
