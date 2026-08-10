import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import db from '../database.js';
import { JWT_SECRET, authenticateToken } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { env } from '../config/env.js';
import { getIntSetting } from '../utils/appSettings.js';
import { buildSessionConfig } from '../utils/sessionConfig.js';
import { logUserActivity } from '../utils/activityLogger.js';
import { authenticateWithLdap } from '../utils/ldapAuth.js';
import { loginSchema, registerSchema } from '../validation/authSchemas.js';

const router = express.Router();

const getSessionConfig = () => {
    return buildSessionConfig(getIntSetting('session_timeout_hours', 8), 8);
};

const clearLoginLockState = (userId) => {
    db.prepare(`
        UPDATE users
        SET failed_login_attempts = 0,
            locked_until = NULL
        WHERE id = ?
    `).run(userId);
};

const applyFailedLoginAttempt = (user) => {
    const previousAttempts = Number(user.failed_login_attempts || 0);
    const nextAttempts = previousAttempts + 1;
    const shouldLock = nextAttempts >= env.loginMaxFailedAttempts;

    if (shouldLock) {
        const lockUntil = new Date(Date.now() + env.loginLockoutMinutes * 60 * 1000).toISOString();
        db.prepare(`
            UPDATE users
            SET failed_login_attempts = ?,
                locked_until = ?
            WHERE id = ?
        `).run(nextAttempts, lockUntil, user.id);

        return { nextAttempts, shouldLock: true, lockUntil };
    }

    db.prepare(`
        UPDATE users
        SET failed_login_attempts = ?
        WHERE id = ?
    `).run(nextAttempts, user.id);

    return { nextAttempts, shouldLock: false, lockUntil: null };
};

const logLoginFailure = ({ user, statusCode, reason, metadata = {}, deviceId, ipAddress, userAgent }) => {
    logUserActivity({
        userId: user?.id,
        userName: user?.name,
        eventName: 'auth.login.failed',
        module: 'auth',
        screen: 'login',
        success: false,
        statusCode,
        metadata: { reason, ...metadata },
        deviceId,
        ipAddress,
        userAgent,
    });
};

const PS_NUMBER_PATTERN = /^\d+$/;

const getPsNumberDomain = () => {
    const normalized = String(env.ldapPsNumberDomain || '').trim().toLowerCase().replace(/^@+/, '');
    return normalized || 'ltdic.com';
};

const normalizeIdentifier = (identifier) => String(identifier || '').trim();

const parseLoginIdentifier = (identifier) => {
    const normalized = normalizeIdentifier(identifier);
    const psNumberDomain = getPsNumberDomain();
    const psNumberDomainSuffix = `@${psNumberDomain}`;
    const normalizedLower = normalized.toLowerCase();

    if (!normalized) {
        return {
            lookupIdentifier: '',
            ldapIdentifier: '',
            provisioningIdentifier: '',
            validationError: 'Username or PS Number is required',
        };
    }

    if (normalizedLower.endsWith(psNumberDomainSuffix)) {
        const psNumber = normalized.slice(0, -psNumberDomainSuffix.length).trim();
        if (PS_NUMBER_PATTERN.test(psNumber)) {
            return {
                lookupIdentifier: psNumber,
                ldapIdentifier: `${psNumber}@${psNumberDomain}`,
                provisioningIdentifier: psNumber,
                validationError: null,
            };
        }
    }

    if (PS_NUMBER_PATTERN.test(normalized)) {
        return {
            lookupIdentifier: normalized,
            ldapIdentifier: `${normalized}@${psNumberDomain}`,
            provisioningIdentifier: normalized,
            validationError: null,
        };
    }

    if (normalized.includes('@')) {
        return {
            lookupIdentifier: '',
            ldapIdentifier: '',
            provisioningIdentifier: '',
            validationError: 'Use username or PS Number to sign in',
        };
    }

    return {
        lookupIdentifier: normalized,
        ldapIdentifier: normalized,
        provisioningIdentifier: normalized,
        validationError: null,
    };
};

