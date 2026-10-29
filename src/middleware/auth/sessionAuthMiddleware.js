import { findCurrentUserById } from "../../auth/services/currentUserService.js";
import { destroySession } from "../../util/sessionUtils.js";
import { config } from "../../config.js";

const absoluteSessionLifetime = 1000 * 60 *60 * 6;
const clearSessionCookie = (res) => res.clearCookie('bean.sid', {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: '/',
});

export const sessionAuthMiddleware = async (req, res, next) => {
    const userId = req.session?.userId;
    const authenticatedAt = req.session?.authenticatedAt;

    if (!userId) {
        return res.status(401).json({ message: 'Unauthorized. Please authenticate.' });
    }
    if (!Number.isSafeInteger(authenticatedAt) || authenticatedAt > Date.now()) {
        try {
            await destroySession(req);
            clearSessionCookie(res);
            return res.status(401).json({ message: 'Unauthorized. Please authenticate.' });
        } catch (error) {
            return next(error);
        }
    }
    const sessionAge = Date.now() - authenticatedAt;

    if(sessionAge >= absoluteSessionLifetime) {
        try {
            await destroySession(req);
            clearSessionCookie(res);
            return res.status(401).json({ message: 'Session expired. Please log in again.' });
        }
        catch (error) {
            return next(error);
        }
    }

    try {
        const user = await findCurrentUserById(userId);
        if(!user) {
            await destroySession(req);
            clearSessionCookie(res);
            return res.status(401).json({ message: 'Unauthorized. Please authenticate.' });
        }
        req.user = {
            id: user.id,
            email: user.email,
            username: user.username,
            fullName: user.fullName,
            roleId: user.roleId,
        };
    return next();

    } catch (error) {
        return next(error);
    }
}
