import express from 'express';

const router = express.Router();

import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { requirePermission } from '../../middleware/auth/permissionMiddleware.js';
import { paginationMiddleware } from '../../middleware/fetch/paginationMiddleware.js';
import { getAuditLogs } from '../auditLogService.js';
import { log } from '../../util/breadcrumb.js';

router.get('/all',
    log('AUDIT LOGS', 'GET ALL AUDIT LOGS ROUTE START'),
    sessionAuthMiddleware,
    log('AUDIT LOGS', 'SESSION MIDDLEWARE PASSED - USER AUTHENTICATED'),
    requirePermission('AUDIT_READ'),
    log('AUDIT LOGS', 'PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION'),
    paginationMiddleware,
    getAuditLogs,
    log('AUDIT LOGS', 'AUDIT SERVICE PASSED - OPERATION SUCCESSFUL')
);

export default router;