const findUserByIdentifier = (identifier) => {
    const normalized = normalizeIdentifier(identifier);

    if (!normalized) {
        return null;
    }

    // Allow sign-in with PS number or username (email prefix before @).
    return db.prepare(`
        SELECT *
        FROM users
        WHERE ps_number = ?
           OR (
                instr(email, '@') > 1
                AND lower(substr(email, 1, instr(email, '@') - 1)) = lower(?)
           )
        LIMIT 1
    `).get(normalized, normalized);
};

const canUseLocalDbLogin = (user) => Boolean(user) && env.ldapAllowLocalDbLogin;

const normalizeOptionalEmail = (email) => {
    if (typeof email !== 'string') {
        return '';
    }
    const normalized = email.trim().toLowerCase();
    return normalized || '';
};

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());

const buildNameBasedEmail = (profile) => {
    // Build name.surname@larsentoubro.com from LDAP firstName + surname
    const firstName = String(profile?.firstName || '').trim().toLowerCase().replace(/\s+/g, '');
    const surname = String(profile?.surname || '').trim().toLowerCase().replace(/\s+/g, '');

    if (firstName && surname) {
        return `${firstName}.${surname}@larsentoubro.com`;
    }

    // Fallback: try splitting fullName into first/last
    const fullName = String(profile?.fullName || '').trim();
    if (fullName) {
        const parts = fullName.toLowerCase().split(/\s+/);
        if (parts.length >= 2) {
            return `${parts[0]}.${parts[parts.length - 1]}@larsentoubro.com`;
        }
    }

    return '';
};

const buildFallbackLdapEmail = (psNumber) => {
    const normalizedPsNumber = normalizeIdentifier(psNumber);
    if (!normalizedPsNumber) {
        return '';
    }

    return `${normalizedPsNumber}@${env.ldapPsNumberDomain}`.toLowerCase();
};

const resolveLdapEmail = ({ profile, psNumber }) => {
    const candidateEmails = [
        // 1. Real email from LDAP (most reliable)
        normalizeOptionalEmail(profile?.email),
        // 2. UPN from LDAP (e.g. user@domain.com)
        normalizeOptionalEmail(profile?.principalName),
        // 3. Derive from firstName.surname@larsentoubro.com
        buildNameBasedEmail(profile),
        // 4. Last resort: psnumber@ltdic.com
        buildFallbackLdapEmail(psNumber),
    ];

    return candidateEmails.find((email) => isValidEmail(email)) || '';
};

const isLikelyAutoProvisionedProfile = (user) => {
    const normalizedPsNumber = normalizeIdentifier(user?.ps_number);
    const normalizedName = normalizeIdentifier(user?.name).toLowerCase();
    const normalizedEmail = normalizeOptionalEmail(user?.email);
    const fallbackEmail = buildFallbackLdapEmail(normalizedPsNumber);

    if (!normalizedPsNumber) {
        return false;
    }

    // If name is still just the PS number or email is fallback-generated,
    // we treat this account as not yet profile-completed.
    return normalizedName === normalizedPsNumber.toLowerCase() || normalizedEmail === fallbackEmail;
};

const isProfileFullyVerified = (user) => {
    return Number(user?.profile_completed ?? 0) === 1 && Boolean(user?.profile_verified_at);
};

