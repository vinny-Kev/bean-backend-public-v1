import express from 'express';

const router = express.Router();

import { validateSignupData, validateLoginData } from '../../middleware/auth/authMiddleware.js';
import {
    accountChangeLimiter, codeRequestLimiter, codeSubmitLimiter, loginAccountLimiter, loginLimiter, passwordResetLimiter, signupLimiter,
} from '../../middleware/auth/rateLimitMiddleware.js';
import { signupUserService, verifyEmailService, resendVerificationService } from '../services/signupUserService.js';
import { loginUser, logoutUser, verifyLoginStepUp } from '../services/userSessionService.js';
import { confirmEmailChange, forgotPassword, requestEmailChange, resetPassword } from '../services/credentialService.js';
import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { findAccountPermissions } from '../services/currentUserService.js';
import { log } from '../../util/breadcrumb.js';

router.post('/signup/',
    log('SIGNUP', 'SIGNUP ROUTE START'),
    signupLimiter,
    validateSignupData,
    log('SIGNUP', 'SIGNUP DATA VALIDATED'),
    signupUserService,
);

router.post('/verify-email', codeSubmitLimiter, verifyEmailService);
router.post('/verify-email/resend', codeRequestLimiter, resendVerificationService);

router.post('/login/',
    loginLimiter,
    loginAccountLimiter,
    validateLoginData,
    log('LOGIN', 'LOGIN DATA VALIDATED'),
    loginUser,
    log('LOGIN', 'USER LOG IN SUCCESS')
)

// Second step of a sign-in that needs an emailed code (unrecognised device).
router.post('/login/verify', codeSubmitLimiter, verifyLoginStepUp);

router.post('/logout',
    log('LOGOUT', 'LOGOUT ROUTE START'),
    logoutUser,
    log('LOGOUT', 'LOGOUT ROUTE SUCCESS')
)

router.post('/password/forgot', codeRequestLimiter, forgotPassword);
router.post('/password/reset', passwordResetLimiter, resetPassword);

router.post('/email-change/request', sessionAuthMiddleware, accountChangeLimiter, requestEmailChange);
router.post('/email-change/confirm', sessionAuthMiddleware, codeSubmitLimiter, confirmEmailChange);

router.get('/me',
    sessionAuthMiddleware,
    async (req, res, next) => {
        try {
            res.set('Cache-Control', 'no-store');
            res.status(200).json({ user: { ...req.user, emailVerified: true, permissions: await findAccountPermissions(req.user.id) } });
        } catch (error) {
            next(error);
        }
    }
)

export default router;
