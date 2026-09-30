import express from 'express';

const router = express.Router();

import { validateSignupData, validateLoginData } from '../../middleware/auth/authMiddleware.js';
import { signupUserService } from '../services/signupUserService.js';
import { loginUserService } from '../services/loginUserService.js'

router.post('/signup/', 
    validateSignupData,
    signupUserService
);

router.post('/login/',
    validateLoginData,
    loginUserService
)

export default router;