const upsertLdapUser = ({ psNumber, profile }) => {
    const normalizedPsNumber = normalizeIdentifier(psNumber);
    const fullName = String(profile?.fullName || normalizedPsNumber).trim() || normalizedPsNumber;
    const ldapEmail = resolveLdapEmail({ profile, psNumber: normalizedPsNumber });

    if (!ldapEmail) {
        return {
            user: null,
            errorCode: 'LDAP_EMAIL_MISSING',
            errorMessage: 'Unable to resolve a valid LDAP email address for this account.',
        };
    }

    let user = db.prepare('SELECT * FROM users WHERE ps_number = ?').get(normalizedPsNumber);
    if (!user) {
        user = db.prepare('SELECT * FROM users WHERE email = ?').get(ldapEmail);
    }

    if (!user) {
        if (!env.ldapAutoProvisionUsers) {
            return {
                user: null,
                errorCode: 'USER_NOT_PROVISIONED',
                errorMessage: 'User is not provisioned for this application.',
            };
        }

        const emailConflict = db.prepare('SELECT id FROM users WHERE email = ?').get(ldapEmail);
        if (emailConflict) {
            return {
                user: null,
                errorCode: 'LDAP_EMAIL_CONFLICT',
                errorMessage: 'LDAP email is already linked to another account. Contact administrator.',
            };
        }

        const placeholderPassword = bcrypt.hashSync(`ldap:${uuidv4()}`, 10);

        const result = db.prepare(`
            INSERT INTO users (ps_number, name, email, password, role, must_change_password, profile_completed, profile_verified_at)
            VALUES (?, ?, ?, ?, ?, 0, 0, NULL)
        `).run(normalizedPsNumber, fullName, ldapEmail, placeholderPassword, env.ldapDefaultRole);

        return {
            user: db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid),
            errorCode: null,
            errorMessage: null,
        };
    }

    const persistedPsNumber = user.ps_number || normalizedPsNumber;
    const hasVerifiedProfile = Boolean(user.profile_verified_at);
    let isProfileCompleted = Number(user.profile_completed ?? 0) === 1 && hasVerifiedProfile;

    if (!hasVerifiedProfile || (isProfileCompleted && isLikelyAutoProvisionedProfile(user))) {
        db.prepare('UPDATE users SET profile_completed = 0, profile_verified_at = NULL WHERE id = ?').run(user.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        isProfileCompleted = false;
    }

    if (isProfileCompleted) {
        db.prepare(`
            UPDATE users
            SET ps_number = ?,
                must_change_password = 0
            WHERE id = ?
        `).run(persistedPsNumber, user.id);

        return {
            user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id),
            errorCode: null,
            errorMessage: null,
        };
    }

    const emailConflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(ldapEmail, user.id);
    if (emailConflict) {
        return {
            user: null,
            errorCode: 'LDAP_EMAIL_CONFLICT',
            errorMessage: 'LDAP email is already linked to another account. Contact administrator.',
        };
    }

    db.prepare(`
        UPDATE users
        SET ps_number = ?,
            name = ?,
            email = ?,
            must_change_password = 0
        WHERE id = ?
    `).run(persistedPsNumber, fullName, ldapEmail, user.id);

    return {
        user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id),
        errorCode: null,
        errorMessage: null,
    };
};

const getLdapProvisioningStatusCode = (errorCode) => {
    if (errorCode === 'USER_NOT_PROVISIONED') {
        return 403;
    }
    if (errorCode === 'LDAP_EMAIL_CONFLICT') {
        return 409;
    }
    return 422;
};

const handleLdapProvisioningFailure = ({ errorCode, errorMessage, identifier, deviceId, ipAddress, userAgent, res }) => {
    const statusCode = getLdapProvisioningStatusCode(errorCode);

    logLoginFailure({
        statusCode,
        reason: String(errorCode || 'ldap_user_upsert_failed').toLowerCase(),
        metadata: { identifier, errorCode },
        deviceId,
        ipAddress,
        userAgent,
    });

    res.status(statusCode).json({
        error: errorMessage || 'Unable to sync LDAP profile.',
        code: errorCode || 'LDAP_USER_UPSERT_FAILED',
    });

    return null;
};

