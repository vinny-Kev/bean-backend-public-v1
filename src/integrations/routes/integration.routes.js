import express from 'express';

const router = express.Router();

import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { requirePermission } from '../../middleware/auth/permissionMiddleware.js';
import { paginationMiddleware } from '../../middleware/fetch/paginationMiddleware.js';
import { log } from '../../util/breadcrumb.js';
import { getTenantIntegrations } from '../services/integrationService.js';

router.get('/all/:tenant_id',
    log('INTEGRATIONS', 'GET ALL INTEGRATIONS ROUTE START'),
    sessionAuthMiddleware,
    log('AUDIT LOGS', 'SESSION MIDDLEWARE PASSED - USER AUTHENTICATED'),
    requirePermission('INTEGRATIONS_READ'),
    log('AUDIT LOGS', 'PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION'),
    paginationMiddleware,
    getTenantIntegrations,
    log('INTEGRATIONS', 'INTEGRATION SERVICE PASSED - OPERATION SUCCESSFUL')
);

export default router;
