import express from 'express';
import rateLimit from 'express-rate-limit';
import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { requirePermission } from '../../middleware/auth/permissionMiddleware.js';
import { paginationMiddleware } from '../../middleware/fetch/paginationMiddleware.js';
import { requireTenantMember } from '../middleware/tenantAccessMiddleware.js';
import { createTenant, listMyTenants } from '../services/tenantService.js';
import { addTenantMember, getTenant, getTenantMember, listTenantMembers, removeTenantMember,
    updateTenantMemberRole } from '../services/tenantMemberService.js';

const router = express.Router();

const tenantCreationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Runs after authentication, so the budget is per user rather than per shared IP.
    keyGenerator: (req) => `user:${req.user.id}`,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many tenant creation requests.' } },
});

router.get('/', sessionAuthMiddleware, listMyTenants);
// Creating a tenant is an account-level permission; tenant roles never grant it.
router.post('/', sessionAuthMiddleware, requirePermission('TENANTS_CREATE'), tenantCreationLimiter, createTenant);

// Tenant-scoped routes: authority comes from the caller's tenant_members role.
router.get('/:tenant_id', sessionAuthMiddleware, requireTenantMember(), getTenant);
router.get('/:tenant_id/members', sessionAuthMiddleware, requireTenantMember(), paginationMiddleware, listTenantMembers);
router.get('/:tenant_id/members/:user_id', sessionAuthMiddleware, requireTenantMember(), getTenantMember);
router.post('/:tenant_id/members', sessionAuthMiddleware, requireTenantMember(), addTenantMember);
router.patch('/:tenant_id/members/:user_id', sessionAuthMiddleware, requireTenantMember(), updateTenantMemberRole);
router.delete('/:tenant_id/members/:user_id', sessionAuthMiddleware, requireTenantMember(), removeTenantMember);

export default router;
