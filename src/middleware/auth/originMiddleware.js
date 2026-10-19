import { config } from '../../config.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requireTrustedOrigin = (req, res, next) => {
    if (safeMethods.has(req.method)) {
        return next();
    }

    const requestOrigin = req.get('origin');
    if (!requestOrigin || !config.allowedOrigins.has(requestOrigin)) {
        const error = new Error('Untrusted request origin.');
        error.status = 403;
        return next(error);
    }

    return next();
}
