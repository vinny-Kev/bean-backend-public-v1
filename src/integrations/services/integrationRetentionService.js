import { pool } from '../../db/pool.js';
import { config } from '../../config.js';

const deleteBatch = async (client, table, timestamp, days, batchSize, extraPredicate = '') => {
    const result = await client.query(
        `WITH expired AS (
            SELECT id FROM ${table}
            WHERE ${timestamp} < NOW() - ($1::int * INTERVAL '1 day') ${extraPredicate}
            ORDER BY ${timestamp}, id
            FOR UPDATE SKIP LOCKED LIMIT $2
         ) DELETE FROM ${table} target USING expired WHERE target.id=expired.id`,
        [days, batchSize],
    );
    return result.rowCount;
};

export const runIntegrationRetentionBatch = async ({ batchSize = config.integrationRetentionBatchSize } = {}) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const outbox = await deleteBatch(client, 'analytics_outbox', 'processed_at', config.analyticsOutboxRetentionDays,
            batchSize, "AND status='processed'");
        const events = await deleteBatch(client, 'integration_events', 'processed_at', config.integrationEventRetentionDays,
            batchSize, "AND status='processed'");
        const attempts = await deleteBatch(client, 'integration_event_attempts', 'finished_at', config.integrationAttemptRetentionDays,
            batchSize, 'AND finished_at IS NOT NULL');
        const diagnostics = await deleteBatch(client, 'integration_event_diagnostics', 'received_at', config.integrationDiagnosticRetentionDays,
            batchSize);
        await client.query('COMMIT');
        return { outbox, events, attempts, diagnostics };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
};

export const startIntegrationRetentionWorker = ({ intervalMs = config.integrationRetentionIntervalMs } = {}) => {
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            const deleted = await runIntegrationRetentionBatch();
            if (Object.values(deleted).some(Boolean)) console.log(JSON.stringify({ event: 'integration_retention_batch_completed', deleted }));
        } catch {
            console.error(JSON.stringify({ event: 'integration_retention_batch_failed' }));
        } finally { running = false; }
    };
    const timer = setInterval(run, intervalMs);
    timer.unref();
    void run();
    return () => clearInterval(timer);
};
