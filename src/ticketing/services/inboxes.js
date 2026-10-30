import { pool } from '../../db/pool.js';
import { fail, objectBody, recordAudit, requireManager, textValue, withTransaction } from './ticketShared.js';

const present = (row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    email: row.email,
    description: row.description,
    isActive: row.is_active,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

export async function listInboxes(access) {
    const result = await pool.query(
        `
        SELECT id, tenant_id, name, email, description, is_active,
            created_by_user_id, created_at, updated_at
        FROM ticket_inboxes
        WHERE tenant_id = $1 AND ($2::boolean OR is_active = true)
        ORDER BY name ASC, id ASC
    `,
        [access.tenantId, access.manager],
    );
    return result.rows.map(present);
}

export async function createInbox(access, rawBody) {
    requireManager(access);
    const body = objectBody(rawBody);
    const name = textValue(body.name, 'Inbox name', 150, true);
    const email = textValue(body.email, 'Inbox email', 320, true)?.toLowerCase();
    const description = textValue(body.description, 'Description', 2000);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'A valid inbox email is required.');
    return withTransaction(async (client) => {
        const result = await client.query(
            `
            INSERT INTO ticket_inboxes (tenant_id, name, email, description, created_by_user_id)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (tenant_id, email) DO NOTHING
            RETURNING id, tenant_id, name, email, description, is_active,
                created_by_user_id, created_at, updated_at
        `,
            [access.tenantId, name, email, description, access.userId],
        );
        if (!result.rows[0]) fail(409, 'An inbox with this email already exists.');
        await recordAudit(
            client,
            access,
            result.rows[0].id,
            'TICKET_INBOX_CREATE',
            { inboxId: result.rows[0].id, email },
            'ticket_inboxes',
        );
        return present(result.rows[0]);
    });
}
