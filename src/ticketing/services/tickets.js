import { pool } from '../../db/pool.js';
import {
    dateValue,
    enumValue,
    fail,
    idValue,
    isAssignee,
    objectBody,
    optionalId,
    presentTicket,
    recordActivity,
    recordAudit,
    requireManager,
    requireTicketReader,
    ensureTenantUser,
    textValue,
    ticketRow,
    withTransaction,
} from './ticketShared.js';

const types = ['support', 'task', 'hr_task', 'bug', 'incident'];
const priorities = ['low', 'medium', 'high', 'urgent'];
const statuses = ['open', 'acknowledged', 'in_progress', 'pending', 'resolved', 'closed', 'cancelled'];
const nextStatus = {
    open: ['acknowledged', 'in_progress', 'cancelled'],
    acknowledged: ['in_progress', 'pending', 'resolved', 'cancelled'],
    in_progress: ['pending', 'resolved', 'cancelled'],
    pending: ['in_progress', 'resolved', 'cancelled'],
    resolved: ['in_progress', 'closed'],
    closed: [],
    cancelled: [],
};

export async function listTickets(access, query) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 20 ||
        !Number.isSafeInteger((page - 1) * limit)
    )
        fail(400, 'Invalid pagination.');
    const status = query.status == null ? null : enumValue(query.status, statuses, 'status');
    const ticketType = query.ticketType == null ? null : enumValue(query.ticketType, types, 'ticket type');
    const where = `
        t.tenant_id = $1 AND ($2::boolean OR t.requester_user_id = $3 OR
        t.created_by_user_id = $3 OR t.assigned_to_user_id = $3 OR EXISTS (
            SELECT 1 FROM ticket_assignments a
            WHERE a.tenant_id = t.tenant_id AND a.ticket_id = t.id
              AND a.user_id = $3 AND a.unassigned_at IS NULL
        )) AND ($4::text IS NULL OR t.status = $4)
        AND ($5::text IS NULL OR t.ticket_type = $5)
    `;
    const params = [access.tenantId, access.manager, access.userId, status, ticketType];
    const [count, rows] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total FROM tickets t WHERE ${where}`, params),
        pool.query(
            `SELECT t.* FROM tickets t WHERE ${where}
                    ORDER BY t.created_at DESC, t.id DESC LIMIT $6 OFFSET $7`,
            [...params, limit, (page - 1) * limit],
        ),
    ]);
    const total = count.rows[0].total;
    return {
        data: rows.rows.map(presentTicket),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore: page * limit < total,
        },
    };
}

export async function getTicket(access, ticketId) {
    const row = await ticketRow(pool, access, idValue(ticketId, 'ticket ID'));
    await requireTicketReader(pool, access, row);
    return presentTicket(row);
}

export async function createTicket(access, rawBody) {
    const body = objectBody(rawBody);
    const title = textValue(body.title, 'Title', 250, true);
    const description = textValue(body.description, 'Description', 10000);
    const ticketType = enumValue(body.ticketType ?? 'support', types, 'ticket type');
    const priority = enumValue(body.priority ?? 'medium', priorities, 'priority');
    const inboxId = optionalId(body.inboxId, 'inbox ID');
    const parentTicketId = optionalId(body.parentTicketId, 'parent ticket ID');
    const requesterUserId = optionalId(body.requesterUserId, 'requester user ID') ?? access.userId;
    const dueAt = dateValue(body.dueAt, 'due date');
    if (!access.manager && requesterUserId !== access.userId) {
        fail(403, 'You can only create tickets for yourself.');
    }
    return withTransaction(async (client) => {
        await ensureTenantUser(client, access.tenantId, requesterUserId);
        if (inboxId) {
            const inbox = await client.query(
                `
                SELECT 1 FROM ticket_inboxes
                WHERE tenant_id = $1 AND id = $2 AND is_active = true
            `,
                [access.tenantId, inboxId],
            );
            if (!inbox.rows[0]) fail(400, 'Inbox not found for this tenant.');
        }
        if (parentTicketId) {
            const parent = await ticketRow(client, access, parentTicketId);
            await requireTicketReader(client, access, parent);
        }
        const result = await client.query(
            `
            INSERT INTO tickets (tenant_id, title, description, ticket_type, priority,
                requester_user_id, inbox_id, created_by_user_id, parent_ticket_id, due_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
        `,
            [access.tenantId, title, description, ticketType, priority, requesterUserId, inboxId, access.userId, parentTicketId, dueAt],
        );
        const ticket = result.rows[0];
        await recordActivity(client, access, ticket.id, 'created', null, null, {
            ticketType,
            status: 'open',
        });
        await recordAudit(client, access, ticket.id, 'TICKET_CREATE', {
            ticketType,
            requesterUserId,
        });
        return presentTicket(ticket);
    });
}

export async function listAssignments(access, ticketId) {
    const row = await ticketRow(pool, access, idValue(ticketId, 'ticket ID'));
    await requireTicketReader(pool, access, row);
    const result = await pool.query(
        `
        SELECT id, user_id, assigned_by_user_id, is_primary, assigned_at, unassigned_at, notes
        FROM ticket_assignments WHERE tenant_id = $1 AND ticket_id = $2
        ORDER BY assigned_at DESC, id DESC
    `,
        [access.tenantId, row.id],
    );
    return result.rows.map((a) => ({
        id: a.id,
        userId: a.user_id,
        assignedByUserId: a.assigned_by_user_id,
        isPrimary: a.is_primary,
        assignedAt: a.assigned_at,
        unassignedAt: a.unassigned_at,
        notes: access.manager ? a.notes : null,
    }));
}

export async function assignTicket(access, ticketId, rawBody) {
    requireManager(access);
    const body = objectBody(rawBody);
    const userId = idValue(body.userId, 'assignee user ID');
    const notes = textValue(body.notes, 'Assignment notes', 2000);
    return withTransaction(async (client) => {
        const ticket = await ticketRow(client, access, idValue(ticketId, 'ticket ID'), true);
        if (['resolved', 'closed', 'cancelled'].includes(ticket.status)) fail(409, 'This ticket cannot be assigned.');
        await ensureTenantUser(client, access.tenantId, userId);
        if (String(ticket.assigned_to_user_id) === userId) return presentTicket(ticket);
        await client.query(
            `
            UPDATE ticket_assignments SET unassigned_at = now()
            WHERE tenant_id = $1 AND ticket_id = $2 AND unassigned_at IS NULL
        `,
            [access.tenantId, ticket.id],
        );
        await client.query(
            `
            INSERT INTO ticket_assignments
                (tenant_id, ticket_id, user_id, assigned_by_user_id, is_primary, notes)
            VALUES ($1,$2,$3,$4,true,$5)
        `,
            [access.tenantId, ticket.id, userId, access.userId, notes],
        );
        const result = await client.query(
            `
            UPDATE tickets SET assigned_to_user_id = $3, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 RETURNING *
        `,
            [access.tenantId, ticket.id, userId],
        );
        await recordActivity(client, access, ticket.id, 'assigned', 'assignedToUserId', ticket.assigned_to_user_id, userId);
        await recordAudit(client, access, ticket.id, 'TICKET_ASSIGN', {
            assignedToUserId: userId,
        });
        return presentTicket(result.rows[0]);
    });
}

export async function acknowledgeTicket(access, ticketId) {
    return withTransaction(async (client) => {
        const ticket = await ticketRow(client, access, idValue(ticketId, 'ticket ID'), true);
        if (!isAssignee(access, ticket)) fail(403, 'Only the assigned employee can acknowledge this ticket.');
        if (ticket.status !== 'open' || ticket.acknowledged_at) fail(409, 'Ticket cannot be acknowledged now.');
        const result = await client.query(
            `
            UPDATE tickets SET status = 'acknowledged', acknowledged_at = now(), updated_at = now()
            WHERE tenant_id = $1 AND id = $2 RETURNING *
        `,
            [access.tenantId, ticket.id],
        );
        await recordActivity(client, access, ticket.id, 'acknowledged', 'status', 'open', 'acknowledged');
        await recordAudit(client, access, ticket.id, 'TICKET_ACKNOWLEDGE');
        return presentTicket(result.rows[0]);
    });
}

export async function changeStatus(access, ticketId, rawBody) {
    const body = objectBody(rawBody);
    const status = enumValue(body.status, statuses, 'status');
    return withTransaction(async (client) => {
        const ticket = await ticketRow(client, access, idValue(ticketId, 'ticket ID'), true);
        if (!access.manager && !isAssignee(access, ticket)) fail(403, 'Only managers or the assigned employee can change status.');
        if (['cancelled', 'closed'].includes(status)) requireManager(access);
        if (!nextStatus[ticket.status]?.includes(status)) fail(409, 'Invalid ticket status transition.');
        if (ticket.status === 'resolved' && status === 'in_progress') {
            const verified = await client.query(
                `
                SELECT 1 FROM ticket_work_verifications
                WHERE tenant_id = $1 AND ticket_id = $2 AND verification_status = 'verified' LIMIT 1
            `,
                [access.tenantId, ticket.id],
            );
            if (verified.rows[0]) fail(409, 'Revoke verified work before reopening this ticket.');
        }
        const result = await client.query(
            `
            UPDATE tickets SET status = $3,
                resolved_at = CASE WHEN $3 = 'resolved' THEN now()
                    WHEN $3 = 'in_progress' THEN NULL ELSE resolved_at END,
                closed_at = CASE WHEN $3 = 'closed' THEN now() ELSE closed_at END,
                updated_at = now()
            WHERE tenant_id = $1 AND id = $2 RETURNING *
        `,
            [access.tenantId, ticket.id, status],
        );
        await recordActivity(client, access, ticket.id, 'status_changed', 'status', ticket.status, status);
        await recordAudit(client, access, ticket.id, 'TICKET_STATUS', { status });
        return presentTicket(result.rows[0]);
    });
}
