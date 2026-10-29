import express from 'express';

const router = express.Router();

import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { requireAccess, requirePermission, tenantFromBody, tenantFromIntegration, tenantFromParam, tenantFromQuery } from '../../middleware/auth/permissionMiddleware.js';
import { paginationMiddleware } from '../../middleware/fetch/paginationMiddleware.js';
import { log } from '../../util/breadcrumb.js';
import { getTenantIntegrations } from '../services/integrationService.js';
import { receiveIntegrationEvent } from '../services/integrationService.js';
import { authenticateIntegration } from '../middleware/integrationAuthMiddleware.js';
import { validateAndAuthorizeIntegrationEvent } from '../middleware/integrationOriginMiddleware.js';
import rateLimit from 'express-rate-limit';
import { searchIntegrationEvents, getIntegrationEventDetail, retryIntegrationEvent,
    searchIntegrationDiagnostics, searchUnauthorizedIntegrationAttempts } from '../services/integrationInvestigationService.js';
import { getIntegrationActivity } from '../services/integrationActivityService.js';
import { getIntegrationAuditHistory } from '../services/integrationAuditHistoryService.js';
import { getIntegrationAnalytics } from '../services/integrationAnalyticsService.js';
import { rotateIntegrationCredential } from '../services/integrationCredentialService.js';
import { getIntegrationSettings, updateInventoryShortagePolicy } from '../services/integrationSettingsService.js';
import { createIntegration, getIntegration, updateSubscriptions, upsertUserMapping,
    activateIntegration, suspendIntegration, disconnectIntegration } from '../services/integrationLifecycleService.js';

const integrationEventLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many integration events. Try again shortly.' } },
});
const credentialRotationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many credential rotation requests.' } },
});
const integrationRegistrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Runs after authentication, so the budget is per user rather than per shared IP.
    keyGenerator: (req) => `user:${req.user.id}`,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many integration registration requests.' } },
});

router.get('/all/:tenant_id',
    log('INTEGRATIONS', 'GET ALL INTEGRATIONS ROUTE START'),
    sessionAuthMiddleware,
    log('AUDIT LOGS', 'SESSION MIDDLEWARE PASSED - USER AUTHENTICATED'),
    requireAccess('INTEGRATIONS_READ', tenantFromParam('tenant_id')),
    log('AUDIT LOGS', 'PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION'),
    paginationMiddleware,
    getTenantIntegrations,
    log('INTEGRATIONS', 'INTEGRATION SERVICE PASSED - OPERATION SUCCESSFUL')
);

router.get('/:integration_id/activity', sessionAuthMiddleware, requireAccess('INTEGRATIONS_READ', tenantFromIntegration()), paginationMiddleware, getIntegrationActivity);
router.get('/:integration_id/audit', sessionAuthMiddleware, requireAccess('INTEGRATIONS_READ', tenantFromIntegration()), paginationMiddleware, getIntegrationAuditHistory);
router.get('/:integration_id/analytics', sessionAuthMiddleware, requireAccess('INTEGRATIONS_READ', tenantFromIntegration()), getIntegrationAnalytics);
router.post('/:integration_id/credentials/rotate', credentialRotationLimiter, sessionAuthMiddleware, requireAccess('INTEGRATIONS_MANAGE', tenantFromBody('tenantId')), rotateIntegrationCredential);
router.get('/tenants/:tenant_id/settings', sessionAuthMiddleware, requireAccess('INTEGRATIONS_READ', tenantFromParam('tenant_id')), getIntegrationSettings);
router.put('/tenants/:tenant_id/settings/inventory-policy', sessionAuthMiddleware, requireAccess('INTEGRATIONS_MANAGE', tenantFromParam('tenant_id')), updateInventoryShortagePolicy);

router.post('/:integration_id/events',
    integrationEventLimiter,
    authenticateIntegration,
    express.json({ limit: '100kb', strict: true }),
    validateAndAuthorizeIntegrationEvent,
    receiveIntegrationEvent,
);

router.get('/events', sessionAuthMiddleware, requireAccess('INTEGRATIONS_READ', tenantFromQuery('tenantId')), paginationMiddleware, searchIntegrationEvents);
router.get('/events/:event_id', sessionAuthMiddleware, requireAccess('INTEGRATIONS_READ', tenantFromQuery('tenantId')), getIntegrationEventDetail);
router.post('/events/:event_id/retry', sessionAuthMiddleware, requireAccess('INTEGRATIONS_MANAGE', tenantFromBody('tenantId')), retryIntegrationEvent);
router.get('/diagnostics', sessionAuthMiddleware, requireAccess('INTEGRATIONS_READ', tenantFromQuery('tenantId')), paginationMiddleware, searchIntegrationDiagnostics);
router.get('/diagnostics/unauthorized', sessionAuthMiddleware, requirePermission('PLATFORM_AUDIT_READ'), paginationMiddleware, searchUnauthorizedIntegrationAttempts);

// Integration onboarding and lifecycle. Every change needs the account-level INTEGRATIONS_MANAGE
// permission (reading needs INTEGRATIONS_READ); tenant authority comes from tenant_members (owner/admin).
router.post('/tenants/:tenant_id/apps', sessionAuthMiddleware, integrationRegistrationLimiter, requireAccess('INTEGRATIONS_MANAGE', tenantFromParam('tenant_id')), createIntegration);
router.put('/:integration_id/subscriptions', sessionAuthMiddleware, requireAccess('INTEGRATIONS_MANAGE', tenantFromIntegration()), updateSubscriptions);
router.put('/:integration_id/user-mappings', sessionAuthMiddleware, requireAccess('INTEGRATIONS_MANAGE', tenantFromIntegration()), upsertUserMapping);
router.post('/:integration_id/activate', sessionAuthMiddleware, requireAccess('INTEGRATIONS_MANAGE', tenantFromIntegration()), activateIntegration);
router.post('/:integration_id/suspend', sessionAuthMiddleware, requireAccess('INTEGRATIONS_MANAGE', tenantFromIntegration()), suspendIntegration);
router.post('/:integration_id/disconnect', sessionAuthMiddleware, requireAccess('INTEGRATIONS_MANAGE', tenantFromIntegration()), disconnectIntegration);
// Keep last so it cannot shadow /events or /diagnostics.
router.get('/:integration_id', sessionAuthMiddleware, requireAccess('INTEGRATIONS_READ', tenantFromIntegration()), getIntegration);

export default router;
