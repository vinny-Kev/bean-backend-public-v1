import express from 'express';
import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { getOnboarding } from '../services/onboardingService.js';

const router = express.Router();

// Derived onboarding state for the signed-in user (nothing is stored).
router.get('/', sessionAuthMiddleware, getOnboarding);

export default router;
