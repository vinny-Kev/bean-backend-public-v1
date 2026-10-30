import { pool } from '../../db/pool.js';
import {
    fail,
    idValue,
    isAssignee,
    objectBody,
    recordActivity,
    recordAudit,
    requireTicketReader,
    textValue,
    ticketRow,
    withTransaction,
} from './ticketShared.js';

export async function listComments(access, ticketId) {
    const ticket = await ticketRow(pool, access, idValue(ticketId, 'ticket ID'));
    await requireTicketReader(pool, access, ticket);
    const showInternal = access.manager || isAssignee(access, ticket);
    const result = await pool.query(
        `
        SELECT id, author_user_id, body, is_internal, created_at, updated_at
        FROM ticket_comments
        WHERE tenant_id = $1 AND ticket_id = $2 AND deleted_at IS NULL
          AND ($3::boolean OR is_internal = false)
        ORDER BY created_at ASC, id ASC
    `,
        [access.tenantId, ticket.id, showInternal],
    );
    return result.rows.map((row) => ({
        id: row.id,
        authorUserId: row.author_user_id,
        body: row.body,
        isInternal: row.is_internal,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
}

export async function addComment(access, ticketId, rawBody) {
    const body = objectBody(rawBody);
    const text = textValue(body.body, 'Comment', 10000, true);
    if (body.isInternal != null && typeof body.isInternal !== 'boolean') fail(400, 'isInternal must be a boolean.');
    const isInternal = body.isInternal === true;
    return withTransaction(async (client) => {
        const ticket = await ticketRow(client, access, idValue(ticketId, 'ticket ID'), true);
        await requireTicketReader(client, access, ticket);
        if (isInternal && !access.manager && !isAssignee(access, ticket)) {
            fail(403, 'Only managers or assignees can post internal comments.');
        }
        const result = await client.query(
            `
            INSERT INTO ticket_comments (tenant_id, ticket_id, author_user_id, body, is_internal)
            VALUES ($1,$2,$3,$4,$5)
            RETURNING id, author_user_id, body, is_internal, created_at, updated_at
        `,
            [access.tenantId, ticket.id, access.userId, text, isInternal],
        );
        const comment = result.rows[0];
        await recordActivity(client, access, ticket.id, 'comment_added', null, null, null, { commentId: comment.id, internal: isInternal });
        await recordAudit(client, access, ticket.id, 'TICKET_COMMENT', {
            commentId: comment.id,
            internal: isInternal,
        });
        return {
            id: comment.id,
            authorUserId: comment.author_user_id,
            body: comment.body,
            isInternal: comment.is_internal,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
        };
    });
}

export async function listActivity(access, ticketId) {
    const ticket = await ticketRow(pool, access, idValue(ticketId, 'ticket ID'));
    await requireTicketReader(pool, access, ticket);
    const showInternal = access.manager || isAssignee(access, ticket);
    const result = await pool.query(
        `
        SELECT id, actor_user_id, activity_type, field_name, old_value, new_value,
            metadata, created_at
        FROM ticket_activity
        WHERE tenant_id = $1 AND ticket_id = $2
          AND ($3::boolean OR NOT (activity_type = 'comment_added'
              AND metadata->>'internal' = 'true'))
        ORDER BY created_at ASC, id ASC
    `,
        [access.tenantId, ticket.id, showInternal],
    );
    return result.rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id,
        activityType: row.activity_type,
        fieldName: row.field_name,
        oldValue: row.old_value,
        newValue: row.new_value,
        metadata: row.metadata,
        createdAt: row.created_at,
    }));
}
