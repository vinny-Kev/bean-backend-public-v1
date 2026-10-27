import express from 'express';

const router = express.Router();

import { validateSignupData, validateLoginData } from '../../middleware/auth/authMiddleware.js';
import { loginLimiter, signupLimiter } from '../../middleware/auth/rateLimitMiddleware.js';
import { signupUserService } from '../services/signupUserService.js';
import { loginUser, logoutUser } from '../services/userSessionService.js'
import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { findAccountPermissions } from '../services/currentUserService.js';
import { log } from '../../util/breadcrumb.js';

router.post('/signup/', 
    log('SIGNUP', 'SIGNUP ROUTE START'),
    signupLimiter,
    validateSignupData,
    log('SIGNUP', 'SIGNUP DATA VALIDATED'),
    signupUserService,
     log('SIGNUP', 'SIGNUP DATA COMMITTED'),
);

router.post('/login/',
    loginLimiter,
    validateLoginData,
    log('LOGIN', 'LOGIN DATA VALIDATED'),
    loginUser,
    log('LOGIN', 'USER LOG IN SUCCESS')
)

router.post('/logout',
    log('LOGOUT', 'LOGOUT ROUTE START'),
    logoutUser,
    log('LOGOUT', 'LOGOUT ROUTE SUCCESS')
)

router.get('/me',
    sessionAuthMiddleware,
    async (req, res, next) => {
        try {
            res.set('Cache-Control', 'no-store');
            res.status(200).json({ user: { ...req.user, permissions: await findAccountPermissions(req.user.id) } });
        } catch (error) {
            next(error);
        }
    }
)

export default router;