import express from 'express';

const router = express.Router();

import { validateSignupData, validateLoginData } from '../../middleware/auth/authMiddleware.js';
import { loginLimiter, signupLimiter } from '../../middleware/auth/rateLimitMiddleware.js';
import { signupUserService } from '../services/signupUserService.js';
import { loginUser, logoutUser } from '../services/userSessionService.js'
import { log } from '../../util/breadcrumb.js';
import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';

// Restore browser identity using the existing cookie and current-user checks.
// No module permission is required to read your own session identity.
router.get('/me',
    (_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        return next();
    },
    sessionAuthMiddleware,
    (req, res) => {
        const { id, username, email, roleId } = req.user;
        return res.status(200).json({ user: { id, username, email, roleId } });
    },
);

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

export default router;
