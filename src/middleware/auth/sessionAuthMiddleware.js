export const sessionAuthMiddleware = async (req, res, next) => {
    const userId = req.session?.userId;
    const roleId = req.session?.role;

    if(!userId) {
        console.log("[SESSION AUTH MIDDLEWARE]: End Process - No valid session found. User is not authenticated.");
        return res.status(401).json({ message: 'Unauthorized. Please authenticate.' });
    }

    req.user = {
        id: userId,
    };
    
    console.log("[SESSION AUTH MIDDLEWARE]: End Process SUCCESS - Session authentication passed. User is authenticated.");
    return next();
}
