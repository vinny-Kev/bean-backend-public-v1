import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { destroySession } from '../../util/sessionUtils.js';
import { config } from '../../config.js';

const regenerateSession = (req) => new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
});

const saveSession = (req) => new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
});

export const loginUser = async (req, res, next) => {
    try {
        await regenerateSession(req);
        req.session.userId = req.user.id;
        req.session.authenticatedAt = Date.now();
        await saveSession(req);

        await composeAuditLogs(auditLog({
            userId: req.user.id,
            action: 'LOGIN_SUCCESS',
            tableName: 'session',
            recordId: req.user.id,
        }));

        return res.status(200).json({ message: 'Login successful.', user: req.user });
    } catch (error) {
        return next(error);
    }
};

export const logoutUser = async (req, res, next) => {
    try {
        if (req.session) await destroySession(req);
        res.clearCookie('bean.sid', {
            httpOnly: true,
            secure: config.cookieSecure,
            sameSite: config.cookieSameSite,
            path: '/',
        });
        return res.status(204).end();
    } catch (error) {
        return next(error);
    }
};
