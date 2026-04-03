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

const parseBoolean = (value, fallback = false) => {
    if (isBlank(value)) {
        return fallback;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return fallback;
};

const normalizeAuthProvider = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'ldap') {
        return 'ldap';
    }
    return 'local';
};

const normalizeRole = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    const allowedRoles = new Set([
        'vendor',
        'coordinator',
        'admin',
        'manager',
        'initiator',
        'user',
        'final_approver',
    ]);

    if (allowedRoles.has(normalized)) {
        return normalized;
    }

    return 'user';
};

const authProvider = normalizeAuthProvider(process.env.AUTH_PROVIDER || 'local');

export const env = {
    nodeEnv: NODE_ENV,
    isProduction: NODE_ENV === 'production',
    port: parsePort(process.env.PORT, 8032),
    authProvider,
    ldapEnabled: authProvider === 'ldap' || parseBoolean(process.env.LDAP_ENABLED, false),
    ldapUrl: requireEnv('LDAP_URL', { defaultValue: 'ldap://172.16.128.77:389' }),
    ldapBaseDn: requireEnv('LDAP_BASE_DN', { defaultValue: '' }),
    ldapDomain: requireEnv('LDAP_DOMAIN', { defaultValue: '' }),
    ldapBindTemplate: requireEnv('LDAP_BIND_TEMPLATE', { defaultValue: '' }),
    ldapUserAttribute: requireEnv('LDAP_USER_ATTRIBUTE', { defaultValue: 'sAMAccountName' }),
    ldapSearchFilterTemplate: requireEnv('LDAP_SEARCH_FILTER_TEMPLATE', {
        defaultValue: '({{userAttribute}}={{username}})',
    }),
    ldapConnectTimeoutMs: parsePositiveInt(process.env.LDAP_CONNECT_TIMEOUT_MS, 5000),
    ldapTimeoutMs: parsePositiveInt(process.env.LDAP_TIMEOUT_MS, 5000),
    ldapAutoProvisionUsers: parseBoolean(process.env.LDAP_AUTO_PROVISION_USERS, true),
    ldapAllowLocalDbLogin: parseBoolean(process.env.LDAP_ALLOW_LOCAL_DB_LOGIN, true),
    ldapAllowLocalFallback: parseBoolean(process.env.LDAP_ALLOW_LOCAL_FALLBACK, true),
    ldapDefaultRole: normalizeRole(process.env.LDAP_DEFAULT_ROLE || 'user'),
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
    const pushWarningIf = (condition, message) => {
        if (condition) {
            warnings.push(message);
        }
    };

    pushWarningIf(!process.env.JWT_SECRET && !env.isProduction, 'JWT_SECRET is not set. Using development fallback secret.');
    pushWarningIf(!process.env.APP_BASE_URL, 'APP_BASE_URL is not set. Email links may use fallback URLs.');
    pushWarningIf(!process.env.LOGIN_MAX_FAILED_ATTEMPTS, 'LOGIN_MAX_FAILED_ATTEMPTS not set. Using default of 5.');
    pushWarningIf(!process.env.LOGIN_LOCKOUT_MINUTES, 'LOGIN_LOCKOUT_MINUTES not set. Using default of 15.');
    pushWarningIf(!process.env.AUTH_PROVIDER, 'AUTH_PROVIDER not set. Using default of local.');
    pushWarningIf(env.ldapEnabled && !process.env.LDAP_URL, 'LDAP_URL not set. Using default of ldap://172.16.128.77:389.');
    pushWarningIf(env.ldapEnabled && !process.env.LDAP_BASE_DN, 'LDAP_BASE_DN not set. LDAP root naming context discovery will be attempted.');
    pushWarningIf(env.ldapEnabled && !process.env.LDAP_ALLOW_LOCAL_DB_LOGIN, 'LDAP_ALLOW_LOCAL_DB_LOGIN not set. Using default of true for existing local users.');
    pushWarningIf(env.ldapEnabled && !process.env.LDAP_ALLOW_LOCAL_FALLBACK, 'LDAP_ALLOW_LOCAL_FALLBACK not set. Using default of true for local DB fallback when LDAP is unavailable.');
    pushWarningIf(env.ldapEnabled && env.ldapUrl.toLowerCase().startsWith('ldap://'), 'LDAP is configured over plain ldap:// (not encrypted). Use only in trusted networks.');

    return warnings;
};