const authenticateWithLocalPassword = ({ user, password, identifier, deviceId, ipAddress, userAgent, res }) => {
    if (!user) {
        logLoginFailure({ statusCode: 400, reason: 'user_not_found', metadata: { identifier }, deviceId, ipAddress, userAgent });
        res.status(400).json({ error: 'Invalid credentials' });
        return null;
    }

    // A soft-deleted account must not authenticate. Its row is kept so audit trails,
    // job history and annexure approvals still resolve to a name, but it is no longer
    // a usable login. Deliberately answers exactly like an unknown user so the response
    // does not reveal that the account exists.
    if (user.deleted_at) {
        logLoginFailure({ statusCode: 400, reason: 'user_deleted', metadata: { identifier }, deviceId, ipAddress, userAgent });
        res.status(400).json({ error: 'Invalid credentials' });
        return null;
    }

    if (!enforceAccountLockPolicy({ user, deviceId, ipAddress, userAgent, identifier, res })) {
        return null;
    }

    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) {
        handleInvalidPassword({ user, identifier, deviceId, ipAddress, userAgent, res });
        return null;
    }

    return user;
};

const authenticateWithLdapMode = async ({
    identifier,
    ldapIdentifier,
    provisioningIdentifier,
    password,
    user,
    deviceId,
    ipAddress,
    userAgent,
    res,
}) => {
    if (user && !enforceAccountLockPolicy({ user, deviceId, ipAddress, userAgent, identifier, res })) {
        return null;
    }

    const ldapUsername = normalizeIdentifier(ldapIdentifier || identifier);
    const ldapProvisioningIdentifier = normalizeIdentifier(provisioningIdentifier || identifier);

    const ldapResult = await authenticateWithLdap({
        username: ldapUsername,
        searchUsername: ldapProvisioningIdentifier,
        password,
    });

    if (ldapResult.authenticated) {
        const { user: ldapUser, errorCode, errorMessage } = upsertLdapUser({
            psNumber: ldapProvisioningIdentifier,
            profile: ldapResult.profile,
        });
        if (!ldapUser) {
            return handleLdapProvisioningFailure({
                errorCode,
                errorMessage,
                identifier,
                deviceId,
                ipAddress,
                userAgent,
                res,
            });
        }

        if (ldapUser.deleted_at) {
            logLoginFailure({ statusCode: 400, reason: 'user_deleted', metadata: { identifier }, deviceId, ipAddress, userAgent });
            res.status(400).json({ error: 'Invalid credentials' });
            return null;
        }

        return ldapUser;
    }

    if (ldapResult.errorCode === 'USER_NOT_FOUND') {
        if (canUseLocalDbLogin(user)) {
            return authenticateWithLocalPassword({ user, password, identifier, deviceId, ipAddress, userAgent, res });
        }

        logLoginFailure({
            statusCode: 400,
            reason: 'ldap_user_not_found',
            metadata: { identifier },
            deviceId,
            ipAddress,
            userAgent,
        });

        res.status(400).json({ error: 'Invalid credentials' });
        return null;
    }

    if (ldapResult.errorCode === 'INVALID_CREDENTIALS') {
        if (canUseLocalDbLogin(user)) {
            return authenticateWithLocalPassword({ user, password, identifier, deviceId, ipAddress, userAgent, res });
        }

        logLoginFailure({
            statusCode: 400,
            reason: 'ldap_invalid_credentials',
            metadata: { identifier },
            deviceId,
            ipAddress,
            userAgent,
        });

        res.status(400).json({ error: 'Invalid credentials' });
        return null;
    }

    if (canUseLocalDbLogin(user) && env.ldapAllowLocalFallback) {
        return authenticateWithLocalPassword({ user, password, identifier, deviceId, ipAddress, userAgent, res });
    }

    logLoginFailure({
        user,
        statusCode: 503,
        reason: 'ldap_unavailable',
        metadata: {
            identifier,
            ldapErrorCode: ldapResult.errorCode,
            ldapMessage: ldapResult.message,
        },
        deviceId,
        ipAddress,
        userAgent,
    });

    res.status(503).json({
        error: 'LDAP authentication is currently unavailable. Please try again later.',
        code: 'LDAP_UNAVAILABLE',
    });

    return null;
};

