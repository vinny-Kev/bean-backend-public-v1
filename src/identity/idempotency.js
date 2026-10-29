import { createHash } from 'node:crypto';

// Idempotency-Key support (see db/migrations/016_idempotency_keys.sql). The first request stores its
// response in the same transaction as its effects; a retry with the same key replays that response
// instead of repeating the work. Keys are per user and per scope.

export const readIdempotencyKey = (req) => {
    const value = req.get('idempotency-key');
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{8,100}$/.test(value) ? value : null;
};

export const hashRequest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Call inside a transaction. Returns { proceed:true } | { replay:{status, body} } | { conflict:{status, code, message} }.
export const beginIdempotent = async (client, { userId, scope, key, requestHash }) => {
    await client.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '1 day' AND user_id = $1`, [userId]);
    const inserted = await client.query(
        `INSERT INTO idempotency_keys (user_id, scope, key, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [userId, scope, key, requestHash],
    );
    if (inserted.rowCount) return { proceed: true };
    const existing = (await client.query(
        'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND key = $3', [userId, scope, key],
    )).rows[0];
    if (!existing || existing.request_hash !== requestHash) {
        return { conflict: { status: 422, code: 'IDEMPOTENCY_KEY_REUSED', message: 'That Idempotency-Key was already used with different details.' } };
    }
    if (existing.response_body === null) {
        return { conflict: { status: 409, code: 'REQUEST_IN_PROGRESS', message: 'This request is still being processed.' } };
    }
    return { replay: { status: existing.status_code, body: existing.response_body } };
};

export const finishIdempotent = (client, { userId, scope, key }, status, body) => client.query(
    'UPDATE idempotency_keys SET status_code = $4, response_body = $5::jsonb WHERE user_id = $1 AND scope = $2 AND key = $3',
    [userId, scope, key, status, JSON.stringify(body)],
);
