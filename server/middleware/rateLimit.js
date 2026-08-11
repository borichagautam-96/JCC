import rateLimit from 'express-rate-limit';

const baseOptions = {
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        res.status(429).json({
            error: 'Too many requests. Please try again later.',
        });
    },
};

// 600 requests / 15 min per IP is the production ceiling and stays the default.
//
// It is overridable only so a browser-driven test run — which loads the whole app
// repeatedly from one address and can exhaust the window legitimately — does not have
// to weaken the shipped limit to run. Left unset, behaviour is exactly as before.
const API_RATE_MAX = Number.parseInt(process.env.API_RATE_LIMIT_MAX ?? '', 10);

export const apiLimiter = rateLimit({
    ...baseOptions,
    windowMs: 15 * 60 * 1000,
    max: Number.isFinite(API_RATE_MAX) && API_RATE_MAX > 0 ? API_RATE_MAX : 600,
    skip: (req) => req.path === '/auth/login' || req.originalUrl.startsWith('/api/auth/login'),
});

export const authLimiter = rateLimit({
    ...baseOptions,
    windowMs: 15 * 60 * 1000,
    max: 12,
});

export const loginLimiter = rateLimit({
    ...baseOptions,
    windowMs: 15 * 60 * 1000,
    max: 8,
});

export const uploadLimiter = rateLimit({
    ...baseOptions,
    windowMs: 15 * 60 * 1000,
    max: 40,
});
