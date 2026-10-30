import express from 'express';
import rateLimit from 'express-rate-limit';
import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { acceptById, acceptByToken, listMyInvitations, previewInvitation } from '../services/invitationService.js';

const router = express.Router();

const acceptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user.id}`,
    validate: { keyGeneratorIpFallback: false },
    message: { error: { code: 'RATE_LIMITED', message: 'Too many invitation attempts. Try again later.' } },
});

const previewLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});
// Public: shows what a token is for (organization, role, masked address) so the landing page can say so.
router.post('/preview', previewLimiter, previewInvitation);
// The signed-in user's own pending invitations (matched on their verified email address).
router.get('/mine', sessionAuthMiddleware, listMyInvitations);
// Accept with the emailed token (the token is sent in the body, never in a URL).
router.post('/accept', sessionAuthMiddleware, acceptLimiter, acceptByToken);
router.post('/:invitation_id/accept', sessionAuthMiddleware, acceptLimiter, acceptById);

export default router;
