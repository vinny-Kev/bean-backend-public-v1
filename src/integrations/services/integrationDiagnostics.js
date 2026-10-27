import { pool } from '../../db/pool.js';

const safeString = (value, max = 255) => typeof value === 'string' && value.length <= max ? value : null;

export const recordIntegrationDiagnostic = async ({ req, integration = null, event = null,
    outcome, errorCode = null, errorSummary = null, httpStatus }) => {
    try {
        await pool.query(
            `INSERT INTO integration_event_diagnostics
                (tenant_id, integrated_app_id, request_id, event_id, event_type,
                 external_transaction_id, correlation_id, outcome, error_code, error_summary, http_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [integration?.tenantId ?? null, integration?.id ?? null, req.requestId,
                safeString(event?.eventId), safeString(event?.eventType, 100),
                safeString(event?.payload?.externalTransactionId), safeString(event?.correlationId),
                outcome, errorCode, errorSummary, httpStatus],
        );
    } catch {
        console.error(JSON.stringify({ event: 'integration_diagnostic_write_failed', requestId: req.requestId }));
    }
};
