import rateLimit from 'express-rate-limit';

export const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    limit: 3,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        message: 'Too many login attempts from this IP, please try again after 15 minutes.'
    },
    skipSuccessfulRequests: true,
})

export const signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false
})

// Identity endpoints. All answer 429 with the standard error envelope.
const limited = (message) => ({ error: { code: 'RATE_LIMITED', message } });
const base = { standardHeaders: 'draft-8', legacyHeaders: false };

// Failed sign-ins per ACCOUNT (the IP limiter above only sees one address, which is shared behind a proxy).
export const loginAccountLimiter = rateLimit({
    ...base, windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true,
    keyGenerator: (req) => `acct:${String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254)}`,
    validate: { keyGeneratorIpFallback: false },
    message: limited('Too many sign-in attempts for this account. Try again later.'),
});
export const codeSubmitLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 20, message: limited('Too many code attempts. Try again later.') });
export const codeRequestLimiter = rateLimit({ ...base, windowMs: 60 * 60 * 1000, limit: 10, message: limited('Too many requests. Try again later.') });
export const passwordResetLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 10, message: limited('Too many attempts. Try again later.') });
export const accountChangeLimiter = rateLimit({
    ...base, windowMs: 60 * 60 * 1000, limit: 10,
    keyGenerator: (req) => `user:${req.user.id}`,
    validate: { keyGeneratorIpFallback: false },
    message: limited('Too many account change requests. Try again later.'),
});
