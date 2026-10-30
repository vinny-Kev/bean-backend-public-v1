import { pool } from '../../db/pool.js';
import {
    ensureTenantUser,
    fail,
    idValue,
    objectBody,
    pointsValue,
    recordActivity,
    recordAudit,
    requireManager,
    requireTicketReader,
    textValue,
    ticketRow,
    withTransaction,
} from './ticketShared.js';

const presentEstimate = (row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    estimatedPoints: row.estimated_points,
    estimatedByUserId: row.estimated_by_user_id,
    estimateNotes: row.estimate_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});
const presentVerification = (row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    contributorUserId: row.contributor_user_id,
    verifiedPoints: row.verified_points,
    verifiedByUserId: row.verified_by_user_id,
    verificationStatus: row.verification_status,
    verificationNotes: row.verification_notes,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id,
});

export async function getEstimate(access, ticketId) {
    const ticket = await ticketRow(pool, access, idValue(ticketId, 'ticket ID'));
    await requireTicketReader(pool, access, ticket);
    const result = await pool.query(
        `
        SELECT id, ticket_id, estimated_points, estimated_by_user_id,
            estimate_notes, created_at, updated_at
        FROM ticket_story_points WHERE tenant_id = $1 AND ticket_id = $2
    `,
        [access.tenantId, ticket.id],
    );
    return result.rows[0] ? presentEstimate(result.rows[0]) : null;
}

export async function setEstimate(access, ticketId, rawBody) {
    requireManager(access);
    const body = objectBody(rawBody);
    const points = pointsValue(body.estimatedPoints, 'Estimated points');
    const notes = textValue(body.estimateNotes, 'Estimate notes', 2000);
    return withTransaction(async (client) => {
        const ticket = await ticketRow(client, access, idValue(ticketId, 'ticket ID'), true);
        if (['closed', 'cancelled'].includes(ticket.status)) fail(409, 'This ticket cannot be estimated now.');
        const verified = await client.query(
            `
            SELECT COALESCE(SUM(verified_points),0) AS total
            FROM ticket_work_verifications
            WHERE tenant_id = $1 AND ticket_id = $2 AND verification_status = 'verified'
        `,
            [access.tenantId, ticket.id],
        );
        const fits = await client.query('SELECT $1::numeric >= $2::numeric AS fits', [points, verified.rows[0].total]);
        if (!fits.rows[0].fits) fail(409, 'Estimate cannot be below already verified points.');
        const result = await client.query(
            `
            INSERT INTO ticket_story_points
                (tenant_id, ticket_id, estimated_points, estimated_by_user_id, estimate_notes)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (ticket_id) DO UPDATE SET
                estimated_points = EXCLUDED.estimated_points,
                estimated_by_user_id = EXCLUDED.estimated_by_user_id,
                estimate_notes = EXCLUDED.estimate_notes,
                updated_at = now()
            RETURNING id, ticket_id, estimated_points, estimated_by_user_id,
                estimate_notes, created_at, updated_at
        `,
            [access.tenantId, ticket.id, points, access.userId, notes],
        );
        await recordActivity(client, access, ticket.id, 'estimate_changed', 'estimatedPoints', null, points);
        await recordAudit(client, access, ticket.id, 'TICKET_ESTIMATE', {
            estimatedPoints: points,
        });
        return presentEstimate(result.rows[0]);
    });
}

export async function listVerifications(access, ticketId) {
    const ticket = await ticketRow(pool, access, idValue(ticketId, 'ticket ID'));
    await requireTicketReader(pool, access, ticket);
    const result = await pool.query(
        `
        SELECT id, ticket_id, contributor_user_id, verified_points, verified_by_user_id,
            verification_status, verification_notes, verified_at, revoked_at, revoked_by_user_id
        FROM ticket_work_verifications
        WHERE tenant_id = $1 AND ticket_id = $2
          AND ($3::boolean OR contributor_user_id = $4)
        ORDER BY verified_at DESC, id DESC
    `,
        [access.tenantId, ticket.id, access.manager, access.userId],
    );
    return result.rows.map(presentVerification);
}

