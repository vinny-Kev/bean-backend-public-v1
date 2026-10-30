import { pool } from '../../db/pool.js';
import { findAccountPermissions } from './currentUserService.js';

// GET /onboarding: where the signed-in user is in the guided flow. Nothing is stored for this:
// the state is derived from real records (memberships, invitations), so it can never drift, can be
// resumed from any device, and cannot create duplicate tenants or memberships.
//
//   step "organization": no membership yet -> create an organization or accept an invitation
//   step "done":         belongs to at least one organization -> enter the workspace
// (Inviting teammates is offered right after creating an organization and is always optional.)
export const getOnboarding = async (req, res, next) => {
    try {
        const [memberships, invitations, permissions] = await Promise.all([
            pool.query(
                `SELECT COUNT(*)::int AS n FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id WHERE tm.user_id = $1 AND t.status <> 'deleted'`,
                [req.user.id],
            ),
            pool.query(
                `SELECT COUNT(*)::int AS n FROM tenant_invitations i JOIN tenants t ON t.id = i.tenant_id AND t.status = 'active'
                 WHERE i.email_normalized = $1 AND i.status = 'pending' AND i.expires_at > now()`,
                [req.user.email.toLowerCase()],
            ),
            findAccountPermissions(req.user.id),
        ]);
        const organizations = memberships.rows[0].n;
        res.set('Cache-Control', 'no-store');
        return res.status(200).json({
            data: {
                step: organizations > 0 ? 'done' : 'organization',
                organizations,
                pendingInvitations: invitations.rows[0].n,
                canCreateOrganization: permissions.includes('TENANTS_CREATE'),
            },
        });
    } catch (error) {
        return next(error);
    }
};
