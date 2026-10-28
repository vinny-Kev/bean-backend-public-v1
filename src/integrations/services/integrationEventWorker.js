import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { config } from '../../config.js';
import { classifyIntegrationFailure, IntegrationProcessingError, nextIntegrationRetryAt } from './integrationReliability.js';
import { randomUUID } from 'node:crypto';
import { resolveIntegrationHandlerKind } from './integrationHandlerRegistry.js';
import { getInventoryShortageBehavior } from './integrationPolicy.js';
import { compareToPattern } from '../../util/validations.js';

const processSale = async (client, event) => {
    const p = event.payload;
    if (typeof p.externalTransactionId !== 'string' || typeof p.productId !== 'string'
        || !Number.isSafeInteger(p.quantity) || p.quantity <= 0 || typeof p.externalUserId !== 'string'
        || p.status !== 'completed' || !Number.isFinite(new Date(event.occurred_at).getTime())
        || !compareToPattern(String(p.saleAmount), 'money_amount')
        || typeof p.currency !== 'string' || !compareToPattern(p.currency, 'currency_code')) {
        throw new IntegrationProcessingError('INVALID_SALE', 'transaction.completed business fields are invalid.', 'permanent');
    }

    const mapping = await client.query(
        `SELECT user_id FROM integration_user_mappings
         WHERE tenant_id = $1 AND integrated_app_id = $2 AND external_user_id = $3 AND is_active = true`,
        [event.tenant_id, event.integrated_app_id, p.externalUserId],
    );
    if (!mapping.rowCount) throw new IntegrationProcessingError('EMPLOYEE_MAPPING_MISSING', 'No active employee mapping exists for this integration user.', 'action_required');

    const settings = await client.query(
        'SELECT inventory_shortage_policy FROM tenant_integration_settings WHERE tenant_id=$1 FOR SHARE', [event.tenant_id],
    );
    const inventoryBehavior = getInventoryShortageBehavior(settings.rows[0]?.inventory_shortage_policy);
    const { policy: inventoryPolicy } = inventoryBehavior;
    let stockAction = 'deducted';
    let stock;
    if (!inventoryBehavior.deductStock) {
        stockAction = 'not_deducted_by_tenant_policy';
        stock = await client.query(
            'SELECT id FROM inventory WHERE tenant_id=$1 AND sku=$2 FOR UPDATE', [event.tenant_id, p.productId],
        );
    } else {
        stock = await client.query(
            `UPDATE inventory SET quantity = quantity - $1, updated_at = NOW()
             WHERE tenant_id = $2 AND sku = $3 ${inventoryBehavior.allowNegative ? '' : 'AND quantity >= $1'} RETURNING id`,
            [p.quantity, event.tenant_id, p.productId],
        );
    }
    if (!stock.rowCount) throw new IntegrationProcessingError('INVENTORY_UNAVAILABLE',
        inventoryPolicy === 'require_intervention'
            ? 'Product inventory is missing or insufficient under the tenant policy.'
            : 'Product inventory is missing.', 'action_required');

    const sale = await client.query(
        `INSERT INTO sales_transactions
            (tenant_id, integrated_app_id, source_event_id, external_transaction_id, product_id,
             quantity, status, occurred_at, sale_amount, currency, inventory_policy_snapshot,
             source_event_key, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
         RETURNING id, sale_amount, currency`,
        [event.tenant_id, event.integrated_app_id, event.id, p.externalTransactionId, p.productId,
            p.quantity, p.status, event.occurred_at, p.saleAmount, p.currency,
            JSON.stringify({ policy: inventoryPolicy, action: stockAction }), event.event_id, event.correlation_id],
    );
    const rule = await client.query(
        'SELECT commission_rate FROM commission_rules WHERE tenant_id = $1 AND is_active = true FOR SHARE',
        [event.tenant_id],
    );
    if (rule.rowCount) {
        await client.query(
            `INSERT INTO sales_commissions
                (tenant_id, sales_transaction_id, user_id, sale_amount, commission_rate, commission_amount, currency)
             VALUES ($1,$2,$3,$4,$5,ROUND($4::numeric * $5::numeric,2),$6)`,
            [event.tenant_id, sale.rows[0].id, mapping.rows[0].user_id, sale.rows[0].sale_amount,
                rule.rows[0].commission_rate, sale.rows[0].currency],
        );
    }
    await client.query(
        `INSERT INTO analytics_outbox
            (tenant_id, source_event_id, source_integration_id, source_event_key, correlation_id, event_type, payload)
         VALUES ($1,$2,$3,$4,$5,'sale.processed',$6::jsonb)`,
        [event.tenant_id, event.id, event.integrated_app_id, event.event_id, event.correlation_id,
            JSON.stringify({ saleId: sale.rows[0].id, productId: p.productId,
            externalTransactionId: p.externalTransactionId, quantity: p.quantity,
            saleAmount: sale.rows[0].sale_amount, currency: sale.rows[0].currency,
            userId: mapping.rows[0].user_id, occurredAt: event.occurred_at,
            inventoryPolicy, inventoryAction: stockAction,
            correlationId: event.correlation_id })],
    );
};