const authenticateLoginUser = async ({
    identifier,
    ldapIdentifier,
    provisioningIdentifier,
    password,
    user,
    deviceId,
    ipAddress,
    userAgent,
    res,
}) => {
    if (env.ldapEnabled) {
        return authenticateWithLdapMode({
            identifier,
            ldapIdentifier,
            provisioningIdentifier,
            password,
            user,
            deviceId,
            ipAddress,
            userAgent,
            res,
        });
    }

    return authenticateWithLocalPassword({ user, password, identifier, deviceId, ipAddress, userAgent, res });
};

const enforceAccountLockPolicy = ({ user, deviceId, ipAddress, userAgent, identifier, res }) => {
    const now = new Date();
    const lockUntilDate = user.locked_until ? new Date(user.locked_until) : null;

    if (lockUntilDate && lockUntilDate > now) {
        logLoginFailure({
            user,
            statusCode: 423,
            reason: 'account_locked',
            metadata: { lockUntil: user.locked_until, identifier },
            deviceId,
            ipAddress,
            userAgent,
        });

        res.status(423).json({
            error: 'Account temporarily locked due to repeated failed login attempts. Please try again later.',
            code: 'ACCOUNT_LOCKED',
            lockUntil: user.locked_until,
        });
        return false;
    }

    if (lockUntilDate && lockUntilDate <= now && Number(user.failed_login_attempts || 0) > 0) {
        clearLoginLockState(user.id);
        user.failed_login_attempts = 0;
        user.locked_until = null;
    }

    return true;
};

const handleInvalidPassword = ({ user, identifier, deviceId, ipAddress, userAgent, res }) => {
    const failedState = applyFailedLoginAttempt(user);

    logLoginFailure({
        user,
        statusCode: failedState.shouldLock ? 423 : 400,
        reason: failedState.shouldLock ? 'account_locked_invalid_password' : 'invalid_password',
        metadata: {
            identifier,
            failedAttempts: failedState.nextAttempts,
            lockUntil: failedState.lockUntil,
        },
        deviceId,
        ipAddress,
        userAgent,
    });

    if (failedState.shouldLock) {
        res.status(423).json({
            error: 'Account temporarily locked due to repeated failed login attempts. Please try again later.',
            code: 'ACCOUNT_LOCKED',
            lockUntil: failedState.lockUntil,
        });
        return;
    }

    res.status(400).json({ error: 'Invalid credentials' });
};

const enforceDeviceBindingChecks = ({ user, deviceId, ipAddress, userAgent, res }) => {
    const accountLimit = user.account_limit || 1;
    const usersOnThisDevice = db.prepare(`
        SELECT id, name, ps_number FROM users
        WHERE registered_device_id = ? AND id != ?
    `).all(deviceId, user.id);

    if (usersOnThisDevice.length > 0) {
        const boundUserNames = usersOnThisDevice.map(u => u.name || u.ps_number).join(', ');
        const maxDeviceSlots = Math.max(accountLimit, ...usersOnThisDevice.map(u => {
            const uData = db.prepare('SELECT account_limit FROM users WHERE id = ?').get(u.id);
            return uData?.account_limit || 1;
        }));

        const totalAccountsOnDevice = usersOnThisDevice.length + 1;
        if (totalAccountsOnDevice > maxDeviceSlots) {
            db.prepare(`
                INSERT INTO device_bind_audit (user_id, device_id, action, ip_address, user_agent, details)
                VALUES (?, ?, 'REJECTED_DEVICE_TAKEN', ?, ?, ?)
            `).run(user.id, deviceId, ipAddress, userAgent, `Device already bound to: ${boundUserNames}`);

            logLoginFailure({
                user,
                statusCode: 403,
                reason: 'device_taken',
                metadata: { details: boundUserNames },
                deviceId,
                ipAddress,
                userAgent,
            });

            res.status(403).json({
                error: `This browser is already registered to another account (${boundUserNames}). Contact your administrator to unbind.`,
                code: 'DEVICE_TAKEN'
            });
            return false;
        }
    }

    if (user.registered_device_id && user.registered_device_id !== deviceId) {
        db.prepare(`
            INSERT INTO device_bind_audit (user_id, device_id, action, ip_address, user_agent, details)
            VALUES (?, ?, 'REJECTED_DEVICE_MISMATCH', ?, ?, ?)
        `).run(user.id, deviceId, ipAddress, userAgent, `User bound to device: ${user.registered_device_id.substring(0, 8)}...`);

        logLoginFailure({
            user,
            statusCode: 403,
            reason: 'device_mismatch',
            deviceId,
            ipAddress,
            userAgent,
        });

        res.status(403).json({
            error: 'Your account is bound to another device/browser. Contact your administrator to unbind.',
            code: 'DEVICE_MISMATCH'
        });
        return false;
    }

    if (!user.registered_device_id) {
        db.prepare(`
            UPDATE users SET
                registered_device_id = ?,
                device_bound_at = datetime('now'),
                device_user_agent = ?,
                device_bound_ip = ?
            WHERE id = ?
        `).run(deviceId, userAgent, ipAddress, user.id);

        db.prepare(`
            INSERT INTO device_bind_audit (user_id, device_id, action, ip_address, user_agent, details)
            VALUES (?, ?, 'BOUND', ?, ?, ?)
        `).run(user.id, deviceId, ipAddress, userAgent, 'First login — device auto-bound');

        console.log(`✓ Device bound for user ${user.ps_number || user.email}`);
    }

    return true;
};

