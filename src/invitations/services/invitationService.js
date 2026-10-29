import { pool } from '../../db/pool.js';
import { hashToken, newToken } from '../../identity/challengeService.js';
import { audit, isValidEmail, maskEmail, normalizeEmail, sendError } from '../../identity/identityHelpers.js';
import { sendMail } from '../../mail/mailer.js';
import { appLink, templates } from '../../mail/templates.js';
import { TENANT_ROLES } from '../../tenants/middleware/tenantAccessMiddleware.js';
import { isPlainObject, parsePositiveId } from '../../util/validations.js';

// Invitations: an owner/admin invites an email address; only a verified account with that exact
// address, presenting the emailed token (or accepting from its own pending list), can join. See
// db/migrations/015_tenant_invitations.sql. Lock order is always tenant row, then invitation row.

export const invitationDays = 7;
const resendCooldownSeconds = 60;
const maxPendingPerTenant = 100;
const effectiveStatus = `CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END`;

const view = (row) => ({
    id: String(row.id),
    email: row.email_normalized,
    role: row.membership_role,
    status: row.effective_status ?? row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    invitedByUserId: row.invited_by_user_id === null ? null : String(row.invited_by_user_id),
});
const displayName = (row) => row.full_name || row.username;

const outcome = (status, code, message) => ({ status, body: { error: { code, message } } });

// Runs `work` in a transaction with the tenant row locked and the actor's role re-read under the lock.
const withLockedTenant = async (req, res, next, work) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const locked = (await client.query(
            `SELECT t.name, t.status, tm.membership_role FROM tenants t
             LEFT JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.user_id = $2
             WHERE t.id = $1 FOR UPDATE OF t`,
            [req.tenant.id, req.user.id],
        )).rows[0];
        const actorRole = locked?.membership_role;
        const result = !actorRole ? outcome(404, 'TENANT_NOT_FOUND', 'Tenant not found.')
            : !['owner', 'admin'].includes(actorRole) ? outcome(403, 'TENANT_ROLE_REQUIRED', 'Only tenant owners and admins can manage invitations.')
                : locked.status !== 'active' ? outcome(409, 'TENANT_INACTIVE', 'Invitations cannot change while the tenant is not active.')
                    : await work(client, { actorRole, tenantName: locked.name });
        await client.query(result.status < 300 ? 'COMMIT' : 'ROLLBACK');
        if (result.afterCommit) await result.afterCommit();
        return res.status(result.status).json(result.body);
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};

const sendInvitation = (req, { email, role, token, tenantName, inviter }) => sendMail({
    to: email,
    template: 'invitation',
    ...templates.invitation({ organization: tenantName, inviter, role, days: invitationDays, url: appLink('/accept-invitation', `token=${token}`) }),
}, { requestId: req.requestId });

// POST /tenants/:tenant_id/invitations { email, role? }
export const createInvitation = (req, res, next) => {
    const body = req.body;
    const email = normalizeEmail(body?.email);
    const role = body?.role ?? 'member';
    if (!isPlainObject(body) || Object.keys(body).some((key) => !['email', 'role'].includes(key)) || !isValidEmail(email) || !TENANT_ROLES.includes(role)) {
        return sendError(res, 400, 'INVALID_INVITATION', 'Provide a valid email address and an optional role (owner, admin, member).');
    }
    if (email === req.user.email.toLowerCase()) return sendError(res, 400, 'INVALID_INVITATION', 'You can’t invite yourself.');
    return withLockedTenant(req, res, next, async (client, { actorRole, tenantName }) => {
        if (actorRole !== 'owner' && role !== 'member') return outcome(403, 'OWNER_REQUIRED', 'Only tenant owners can invite someone as an owner or administrator.');
        const member = await client.query(
            `SELECT 1 FROM tenant_members tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = $1 AND lower(u.email) = $2`,
            [req.tenant.id, email],
        );
        if (member.rowCount) return outcome(409, 'ALREADY_MEMBER', 'That person is already a member of this organization.');
        const pending = await client.query(
            `SELECT COUNT(*)::int AS n FROM tenant_invitations WHERE tenant_id = $1 AND status = 'pending' AND expires_at > now()`, [req.tenant.id],
        );
        if (pending.rows[0].n >= maxPendingPerTenant) return outcome(409, 'INVITATION_LIMIT', 'This organization has too many pending invitations. Revoke some first.');
        await client.query(
            `UPDATE tenant_invitations SET status = 'revoked', updated_at = now() WHERE tenant_id = $1 AND email_normalized = $2 AND status = 'pending'`,
            [req.tenant.id, email],
        );
        const token = newToken();
        const created = (await client.query(
            `INSERT INTO tenant_invitations (tenant_id, email_normalized, membership_role, token_hash, invited_by_user_id, expires_at)
             VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval) RETURNING *`,
            [req.tenant.id, email, role, hashToken('invitation', token), req.user.id, String(invitationDays)],
        )).rows[0];
        await audit(client, {
            userId: req.user.id, tenantId: req.tenant.id, action: 'CREATE INVITATION', tableName: 'tenant_invitations', recordId: created.id,
            newData: { tenantId: req.tenant.id, invitationId: created.id, email: maskEmail(email), role },
        });
        return {
            status: 201,
            body: { message: 'Invitation sent.', data: view(created) },
            afterCommit: () => sendInvitation(req, { email, role, token, tenantName, inviter: displayName(req.user) }),
        };
    });
};