const processInventoryAdjustment = async (client, event) => {
    const { productId, quantity, adjustment } = event.payload;
    if (typeof productId !== 'string' || !Number.isSafeInteger(quantity) || quantity < 1
        || !['increase', 'decrease', 'set'].includes(adjustment)) {
        throw new IntegrationProcessingError('INVALID_INVENTORY_ADJUSTMENT', 'Inventory adjustment fields are invalid.', 'permanent');
    }
    const expression = adjustment === 'increase' ? 'quantity + $1' : adjustment === 'decrease' ? 'quantity - $1' : '$1';
    const guard = adjustment === 'decrease' ? 'AND quantity >= $1' : '';
    const result = await client.query(
        `UPDATE inventory SET quantity = ${expression}, updated_at = NOW()
         WHERE tenant_id = $2 AND sku = $3 ${guard} RETURNING id, sku, quantity`,
        [quantity, event.tenant_id, productId],
    );
    if (!result.rowCount) throw new IntegrationProcessingError('INVENTORY_UNAVAILABLE', 'Inventory item is missing or adjustment would make stock negative.', 'action_required');
    await client.query(
        `INSERT INTO analytics_outbox
            (tenant_id, source_event_id, source_integration_id, source_event_key, correlation_id, event_type, payload)
         VALUES ($1,$2,$3,$4,$5,'inventory.adjusted',$6::jsonb)`,
        [event.tenant_id, event.id, event.integrated_app_id, event.event_id, event.correlation_id,
            JSON.stringify({ productId, adjustment, ...result.rows[0], correlationId: event.correlation_id })],
    );
};

const handlers = new Map([
    ['sale', processSale],
    ['inventory_adjustment', processInventoryAdjustment],
]);

const workerId = `${process.pid}:${randomUUID()}`;

const rollbackQuietly = async (client) => client.query('ROLLBACK').catch(() => {});