router.get('/session-config', (req, res) => {
    const config = getSessionConfig();
    res.json({ sessionTimeoutHours: config.hours });
});

// Roles a user may obtain via public self-registration. Privileged roles
// (admin/manager/coordinator/final_approver/initiator/user) can ONLY be assigned
// by an admin through the authenticated POST /api/users/add endpoint.
const SELF_REGISTER_ROLES = ['vendor'];

// Register
router.post('/register', authLimiter, validateRequest(registerSchema), (req, res) => {
    try {
        const { name, email, password } = req.body;

        // SECURITY: never trust a client-supplied role on the public register route.
        // Anything not in the self-registration allowlist is coerced to 'vendor',
        // so an attacker cannot self-provision an admin/manager account.
        const requestedRole = String(req.body.role || '').trim().toLowerCase();
        const role = SELF_REGISTER_ROLES.includes(requestedRole) ? requestedRole : 'vendor';

        // Check if user exists
        const existingUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Hash password
        const hashedPassword = bcrypt.hashSync(password, 10);

        const sessionConfig = getSessionConfig();

        // Insert user
        const result = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)').run(
            name,
            email,
            hashedPassword,
            role
        );

        db.prepare("UPDATE users SET profile_verified_at = datetime('now') WHERE id = ?").run(result.lastInsertRowid);

        const user = { id: result.lastInsertRowid, name, email, role };
        const token = jwt.sign(user, JWT_SECRET, { expiresIn: sessionConfig.jwtExpiresIn });

        logUserActivity({
            userId: user.id,
            userName: user.name,
            eventName: 'auth.register.success',
            module: 'auth',
            screen: 'register',
            success: true,
            statusCode: 200,
            metadata: { email, role: user.role },
            deviceId: req.headers['x-device-id'] || '',
            ipAddress: req.ip || req.connection?.remoteAddress || '',
            userAgent: req.headers['user-agent'] || '',
        });

        res.json({ token, user, sessionTimeoutHours: sessionConfig.hours });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login with Device Binding + Single Session enforcement
router.post('/login', validateRequest(loginSchema), async (req, res) => {
    try {
        const { identifier: rawIdentifier, psNumber, ps_number, password } = req.body;
        const sessionConfig = getSessionConfig();
        const loginIdentifier = parseLoginIdentifier(rawIdentifier || psNumber || ps_number);
        const identifier = loginIdentifier.lookupIdentifier;
        const ldapIdentifier = loginIdentifier.ldapIdentifier;
        const provisioningIdentifier = loginIdentifier.provisioningIdentifier;
        const deviceId = req.headers['x-device-id'];
        const userAgent = req.headers['user-agent'] || '';
        const ipAddress = req.ip || req.connection?.remoteAddress || '';

        if (loginIdentifier.validationError) {
            const normalizedRawIdentifier = normalizeIdentifier(rawIdentifier || psNumber || ps_number);
            logLoginFailure({
                statusCode: 400,
                reason: normalizedRawIdentifier ? 'invalid_identifier' : 'missing_identifier',
                metadata: normalizedRawIdentifier ? { identifier: normalizedRawIdentifier } : {},
                deviceId,
                ipAddress,
                userAgent,
            });
            return res.status(400).json({ error: loginIdentifier.validationError });
        }

        if (!deviceId) {
            logLoginFailure({ statusCode: 400, reason: 'missing_device_id', metadata: { identifier }, deviceId, ipAddress, userAgent });
            return res.status(400).json({ error: 'Device identification is required. Please clear your cache and try again.' });
        }

        let user = findUserByIdentifier(identifier);

        console.log('Login attempt for:', identifier, '| Device:', deviceId?.substring(0, 8) + '...');

        user = await authenticateLoginUser({
            identifier,
            ldapIdentifier,
            provisioningIdentifier,
            password,
            user,
            deviceId,
            ipAddress,
            userAgent,
            res,
        });

        if (!user) {
            return;
        }

        if (Number(user.failed_login_attempts || 0) > 0 || user.locked_until) {
            clearLoginLockState(user.id);
        }

        if (!enforceDeviceBindingChecks({ user, deviceId, ipAddress, userAgent, res })) {
            return;
        }

        // ===== SINGLE SESSION ENFORCEMENT =====

        // Delete any existing sessions for this user (enforce single session)
        db.prepare('DELETE FROM active_sessions WHERE user_id = ?').run(user.id);

        // Create new session
        const sessionToken = uuidv4();
        const expiresAt = new Date(Date.now() + sessionConfig.durationMs).toISOString();

        db.prepare(`
            INSERT INTO active_sessions (user_id, device_id, session_token, user_agent, ip_address, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(user.id, deviceId, sessionToken, userAgent, ipAddress, expiresAt);

        // ===== ISSUE JWT =====
        const userData = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            ps_number: user.ps_number || null,
            must_change_password: user.must_change_password || 0,
            profile_completed: isProfileFullyVerified(user) ? 1 : 0,
            profile_verified_at: user.profile_verified_at || null,
            is_printer_operator: user.is_printer_operator || 0,
            is_printer_coordinator: user.is_printer_coordinator || 0,
            is_rate_approver: user.is_rate_approver || 0,
            location_id: user.location_id || null,
            session_token: sessionToken  // Embed session token in JWT for validation
        };
        const token = jwt.sign(userData, JWT_SECRET, { expiresIn: sessionConfig.jwtExpiresIn });

        logUserActivity({
            userId: user.id,
            userName: user.name,
            sessionId: sessionToken,
            deviceId,
            eventName: 'auth.login.success',
            module: 'auth',
            screen: 'login',
            success: true,
            statusCode: 200,
            metadata: { role: user.role, identifier },
            ipAddress,
            userAgent,
        });

        console.log(`✓ Login successful for ${user.ps_number || user.email} | Session: ${sessionToken.substring(0, 8)}...`);

        res.json({ token, user: userData, sessionTimeoutHours: sessionConfig.hours });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Logout — clear server-side session
router.post('/logout', authenticateToken, (req, res) => {
    try {
        db.prepare('DELETE FROM active_sessions WHERE user_id = ?').run(req.user.id);
        logUserActivity({
            userId: req.user.id,
            userName: req.user.name,
            sessionId: req.user.session_token || '',
            deviceId: req.headers['x-device-id'] || '',
            eventName: 'auth.logout',
            module: 'auth',
            screen: 'logout',
            success: true,
            statusCode: 200,
            ipAddress: req.ip || req.connection?.remoteAddress || '',
            userAgent: req.headers['user-agent'] || '',
        });
        console.log(`✓ Session cleared for user ${req.user.ps_number || req.user.email}`);
        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Logout failed' });
    }
});

export default router;