// GET /tenants/:tenant_id/invitations?status=pending|expired|accepted|revoked|all (paginated)
export const listInvitations = async (req, res, next) => {
    const status = req.query.status ?? 'pending';
    if (!['pending', 'expired', 'accepted', 'revoked', 'all'].includes(status)) return sendError(res, 400, 'INVALID_FILTER', 'Unknown status filter.');
    try {
        const pagination = req.pagination ?? { limit: 20, offset: 0 };
        const where = `i.tenant_id = $1 AND ($2 = 'all' OR ${effectiveStatus} = $2)`;
        const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM tenant_invitations i WHERE ${where}`, [req.tenant.id, status])).rows[0].n;
        const rows = await pool.query(
            `SELECT i.*, ${effectiveStatus} AS effective_status FROM tenant_invitations i
             WHERE ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT $3 OFFSET $4`,
            [req.tenant.id, status, pagination.limit, pagination.offset],
        );
        return res.status(200).json({
            message: 'Invitations retrieved successfully.',
            data: rows.rows.map(view),
            pagination: {
                ...(pagination.page !== undefined && { page: pagination.page }), limit: pagination.limit, offset: pagination.offset, total,
                totalPages: Math.ceil(total / pagination.limit), hasMore: pagination.offset + rows.rowCount < total,
            },
        });
    } catch (error) {
        return next(error);
    }
};

const findInTenant = async (client, tenantId, rawId) => {
    const id = parsePositiveId(rawId);
    if (!id) return null;
    return (await client.query('SELECT * FROM tenant_invitations WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenantId])).rows[0] ?? null;
};

// POST /tenants/:tenant_id/invitations/:invitation_id/resend: new token and expiry, old link stops working.
export const resendInvitation = (req, res, next) => withLockedTenant(req, res, next, async (client, { actorRole, tenantName }) => {
    const invitation = await findInTenant(client, req.tenant.id, req.params.invitation_id);
    if (!invitation) return outcome(404, 'INVITATION_NOT_FOUND', 'Invitation not found.');
    if (invitation.status !== 'pending') return outcome(409, 'INVITATION_NOT_PENDING', 'Only pending invitations can be resent.');
    if (actorRole !== 'owner' && invitation.membership_role !== 'member') return outcome(403, 'OWNER_REQUIRED', 'Only tenant owners can manage this invitation.');
    const age = (await client.query('SELECT EXTRACT(EPOCH FROM (now() - updated_at))::int AS seconds FROM tenant_invitations WHERE id = $1', [invitation.id])).rows[0].seconds;
    if (age < resendCooldownSeconds) return outcome(429, 'RESEND_COOLDOWN', 'This invitation was just sent. Wait a moment before resending.');
    const token = newToken();
    const updated = (await client.query(
        `UPDATE tenant_invitations SET token_hash = $2, expires_at = now() + ($3 || ' days')::interval, updated_at = now(), invited_by_user_id = $4
         WHERE id = $1 RETURNING *`,
        [invitation.id, hashToken('invitation', token), String(invitationDays), req.user.id],
    )).rows[0];
    await audit(client, {
        userId: req.user.id, tenantId: req.tenant.id, action: 'RESEND INVITATION', tableName: 'tenant_invitations', recordId: invitation.id,
        newData: { tenantId: req.tenant.id, invitationId: invitation.id, email: maskEmail(invitation.email_normalized) },
    });
    return {
        status: 200,
        body: { message: 'Invitation resent.', data: view(updated) },
        afterCommit: () => sendInvitation(req, { email: invitation.email_normalized, role: invitation.membership_role, token, tenantName, inviter: displayName(req.user) }),
    };
});

// DELETE /tenants/:tenant_id/invitations/:invitation_id
export const revokeInvitation = (req, res, next) => withLockedTenant(req, res, next, async (client, { actorRole }) => {
    const invitation = await findInTenant(client, req.tenant.id, req.params.invitation_id);
    if (!invitation) return outcome(404, 'INVITATION_NOT_FOUND', 'Invitation not found.');
    if (invitation.status !== 'pending') return outcome(409, 'INVITATION_NOT_PENDING', 'Only pending invitations can be revoked.');
    if (actorRole !== 'owner' && invitation.membership_role !== 'member') return outcome(403, 'OWNER_REQUIRED', 'Only tenant owners can manage this invitation.');
    await client.query(`UPDATE tenant_invitations SET status = 'revoked', updated_at = now() WHERE id = $1`, [invitation.id]);
    await audit(client, {
        userId: req.user.id, tenantId: req.tenant.id, action: 'REVOKE INVITATION', tableName: 'tenant_invitations', recordId: invitation.id,
        newData: { tenantId: req.tenant.id, invitationId: invitation.id, email: maskEmail(invitation.email_normalized) },
    });
    return { status: 200, body: { message: 'Invitation revoked.', data: { id: String(invitation.id), status: 'revoked' } } };
});

// ---- Accepting ---------------------------------------------------------------------------------

const gone = 'This invitation is invalid, expired, or was already used.';

// `lookup` returns the unlocked invitation row (to learn the tenant); the transaction then locks the
// tenant, re-reads the invitation FOR UPDATE, and applies every rule against current state.
const acceptWith = async (req, res, next, lookup) => {
    const user = req.user;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const peek = await lookup(client);
        if (!peek) {
            await client.query('ROLLBACK');
            return sendError(res, 400, 'INVALID_INVITATION', gone);
        }
        const tenant = (await client.query('SELECT id, name, status FROM tenants WHERE id = $1 FOR UPDATE', [peek.tenant_id])).rows[0];
        const invitation = (await client.query('SELECT * FROM tenant_invitations WHERE id = $1 FOR UPDATE', [peek.id])).rows[0];
        const fail = async (status, code, message, { commit = false } = {}) => {
            await client.query(commit ? 'COMMIT' : 'ROLLBACK');
            return sendError(res, status, code, message);
        };
        if (!tenant || tenant.status === 'deleted' || invitation.status !== 'pending') return await fail(400, 'INVALID_INVITATION', gone);
        if (new Date(invitation.expires_at) <= new Date()) {
            await client.query(`UPDATE tenant_invitations SET status = 'expired', updated_at = now() WHERE id = $1`, [invitation.id]);
            return await fail(410, 'INVITATION_EXPIRED', 'This invitation has expired. Ask for a new one.', { commit: true });
        }
        if (invitation.email_normalized !== user.email.toLowerCase()) {
            return await fail(403, 'INVITATION_EMAIL_MISMATCH', 'This invitation was sent to a different email address. Sign in with that address to accept it.');
        }
        if (tenant.status !== 'active') return await fail(409, 'TENANT_INACTIVE', 'This organization is not active.');
        const inviter = invitation.invited_by_user_id === null ? null : (await client.query(
            'SELECT membership_role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2', [tenant.id, invitation.invited_by_user_id],
        )).rows[0]?.membership_role;
        const authorised = inviter === 'owner' || (inviter === 'admin' && invitation.membership_role === 'member');
        if (!authorised) {
            await client.query(`UPDATE tenant_invitations SET status = 'revoked', updated_at = now() WHERE id = $1`, [invitation.id]);
            return await fail(409, 'INVITATION_NO_LONGER_VALID', 'The person who invited you can no longer add members. Ask for a new invitation.', { commit: true });
        }
        const inserted = await client.query(
            `INSERT INTO tenant_members (tenant_id, user_id, membership_role) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, user_id) DO NOTHING`,
            [tenant.id, user.id, invitation.membership_role],
        );
        await client.query(
            `UPDATE tenant_invitations SET status = 'accepted', accepted_by_user_id = $2, accepted_at = now(), updated_at = now() WHERE id = $1`,
            [invitation.id, user.id],
        );
        if (inserted.rowCount) {
            await audit(client, {
                userId: user.id, tenantId: tenant.id, action: 'ADD TENANT MEMBER', tableName: 'tenant_members', recordId: user.id,
                newData: { tenantId: tenant.id, userId: user.id, membershipRole: invitation.membership_role, via: 'invitation' },
            });
        }
        await audit(client, {
            userId: user.id, tenantId: tenant.id, action: 'ACCEPT INVITATION', tableName: 'tenant_invitations', recordId: invitation.id,
            newData: { tenantId: tenant.id, invitationId: invitation.id, alreadyMember: inserted.rowCount === 0 },
        });
        await client.query('COMMIT');
        return res.status(200).json({
            message: inserted.rowCount ? 'Invitation accepted.' : 'You were already a member; the invitation is now closed.',
            data: { tenantId: String(tenant.id), name: tenant.name, membershipRole: inserted.rowCount ? invitation.membership_role : null, alreadyMember: inserted.rowCount === 0 },
        });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};

// POST /invitations/accept { token }
export const acceptByToken = (req, res, next) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return sendError(res, 400, 'INVALID_INVITATION', gone);
    return acceptWith(req, res, next, async (client) => (await client.query(
        'SELECT id, tenant_id FROM tenant_invitations WHERE token_hash = $1', [hashToken('invitation', token)],
    )).rows[0]);
};

// POST /invitations/:invitation_id/accept: from the signed-in user's own pending list (no token).
export const acceptById = (req, res, next) => {
    const id = parsePositiveId(req.params.invitation_id);
    if (!id) return sendError(res, 400, 'INVALID_INVITATION', gone);
    return acceptWith(req, res, next, async (client) => (await client.query(
        'SELECT id, tenant_id FROM tenant_invitations WHERE id = $1 AND email_normalized = $2', [id, req.user.email.toLowerCase()],
    )).rows[0]);
};

// POST /invitations/preview { token }: what a token holder is being invited to, before signing in. Public: the
// 256-bit token is the credential. Reveals the organization, role, inviter name and a masked address only.
export const previewInvitation = async (req, res, next) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return sendError(res, 400, 'INVALID_INVITATION', gone);
    try {
        const row = (await pool.query(
            `SELECT i.email_normalized, i.membership_role, i.expires_at, t.name AS organization, u.full_name, u.username
             FROM tenant_invitations i JOIN tenants t ON t.id = i.tenant_id AND t.status = 'active'
             LEFT JOIN users u ON u.id = i.invited_by_user_id
             WHERE i.token_hash = $1 AND i.status = 'pending' AND i.expires_at > now()`,
            [hashToken('invitation', token)],
        )).rows[0];
        if (!row) return sendError(res, 400, 'INVALID_INVITATION', gone);
        res.set('Cache-Control', 'no-store');
        return res.status(200).json({ data: {
            organization: row.organization, role: row.membership_role, invitedBy: row.full_name || row.username || null,
            emailHint: maskEmail(row.email_normalized), expiresAt: row.expires_at,
        } });
    } catch (error) {
        return next(error);
    }
};

// GET /invitations/mine: pending, unexpired invitations addressed to the signed-in user's verified email.
export const listMyInvitations = async (req, res, next) => {
    try {
        const rows = await pool.query(
            `SELECT i.id, i.membership_role, i.expires_at, t.name AS organization, u.full_name, u.username
             FROM tenant_invitations i JOIN tenants t ON t.id = i.tenant_id AND t.status = 'active'
             LEFT JOIN users u ON u.id = i.invited_by_user_id
             WHERE i.email_normalized = $1 AND i.status = 'pending' AND i.expires_at > now()
             ORDER BY i.created_at DESC, i.id DESC LIMIT 50`,
            [req.user.email.toLowerCase()],
        );
        return res.status(200).json({
            message: 'Invitations retrieved successfully.',
            data: rows.rows.map((row) => ({
                id: String(row.id), organization: row.organization, role: row.membership_role,
                invitedBy: row.full_name || row.username || null, expiresAt: row.expires_at,
            })),
        });
    } catch (error) {
        return next(error);
    }
};