const recoverExpiredLeases = async (client) => {
    await client.query('BEGIN');
    try {
        const expired = await client.query(
            `SELECT id, tenant_id, attempt_count, automatic_attempt_count, correlation_id FROM integration_events
             WHERE status = 'processing' AND lease_expires_at <= NOW()
             ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT $1`,
            [config.integrationWorkerBatchSize],
        );
        for (const event of expired.rows) {
            const retryAt = nextIntegrationRetryAt({ attemptNumber: event.automatic_attempt_count,
                maxAttempts: config.integrationMaxAttempts, delays: config.integrationRetryDelaysMs });
            const outcome = retryAt ? 'retry_scheduled' : 'failed';
            await client.query(
                `UPDATE integration_events SET status=$2::text, next_attempt_at=$3,
                 last_failed_at=NOW(), processed_at=CASE WHEN $2::text='failed' THEN NOW() ELSE NULL END,
                 lease_expires_at=NULL, lease_owner=NULL, processing_started_at=NULL,
                error_code='WORKER_LEASE_EXPIRED',
                failure_classification=CASE WHEN $2::text='failed' THEN 'action_required' ELSE 'transient' END,
                 error_message='Worker lease expired before the attempt completed.' WHERE id=$1`,
                [event.id, retryAt ? 'pending' : 'failed', retryAt],
            );
            await client.query(
                `UPDATE integration_event_attempts SET finished_at=NOW(), outcome=$2,
                 error_code='WORKER_LEASE_EXPIRED', error_summary='Worker lease expired before the attempt completed.',
                 failure_classification='transient', retry_at=$3
                 WHERE integration_event_id=$1 AND attempt_number=$4 AND outcome='started'`,
                [event.id, outcome, retryAt, event.attempt_count],
            );
            await composeAuditLogs(auditLog({ tenantId: event.tenant_id, action: 'RECOVER INTEGRATION EVENT LEASE',
                tableName: 'integration_events', recordId: event.id,
                newData: { status: retryAt ? 'pending' : 'failed', errorCode: 'WORKER_LEASE_EXPIRED', retryAt } }), client);
        }
        await client.query('COMMIT');
        return expired.rowCount;
    } catch (error) {
        await rollbackQuietly(client);
        throw error;
    }
};

