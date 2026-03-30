import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import db from '../database.js';
import { JWT_SECRET, authenticateToken } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { authLimiter, loginLimiter } from '../middleware/rateLimit.js';
import { env } from '../config/env.js';
import { getIntSetting } from '../utils/appSettings.js';
import { buildSessionConfig } from '../utils/sessionConfig.js';
import { logUserActivity } from '../utils/activityLogger.js';
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

const findUserByIdentifier = (identifier) => {
    let user = db.prepare('SELECT * FROM users WHERE ps_number = ?').get(identifier);
    if (!user) {
        user = db.prepare('SELECT * FROM users WHERE email = ?').get(identifier);
    }
    return user;
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

// Register
router.post('/register', authLimiter, validateRequest(registerSchema), (req, res) => {
    try {
        const { name, email, password, role } = req.body;

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
            role || 'vendor'
        );

        const user = { id: result.lastInsertRowid, name, email, role: role || 'vendor' };
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
router.post('/login', loginLimiter, validateRequest(loginSchema), (req, res) => {
    try {
        const { email, psNumber, ps_number, password } = req.body;
        const sessionConfig = getSessionConfig();
        const identifier = email || psNumber || ps_number;
        const deviceId = req.headers['x-device-id'];
        const userAgent = req.headers['user-agent'] || '';
        const ipAddress = req.ip || req.connection?.remoteAddress || '';

        if (!identifier) {
            logLoginFailure({ statusCode: 400, reason: 'missing_identifier', deviceId, ipAddress, userAgent });
            return res.status(400).json({ error: 'Email or PS Number is required' });
        }

        if (!deviceId) {
            logLoginFailure({ statusCode: 400, reason: 'missing_device_id', metadata: { identifier }, deviceId, ipAddress, userAgent });
            return res.status(400).json({ error: 'Device identification is required. Please clear your cache and try again.' });
        }

        const user = findUserByIdentifier(identifier);

        console.log('Login attempt for:', identifier, '| Device:', deviceId?.substring(0, 8) + '...');

        if (!user) {
            logLoginFailure({ statusCode: 400, reason: 'user_not_found', metadata: { identifier }, deviceId, ipAddress, userAgent });
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        if (!enforceAccountLockPolicy({ user, deviceId, ipAddress, userAgent, identifier, res })) {
            return;
        }

        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) {
            handleInvalidPassword({ user, identifier, deviceId, ipAddress, userAgent, res });
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
