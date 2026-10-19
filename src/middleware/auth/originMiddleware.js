const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

import { allowedOrigins } from '../../server.js'

export const requireTrustedOrigin = (req, res, next) => {
    if (safeMethods.has(req.method)) {
        return next();
    }

    const requestOrigin = req.get('origin');
    console.log(`[ORIGIN MIDDLEWARE]: Request Origin: ${requestOrigin}`);

    if (!requestOrigin || !allowedOrigins.has(requestOrigin)) {
        console.log(`[ORIGIN MIDDLEWARE]: End Process - Untrusted origin`);
        return res.status(403).json({ message: 'Forbidden: Untrusted origin.' });
    }

    return next();
}