const claimEvents = async (client, batchSize) => {
    await client.query('BEGIN');
    try {
        const result = await client.query(
            `WITH candidates AS (
                SELECT e.id, r.is_active FROM integration_events e
                LEFT JOIN event_registry r ON r.event_type=e.event_type
                WHERE e.status='pending' AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= NOW())
                ORDER BY e.received_at,e.id FOR UPDATE OF e SKIP LOCKED LIMIT $1
             )
             UPDATE integration_events e SET status='processing', attempt_count=attempt_count+1,
                automatic_attempt_count=automatic_attempt_count+1,
                processing_started_at=NOW(), last_attempt_at=NOW(),
                lease_expires_at=NOW() + ($2::int * INTERVAL '1 millisecond'), lease_owner=$3, next_attempt_at=NULL
             FROM candidates c
             WHERE e.id=c.id
             RETURNING e.*, CASE WHEN c.is_active THEN e.handler_key ELSE NULL END AS handler_key`,
            [batchSize, config.integrationLeaseMs, workerId],
        );
        for (const event of result.rows) {
            await client.query(
                `INSERT INTO integration_event_attempts
                    (integration_event_id, tenant_id, integrated_app_id, event_id, event_type, external_transaction_id,
                     attempt_number, worker_id, correlation_id, initiated_by_user_id, retry_reason)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [event.id, event.tenant_id, event.integrated_app_id, event.event_id, event.event_type,
                    typeof event.payload?.externalTransactionId === 'string'
                        ? event.payload.externalTransactionId.slice(0, 255) : null,
                    event.attempt_count, workerId, event.correlation_id,
                    event.retry_requested_by_user_id, event.retry_reason],
            );
            if (event.retry_requested_by_user_id) {
                await client.query('UPDATE integration_events SET retry_requested_by_user_id=NULL, retry_reason=NULL WHERE id=$1', [event.id]);
            }
        }
        await client.query('COMMIT');
        return result.rows;
    } catch (error) {
        await rollbackQuietly(client);
        throw error;
    }
};

const processClaimedEvent = async (client, event) => {
    await client.query('BEGIN');
    try {
        const lease = await client.query(
            `SELECT id FROM integration_events WHERE id=$1 AND status='processing'
             AND lease_owner=$2 FOR UPDATE`, [event.id, workerId],
        );
        if (!lease.rowCount) { await client.query('ROLLBACK'); return 'lease_lost'; }
        const tenant = await client.query('SELECT status FROM tenants WHERE id=$1 FOR SHARE', [event.tenant_id]);
        if (tenant.rows[0]?.status !== 'active') {
            throw new IntegrationProcessingError('TENANT_INACTIVE', 'The tenant is not active; business effects were not applied.', 'action_required');
        }
        const handler = handlers.get(resolveIntegrationHandlerKind(event.handler_key));
        if (!handler) throw new IntegrationProcessingError('UNSUPPORTED_HANDLER', 'No supported handler is configured for this event type.', 'permanent');
        await handler(client, event);
        await client.query(
            `UPDATE integration_events SET status='processed', processed_at=NOW(),
             processing_started_at=NULL, lease_expires_at=NULL, lease_owner=NULL, error_message=NULL,
             error_code=NULL, failure_classification=NULL WHERE id=$1 AND status='processing' AND lease_owner=$2`, [event.id, workerId],
        );
        await client.query(
            `UPDATE integration_event_attempts SET finished_at=NOW(), outcome='processed'
             WHERE integration_event_id=$1 AND attempt_number=$2 AND outcome='started'`,
            [event.id, event.attempt_count],
        );
        await composeAuditLogs(auditLog({ tenantId: event.tenant_id, action: 'PROCESS INTEGRATION EVENT', tableName: 'integration_events',
            recordId: event.id, newData: { eventType: event.event_type, handler: event.handler_key, status: 'processed' } }), client);
        await client.query('COMMIT');
        return 'processed';
    } catch (error) {
        await rollbackQuietly(client);
        const failure = classifyIntegrationFailure(error);
        const retryAt = failure.classification === 'transient'
            ? nextIntegrationRetryAt({ attemptNumber: event.automatic_attempt_count, maxAttempts: config.integrationMaxAttempts,
                delays: config.integrationRetryDelaysMs })
            : null;
        const status = retryAt ? 'pending' : 'failed';
        await client.query('BEGIN');
        try {
            await client.query(
                `UPDATE integration_events SET status=$2::text, processed_at=CASE WHEN $2::text='failed' THEN NOW() ELSE NULL END,
                 processing_started_at=NULL, lease_expires_at=NULL, lease_owner=NULL, next_attempt_at=$3,
                 last_failed_at=NOW(), error_code=$4,
                 failure_classification=CASE WHEN $2::text='failed' AND $5::text='transient' THEN 'action_required' ELSE $5::text END,
                 error_message=$6
                 WHERE id=$1 AND status='processing' AND lease_owner=$7`,
                [event.id, status, retryAt, failure.code, failure.classification, failure.summary, workerId],
            );
            await client.query(
                `UPDATE integration_event_attempts SET finished_at=NOW(), outcome=$3,
                 error_code=$4, error_summary=$5, failure_classification=$6, retry_at=$7
                 WHERE integration_event_id=$1 AND attempt_number=$2 AND outcome='started'`,
                [event.id, event.attempt_count, retryAt ? 'retry_scheduled' : 'failed',
                    failure.code, failure.summary, failure.classification, retryAt],
            );
            await composeAuditLogs(auditLog({ tenantId: event.tenant_id, action: 'FAIL INTEGRATION EVENT', tableName: 'integration_events',
                recordId: event.id, newData: { eventType: event.event_type, handler: event.handler_key,
                    status, errorCode: failure.code, retryAt } }), client);
            await client.query('COMMIT');
        } catch (recordError) {
            await rollbackQuietly(client);
            throw recordError;
        }
        return status;
    }
};

export const processIntegrationEventBatch = async ({ batchSize = config.integrationWorkerBatchSize } = {}) => {
    const client = await pool.connect();
    try {
        await recoverExpiredLeases(client);
        let processed = 0;
        while (processed < batchSize) {
            const events = await claimEvents(client, 1);
            if (!events.length) break;
            await processClaimedEvent(client, events[0]);
            processed += 1;
        }
        return processed;
    } finally { client.release(); }
};

export const startIntegrationEventWorker = ({ intervalMs = config.integrationWorkerIntervalMs,
    batchSize = config.integrationWorkerBatchSize } = {}) => {
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            const count = await processIntegrationEventBatch({ batchSize });
            if (count) console.log(JSON.stringify({ event: 'integration_event_batch_processed', count }));
        } catch {
            console.error(JSON.stringify({ event: 'integration_event_worker_failed' }));
        } finally { running = false; }
    };
    const timer = setInterval(run, intervalMs);
    timer.unref();
    void run();
    return () => clearInterval(timer);
};
