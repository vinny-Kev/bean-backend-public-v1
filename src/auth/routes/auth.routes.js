import express from 'express';

const router = express.Router();

import { validateSignupData, validateLoginData } from '../../middleware/auth/authMiddleware.js';
import { loginLimiter, signupLimiter } from '../../middleware/auth/rateLimitMiddleware.js';
import { signupUserService } from '../services/signupUserService.js';
import { loginUser, logoutUser } from '../services/userSessionService.js'
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

export default router;