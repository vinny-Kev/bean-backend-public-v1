import { pool } from '../../db/pool.js';
import { checkIssueAllowed, hashIp, issueChallenge, policy, verifyOtp } from '../../identity/challengeService.js';
import { audit, clientIp, codeLength, resendSeconds, sendCooldown, sendError, sendOtpError } from '../../identity/identityHelpers.js';
import { sendMail } from '../../mail/mailer.js';
import { templates } from '../../mail/templates.js';
import { isPlainObject, parsePositiveId } from '../../util/validations.js';

// Ownership transfer is a two-step, email-confirmed action (step-up):
//   1. request: the current owner names the new owner; a one-time code is emailed to the owner.
//   2. confirm: with the code, one transaction promotes the new owner and demotes the caller to admin.
// The tenant row is locked and the caller's role re-read, so concurrent role changes cannot interleave.

const action = 'transfer_ownership';

export const requestOwnershipTransfer = async (req, res, next) => {
    const targetUserId = parsePositiveId(String(req.body?.newOwnerUserId ?? ''));
    if (!isPlainObject(req.body) || Object.keys(req.body).some((key) => key !== 'newOwnerUserId') || !targetUserId) {
        return sendError(res, 400, 'INVALID_TRANSFER', 'Provide the user ID of an existing member as newOwnerUserId.');
    }
    if (targetUserId === Number(req.user.id)) return sendError(res, 400, 'INVALID_TRANSFER', 'You already own this organization.');
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const tenant = (await client.query(
            `SELECT t.status, t.name, tm.membership_role FROM tenants t
             LEFT JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.user_id = $2 WHERE t.id = $1 FOR UPDATE OF t`,
            [req.tenant.id, req.user.id],
        )).rows[0];
        if (tenant?.membership_role !== 'owner') {
            await client.query('ROLLBACK');
            return sendError(res, 403, 'OWNER_REQUIRED', 'Only tenant owners can transfer ownership.');
        }
        if (tenant.status !== 'active') {
            await client.query('ROLLBACK');
            return sendError(res, 409, 'TENANT_INACTIVE', 'Ownership cannot change while the tenant is not active.');
        }
        const target = (await client.query(
            `SELECT 1 FROM tenant_members tm JOIN users u ON u.id = tm.user_id
             WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND u.is_disabled = false AND u.deleted_at IS NULL`,
            [req.tenant.id, targetUserId],
        )).rows[0];
        if (!target) {
            await client.query('ROLLBACK');
            return sendError(res, 404, 'MEMBER_NOT_FOUND', 'The new owner must be an active member of this organization.');
        }
        const allowed = await checkIssueAllowed(client, req.user.id, 'sensitive_action');
        if (!allowed.allowed) {
            await client.query('ROLLBACK');
            return sendCooldown(res, allowed.retryAfterSeconds);
        }
        const challenge = await issueChallenge(client, {
            userId: req.user.id, purpose: 'sensitive_action', email: req.user.email.toLowerCase(),
            context: { action, tenantId: req.tenant.id, targetUserId }, ipHash: hashIp(clientIp(req)),
        });
        await audit(client, {
            userId: req.user.id, tenantId: req.tenant.id, action: 'OWNERSHIP_TRANSFER_REQUESTED', tableName: 'tenants', recordId: req.tenant.id,
            newData: { tenantId: req.tenant.id, targetUserId },
        });
        await client.query('COMMIT');
        await sendMail({
            to: req.user.email,
            template: 'sensitiveActionCode',
            ...templates.sensitiveActionCode({ code: challenge.secret, minutes: policy.otpMinutes, action: `transfer ownership of ${tenant.name}` }),
        }, { requestId: req.requestId });
        return res.status(202).json({ status: 'code_sent', codeLength, retryAfterSeconds: resendSeconds, message: 'We emailed you a confirmation code. Enter it to complete the transfer.' });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};

export const confirmOwnershipTransfer = async (req, res, next) => {
    const code = req.body?.code;
    if (!isPlainObject(req.body) || typeof code !== 'string') return sendOtpError(res, 'INVALID');
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const tenant = (await client.query(
            `SELECT t.status, tm.membership_role FROM tenants t
             LEFT JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.user_id = $2 WHERE t.id = $1 FOR UPDATE OF t`,
            [req.tenant.id, req.user.id],
        )).rows[0];
        if (tenant?.membership_role !== 'owner') {
            await client.query('ROLLBACK');
            return sendError(res, 403, 'OWNER_REQUIRED', 'Only tenant owners can transfer ownership.');
        }
        if (tenant.status !== 'active') {
            await client.query('ROLLBACK');
            return sendError(res, 409, 'TENANT_INACTIVE', 'Ownership cannot change while the tenant is not active.');
        }
        const result = await verifyOtp(client, { userId: req.user.id, purpose: 'sensitive_action', code });
        const context = result.ok ? result.challenge.context : null;
        if (result.ok && (context.action !== action || Number(context.tenantId) !== Number(req.tenant.id))) {
            await client.query('ROLLBACK'); // a code issued for a different action or tenant is not valid here (and is not consumed)
            return sendOtpError(res, 'INVALID');
        }
        if (!result.ok) {
            await client.query('COMMIT'); // keeps the failed-attempt count
            return sendOtpError(res, result.reason);
        }
        const target = (await client.query(
            `SELECT tm.membership_role FROM tenant_members tm JOIN users u ON u.id = tm.user_id
             WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND u.is_disabled = false AND u.deleted_at IS NULL FOR UPDATE OF tm`,
            [req.tenant.id, context.targetUserId],
        )).rows[0];
        if (!target) {
            await client.query('ROLLBACK');
            return sendError(res, 409, 'MEMBER_NOT_FOUND', 'The new owner is no longer an active member of this organization.');
        }
        await client.query(`UPDATE tenant_members SET membership_role = 'owner' WHERE tenant_id = $1 AND user_id = $2`, [req.tenant.id, context.targetUserId]);
        await client.query(`UPDATE tenant_members SET membership_role = 'admin' WHERE tenant_id = $1 AND user_id = $2`, [req.tenant.id, req.user.id]);
        await audit(client, {
            userId: req.user.id, tenantId: req.tenant.id, action: 'OWNERSHIP_TRANSFERRED', tableName: 'tenants', recordId: req.tenant.id,
            oldData: { ownerUserId: req.user.id, newOwnerPreviousRole: target.membership_role },
            newData: { tenantId: req.tenant.id, ownerUserId: context.targetUserId, previousOwnerNowRole: 'admin' },
        });
        await client.query('COMMIT');
        return res.status(200).json({
            message: 'Ownership transferred. You are now an administrator of this organization.',
            data: { tenantId: String(req.tenant.id), newOwnerUserId: String(context.targetUserId), yourRole: 'admin' },
        });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        client?.release();
    }
};
