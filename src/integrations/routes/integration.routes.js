import express from 'express';

const router = express.Router();

import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { requirePermission } from '../../middleware/auth/permissionMiddleware.js';
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
    requirePermission('INTEGRATIONS_READ'),
    log('AUDIT LOGS', 'PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION'),
    paginationMiddleware,
    getTenantIntegrations,
    log('INTEGRATIONS', 'INTEGRATION SERVICE PASSED - OPERATION SUCCESSFUL')
);

router.get('/:integration_id/activity', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), paginationMiddleware, getIntegrationActivity);
router.get('/:integration_id/audit', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), paginationMiddleware, getIntegrationAuditHistory);
router.get('/:integration_id/analytics', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), getIntegrationAnalytics);
router.post('/:integration_id/credentials/rotate', credentialRotationLimiter, sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), rotateIntegrationCredential);
router.get('/tenants/:tenant_id/settings', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), getIntegrationSettings);
router.put('/tenants/:tenant_id/settings/inventory-policy', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), updateInventoryShortagePolicy);

router.post('/:integration_id/events',
    integrationEventLimiter,
    authenticateIntegration,
    express.json({ limit: '100kb', strict: true }),
    validateAndAuthorizeIntegrationEvent,
    receiveIntegrationEvent,
);

router.get('/events', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), paginationMiddleware, searchIntegrationEvents);
router.get('/events/:event_id', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), getIntegrationEventDetail);
router.post('/events/:event_id/retry', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), retryIntegrationEvent);
router.get('/diagnostics', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), paginationMiddleware, searchIntegrationDiagnostics);
router.get('/diagnostics/unauthorized', sessionAuthMiddleware, requirePermission('AUDIT_READ'), paginationMiddleware, searchUnauthorizedIntegrationAttempts);

// Integration onboarding and lifecycle. Tenant authority comes from tenant_members (owner/admin).
router.post('/tenants/:tenant_id/apps', sessionAuthMiddleware, integrationRegistrationLimiter, requirePermission('INTEGRATIONS_READ'), createIntegration);
router.put('/:integration_id/subscriptions', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), updateSubscriptions);
router.put('/:integration_id/user-mappings', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), upsertUserMapping);
router.post('/:integration_id/activate', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), activateIntegration);
router.post('/:integration_id/suspend', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), suspendIntegration);
router.post('/:integration_id/disconnect', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), disconnectIntegration);
// Keep last so it cannot shadow /events or /diagnostics.
router.get('/:integration_id', sessionAuthMiddleware, requirePermission('INTEGRATIONS_READ'), getIntegration);

export default router;
