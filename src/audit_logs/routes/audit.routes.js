import express from 'express';

const router = express.Router();

import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { requirePermission } from '../../middleware/auth/permissionMiddleware.js';
import { paginationMiddleware } from '../../middleware/fetch/paginationMiddleware.js';
import { requireTenantMember } from '../../tenants/middleware/tenantAccessMiddleware.js';
import { getAuditLogs, getTenantAuditLogs } from '../auditLogService.js';
import { log } from '../../util/breadcrumb.js';

// Global, cross-tenant history: platform operators only.
router.get('/all',
    log('AUDIT LOGS', 'GET ALL AUDIT LOGS ROUTE START'),
    sessionAuthMiddleware,
    log('AUDIT LOGS', 'SESSION MIDDLEWARE PASSED - USER AUTHENTICATED'),
    requirePermission('PLATFORM_AUDIT_READ'),
    log('AUDIT LOGS', 'PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION'),
    paginationMiddleware,
    getAuditLogs,
    log('AUDIT LOGS', 'AUDIT SERVICE PASSED - OPERATION SUCCESSFUL')
);

// One tenant's history: AUDIT_READ plus owner/admin membership in that tenant.
router.get('/tenants/:tenant_id',
    sessionAuthMiddleware,
    requirePermission('AUDIT_READ'),
    requireTenantMember({ roles: ['owner', 'admin'] }),
    paginationMiddleware,
    getTenantAuditLogs,
);

export default router;
