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

export const apiLimiter = rateLimit({
    ...baseOptions,
    windowMs: 15 * 60 * 1000,
    max: 600,
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
