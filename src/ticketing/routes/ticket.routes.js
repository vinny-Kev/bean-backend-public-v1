import { Router } from 'express';
import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { TicketError, tenantAccess } from '../services/ticketShared.js';
import {
    listTickets,
    getTicket,
    createTicket,
    listAssignments,
    assignTicket,
    acknowledgeTicket,
    changeStatus,
} from '../services/tickets.js';
import { listComments, addComment, listActivity } from '../services/conversation.js';
import { listInboxes, createInbox } from '../services/inboxes.js';
import { getEstimate, setEstimate, listVerifications, verifyWork, revokeVerification } from '../services/points.js';
import { workSummary } from '../services/workSummary.js';

const router = Router();
const tenantRouter = Router({ mergeParams: true });
router.use(sessionAuthMiddleware);
tenantRouter.use(tenantAccess);

const handle =
    (operation, status = 200) =>
    async (req, res, next) => {
        try {
            const result = await operation(req.ticketAccess, req);
            // Paginated lists return { data, pagination } like every other module.
            res.status(status).json(result?.pagination ? result : { data: result });
        } catch (error) {
            next(error);
        }
    };

tenantRouter.get(
    '/inboxes',
    handle((access) => listInboxes(access)),
);
tenantRouter.post(
    '/inboxes',
    handle((access, req) => createInbox(access, req.body), 201),
);
tenantRouter.get(
    '/tickets',
    handle((access, req) => listTickets(access, req.query)),
);
tenantRouter.post(
    '/tickets',
    handle((access, req) => createTicket(access, req.body), 201),
);
tenantRouter.get(
    '/tickets/:ticketId',
    handle((access, req) => getTicket(access, req.params.ticketId)),
);
tenantRouter.get(
    '/tickets/:ticketId/assignments',
    handle((access, req) => listAssignments(access, req.params.ticketId)),
);
tenantRouter.post(
    '/tickets/:ticketId/assignments',
    handle((access, req) => assignTicket(access, req.params.ticketId, req.body)),
);
tenantRouter.post(
    '/tickets/:ticketId/acknowledge',
    handle((access, req) => acknowledgeTicket(access, req.params.ticketId)),
);
tenantRouter.patch(
    '/tickets/:ticketId/status',
    handle((access, req) => changeStatus(access, req.params.ticketId, req.body)),
);
tenantRouter.get(
    '/tickets/:ticketId/comments',
    handle((access, req) => listComments(access, req.params.ticketId)),
);
tenantRouter.post(
    '/tickets/:ticketId/comments',
    handle((access, req) => addComment(access, req.params.ticketId, req.body), 201),
);
tenantRouter.get(
    '/tickets/:ticketId/activity',
    handle((access, req) => listActivity(access, req.params.ticketId)),
);
tenantRouter.get(
    '/tickets/:ticketId/story-points',
    handle((access, req) => getEstimate(access, req.params.ticketId)),
);
tenantRouter.put(
    '/tickets/:ticketId/story-points',
    handle((access, req) => setEstimate(access, req.params.ticketId, req.body)),
);
tenantRouter.get(
    '/tickets/:ticketId/verifications',
    handle((access, req) => listVerifications(access, req.params.ticketId)),
);
tenantRouter.post(
    '/tickets/:ticketId/verifications',
    handle((access, req) => verifyWork(access, req.params.ticketId, req.body), 201),
);
tenantRouter.post(
    '/tickets/:ticketId/verifications/:verificationId/revoke',
    handle((access, req) => revokeVerification(access, req.params.ticketId, req.params.verificationId)),
);
tenantRouter.get(
    '/work-summary/:userId',
    handle((access, req) => workSummary(access, req.params.userId, req.query)),
);

router.use('/tenants/:tenantId', tenantRouter);
router.use((error, req, res, next) => {
    if (!(error instanceof TicketError)) return next(error);
    return res.status(error.status).json({
        error: { code: error.code, message: error.message, requestId: req.requestId },
    });
});

export default router;