export async function verifyWork(access, ticketId, rawBody) {
    requireManager(access);
    const body = objectBody(rawBody);
    const contributorUserId = idValue(body.contributorUserId, 'contributor user ID');
    const points = pointsValue(body.verifiedPoints, 'Verified points', true);
    const notes = textValue(body.verificationNotes, 'Verification notes', 2000);
    if (contributorUserId === access.userId) fail(403, 'Work cannot be self-verified.');
    return withTransaction(async (client) => {
        const ticket = await ticketRow(client, access, idValue(ticketId, 'ticket ID'), true);
        if (!['resolved', 'closed'].includes(ticket.status)) fail(409, 'Resolve the ticket before verifying work.');
        await ensureTenantUser(client, access.tenantId, contributorUserId);
        const assignment = await client.query(
            `
            SELECT 1 FROM ticket_assignments
            WHERE tenant_id = $1 AND ticket_id = $2 AND user_id = $3 LIMIT 1
        `,
            [access.tenantId, ticket.id, contributorUserId],
        );
        if (!assignment.rows[0]) fail(409, 'Only assigned contributors can receive verified points.');
        const existing = await client.query(
            `
            SELECT 1 FROM ticket_work_verifications
            WHERE tenant_id = $1 AND ticket_id = $2 AND contributor_user_id = $3
              AND verification_status = 'verified' LIMIT 1
        `,
            [access.tenantId, ticket.id, contributorUserId],
        );
        if (existing.rows[0]) fail(409, 'This contribution is already verified.');
        const estimate = await client.query(
            `
            SELECT estimated_points FROM ticket_story_points
            WHERE tenant_id = $1 AND ticket_id = $2
        `,
            [access.tenantId, ticket.id],
        );
        if (!estimate.rows[0] || Number(estimate.rows[0].estimated_points) <= 0) {
            fail(409, 'A positive estimate is required before verification.');
        }
        const total = await client.query(
            `
            SELECT COALESCE(SUM(verified_points),0) AS used
            FROM ticket_work_verifications
            WHERE tenant_id = $1 AND ticket_id = $2 AND verification_status = 'verified'
        `,
            [access.tenantId, ticket.id],
        );
        const fits = await client.query('SELECT $1::numeric + $2::numeric <= $3::numeric AS fits', [
            points,
            total.rows[0].used,
            estimate.rows[0].estimated_points,
        ]);
        if (!fits.rows[0].fits) fail(409, 'Verified points exceed the ticket estimate.');
        const result = await client.query(
            `
            INSERT INTO ticket_work_verifications
                (tenant_id, ticket_id, contributor_user_id, verified_points,
                 verified_by_user_id, verification_notes)
            VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING id, ticket_id, contributor_user_id, verified_points, verified_by_user_id,
                verification_status, verification_notes, verified_at, revoked_at, revoked_by_user_id
        `,
            [access.tenantId, ticket.id, contributorUserId, points, access.userId, notes],
        );
        await recordActivity(client, access, ticket.id, 'work_verified', 'verifiedPoints', null, { contributorUserId, points });
        await recordAudit(client, access, ticket.id, 'TICKET_VERIFY', {
            verificationId: result.rows[0].id,
            contributorUserId,
            points,
        });
        return presentVerification(result.rows[0]);
    });
}

export async function revokeVerification(access, ticketId, verificationId) {
    requireManager(access);
    return withTransaction(async (client) => {
        const ticket = await ticketRow(client, access, idValue(ticketId, 'ticket ID'), true);
        const id = idValue(verificationId, 'verification ID');
        const current = await client.query(
            `
            SELECT * FROM ticket_work_verifications
            WHERE tenant_id = $1 AND ticket_id = $2 AND id = $3 FOR UPDATE
        `,
            [access.tenantId, ticket.id, id],
        );
        if (!current.rows[0]) fail(404, 'Verification not found.');
        if (current.rows[0].verification_status !== 'verified') fail(409, 'Verification is already revoked.');
        const result = await client.query(
            `
            UPDATE ticket_work_verifications
            SET verification_status = 'revoked', revoked_at = now(), revoked_by_user_id = $4
            WHERE tenant_id = $1 AND ticket_id = $2 AND id = $3
            RETURNING id, ticket_id, contributor_user_id, verified_points, verified_by_user_id,
                verification_status, verification_notes, verified_at, revoked_at, revoked_by_user_id
        `,
            [access.tenantId, ticket.id, id, access.userId],
        );
        await recordActivity(client, access, ticket.id, 'verification_revoked', 'verificationStatus', 'verified', 'revoked', {
            verificationId: id,
        });
        await recordAudit(client, access, ticket.id, 'TICKET_VERIFY_REVOKE', {
            verificationId: id,
        });
        return presentVerification(result.rows[0]);
    });
}
