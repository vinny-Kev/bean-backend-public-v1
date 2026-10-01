import { findCurrentUserById } from "../../auth/services/currentUserService.js";
import { destroySession } from "../../util/sessionUtils.js";

const absoluteSessionLifetime = 1000 * 60 *60 * 6;
export const sessionAuthMiddleware = async (req, res, next) => {
    const userId = req.session?.userId;
    const authenticatedAt = req.session?.authenticatedAt;
   

    if(!userId || !authenticatedAt) {
        console.log("[SESSION AUTH MIDDLEWARE]: End Process - No valid session found. User is not authenticated.");
        return res.status(401).json({ message: 'Unauthorized. Please authenticate.' });
    }
    const sessionAge = Date.now() - authenticatedAt;

    if(sessionAge >= absoluteSessionLifetime) {
        try {
            await destroySession(req);
            res.clearCookie('bean.sid', {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/'
        });
            console.log("[SESSION AUTH MIDDLEWARE]: End Process - Session expired. User is not authenticated.");
            return res.status(401).json({ message: 'Session expired. Please log in again.' });
        }
        catch (error) {
            console.error("[SESSION AUTH MIDDLEWARE]: End Process - Error destroying expired session:", error);
            return res.status(500).json({ message: 'Internal server error during session expiration handling.' });
        }
    }

    try {
        const user = await findCurrentUserById(userId);
        if(!user) {
            console.log("[SESSION AUTH MIDDLEWARE]: End Process - User not found or is disabled/deleted.");
            return res.status(401).json({ message: 'Unauthorized. User not found or is disabled/deleted.' });
        }
        req.user = {
            id: user.id,
            email: user.email,
            username: user.username,
            role_id: user.role_id,  
        };
    
    console.log("[SESSION AUTH MIDDLEWARE]: End Process SUCCESS - Session authentication passed. User is authenticated.");
    return next();

    } catch (error) {
        console.error("[SESSION AUTH MIDDLEWARE]: End Process - Error during session authentication:", error);
        return res.status(500).json({ message: 'Internal server error during session authentication.' });
    }
}
