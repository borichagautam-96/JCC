const NODE_ENV = process.env.NODE_ENV || 'development';

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

const requireEnv = (name, options = {}) => {
    const {
        defaultValue,
        requiredInProduction = false,
    } = options;

    const raw = process.env[name];
    if (!isBlank(raw)) {
        return String(raw).trim();
    }

    if (requiredInProduction && NODE_ENV === 'production') {
        throw new Error(`[ENV] Missing required environment variable: ${name}`);
    }

    return defaultValue;
};

const parsePort = (value, fallback = 8032) => {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        return fallback;
    }
    return parsed;
};

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
};

export const env = {
    nodeEnv: NODE_ENV,
    isProduction: NODE_ENV === 'production',
    port: parsePort(process.env.PORT, 8032),
    loginMaxFailedAttempts: parsePositiveInt(process.env.LOGIN_MAX_FAILED_ATTEMPTS, 5),
    loginLockoutMinutes: parsePositiveInt(process.env.LOGIN_LOCKOUT_MINUTES, 15),
    jwtSecret: requireEnv('JWT_SECRET', {
        defaultValue: 'jcc-automation-dev-secret-change-me',
        requiredInProduction: true,
    }),
    appBaseUrl: requireEnv('APP_BASE_URL', { defaultValue: '' }),
};

export const validateStartupEnv = () => {
    const warnings = [];

    if (!process.env.JWT_SECRET && !env.isProduction) {
        warnings.push('JWT_SECRET is not set. Using development fallback secret.');
    }

    if (!process.env.APP_BASE_URL) {
        warnings.push('APP_BASE_URL is not set. Email links may use fallback URLs.');
    }

    if (!process.env.LOGIN_MAX_FAILED_ATTEMPTS) {
        warnings.push('LOGIN_MAX_FAILED_ATTEMPTS not set. Using default of 5.');
    }

    if (!process.env.LOGIN_LOCKOUT_MINUTES) {
        warnings.push('LOGIN_LOCKOUT_MINUTES not set. Using default of 15.');
    }

    return warnings;
};
