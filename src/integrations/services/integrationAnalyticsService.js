import { pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { parseTimestampRange } from '../../util/validations.js';
import { resolveDashboardIntegration } from './integrationActivityService.js';

export const ANALYTICS_SCHEMA_VERSION = 1;
const EVENT_STATUSES = ['pending', 'processing', 'processed', 'failed'];
const DELIVERY_OUTCOMES = { accepted: 'accepted', duplicate: 'duplicate', invalid: 'invalid', ingestion_failed: 'ingestionFailed' };
const ADJUSTMENTS = ['increase', 'decrease', 'set'];

const toInt = (value) => (value === null || value === undefined ? 0 : Number(value));
const toNumberOrNull = (value) => (value === null || value === undefined ? null : Math.round(Number(value)));

// Shapes raw aggregate rows into the documented contract, zero-filling known categories.
// Money stays a decimal string, as PostgreSQL numeric sums are returned.
export const buildIntegrationAnalytics = ({ integrationId, from, to, eventRows, latencyRow, failureRows,
    deliveryRows, salesRows, commissionRows, adjustmentRows }) => {
    const byStatus = Object.fromEntries(EVENT_STATUSES.map((status) => [status, 0]));
    const byType = new Map();
    for (const row of eventRows) {
        const count = toInt(row.count);
        if (row.status in byStatus) byStatus[row.status] += count;
        const entry = byType.get(row.event_type) ?? { eventType: row.event_type, total: 0, ...Object.fromEntries(EVENT_STATUSES.map((s) => [s, 0])) };
        entry.total += count;
        if (row.status in entry) entry[row.status] += count;
        byType.set(row.event_type, entry);
    }
    const deliveries = Object.fromEntries(Object.values(DELIVERY_OUTCOMES).map((key) => [key, 0]));
    for (const row of deliveryRows) if (DELIVERY_OUTCOMES[row.outcome]) deliveries[DELIVERY_OUTCOMES[row.outcome]] += toInt(row.count);
    const byAdjustment = Object.fromEntries(ADJUSTMENTS.map((a) => [a, 0]));
    for (const row of adjustmentRows) if (row.adjustment in byAdjustment) byAdjustment[row.adjustment] += toInt(row.count);

    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const settled = byStatus.processed + byStatus.failed;
    return {
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        integrationId,
        window: { from: from.toISOString(), to: to.toISOString() },
        events: {
            total,
            byStatus,
            byType: [...byType.values()].sort((a, b) => b.total - a.total || a.eventType.localeCompare(b.eventType)),
            // Share of settled (processed or failed) events that succeeded; null when nothing has settled.
            successRate: settled ? byStatus.processed / settled : null,
            topFailureCodes: failureRows.map((row) => ({ errorCode: row.error_code ?? 'UNKNOWN', count: toInt(row.count) })),
        },
        deliveries,
        processingLatencyMs: {
            samples: toInt(latencyRow?.samples),
            average: toNumberOrNull(latencyRow?.average),
            p50: toNumberOrNull(latencyRow?.p50),
            p95: toNumberOrNull(latencyRow?.p95),
            max: toNumberOrNull(latencyRow?.max),
        },
        sales: {
            available: true,
            byCurrency: salesRows.map((row) => ({ currency: row.currency, transactions: toInt(row.transactions),
                quantity: toInt(row.quantity), grossAmount: row.gross_amount ?? '0.00' })),
        },
        commissions: {
            available: true,
            byCurrency: commissionRows.map((row) => ({ currency: row.currency, status: row.status,
                count: toInt(row.count), amount: row.amount ?? '0.00' })),
        },
        inventoryAdjustments: {
            available: true,
            total: Object.values(byAdjustment).reduce((a, b) => a + b, 0),
            byAdjustment,
        },
        limitations: [
            'Event, latency, and delivery figures cover events received in the window; processed source events are deleted after '
                + `${config.integrationEventRetentionDays} days and delivery diagnostics after ${config.integrationDiagnosticRetentionDays} days.`,
            'Processing latency is processed_at minus received_at and includes queue time until the next worker poll.',
            'Sales and commissions are windowed by the sale occurred_at time and grouped by currency; amounts are not converted.',
            'Inventory adjustments are counted from analytics outbox facts, which record the resulting stock level, not the adjusted quantity.',
            'Unauthenticated delivery attempts cannot be attributed to an integration and are excluded.',
        ],
    };
};

export const getIntegrationAnalytics = async (req, res, next) => {
    let client;
    try {
        const integration = await resolveDashboardIntegration(req, res);
        if (!integration) return undefined;
        if (Object.keys(req.query).some((key) => !['from', 'to', 'tenantId'].includes(key))) {
            return res.status(400).json({ message: 'Only from, to, and tenantId query parameters are supported.' });
        }
        const range = parseTimestampRange(req.query, { defaultDays: 30, maxDays: 366 });
        if (range.error) return res.status(400).json({ message: range.error });
        const scope = [integration.tenant_id, integration.id, range.from.toISOString(), range.to.toISOString()];

        client = await pool.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const eventWindow = 'tenant_id=$1 AND integrated_app_id=$2 AND received_at >= $3 AND received_at <= $4';
        const eventRows = await client.query(
            `SELECT event_type, status, COUNT(*)::int count FROM integration_events WHERE ${eventWindow} GROUP BY event_type, status`, scope);
        const latency = await client.query(
            `SELECT COUNT(*)::int samples, AVG(ms) average,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) p50,
                    percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) p95, MAX(ms) max
             FROM (SELECT EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000 ms FROM integration_events
                   WHERE ${eventWindow} AND status='processed' AND processed_at IS NOT NULL) samples`, scope);
        const failures = await client.query(
            `SELECT error_code, COUNT(*)::int count FROM integration_events WHERE ${eventWindow} AND status='failed'
             GROUP BY error_code ORDER BY count DESC, error_code LIMIT 10`, scope);
        const deliveries = await client.query(
            `SELECT outcome, COUNT(*)::int count FROM integration_event_diagnostics WHERE ${eventWindow} GROUP BY outcome`, scope);
        const sales = await client.query(
            `SELECT currency, COUNT(*)::int transactions, SUM(quantity)::bigint quantity, SUM(sale_amount)::numeric(14,2)::text gross_amount
             FROM sales_transactions WHERE tenant_id=$1 AND integrated_app_id=$2 AND occurred_at >= $3 AND occurred_at <= $4
             GROUP BY currency ORDER BY currency`, scope);
        const commissions = await client.query(
            `SELECT sc.currency, sc.status, COUNT(*)::int count, SUM(sc.commission_amount)::numeric(14,2)::text amount
             FROM sales_commissions sc JOIN sales_transactions st ON st.tenant_id=sc.tenant_id AND st.id=sc.sales_transaction_id
             WHERE st.tenant_id=$1 AND st.integrated_app_id=$2 AND st.occurred_at >= $3 AND st.occurred_at <= $4
             GROUP BY sc.currency, sc.status ORDER BY sc.currency, sc.status`, scope);
        const adjustments = await client.query(
            `SELECT payload->>'adjustment' adjustment, COUNT(*)::int count FROM analytics_outbox
             WHERE tenant_id=$1 AND source_integration_id=$2 AND event_type='inventory.adjusted'
               AND created_at >= $3 AND created_at <= $4 GROUP BY 1`, scope);
        await client.query('COMMIT');
        return res.status(200).json({ message: 'Integration analytics retrieved successfully.', data: buildIntegrationAnalytics({
            integrationId: integration.id, from: range.from, to: range.to,
            eventRows: eventRows.rows, latencyRow: latency.rows[0], failureRows: failures.rows, deliveryRows: deliveries.rows,
            salesRows: sales.rows, commissionRows: commissions.rows, adjustmentRows: adjustments.rows,
        }) });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally { client?.release(); }
};
