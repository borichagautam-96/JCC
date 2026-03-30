import jwt from 'jsonwebtoken';
import db from '../database.js';
import { env } from '../config/env.js';

const JWT_SECRET = env.jwtSecret;

export const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const verified = jwt.verify(token, JWT_SECRET);
        req.user = verified;

        // ===== DEVICE BINDING + SESSION VALIDATION =====
        const deviceId = req.headers['x-device-id'];
        const sessionToken = verified.session_token;

        // Skip device validation for logout (the user is leaving anyway)
        if (req.path === '/logout') {
            return next();
        }

        // If we have a session_token in the JWT, validate it against the DB
        if (sessionToken) {
            const activeSession = db.prepare(`
                SELECT * FROM active_sessions 
                WHERE user_id = ? AND session_token = ?
            `).get(verified.id, sessionToken);

            if (!activeSession) {
                // Session was invalidated (admin unbind, or another login replaced it)
                return res.status(401).json({ 
                    error: 'Your session has been ended. Please log in again.',
                    code: 'SESSION_INVALIDATED'
                });
            }

            // Check if session expired
            if (new Date(activeSession.expires_at) < new Date()) {
                // Clean up expired session
                db.prepare('DELETE FROM active_sessions WHERE id = ?').run(activeSession.id);
                return res.status(401).json({ 
                    error: 'Your session has expired. Please log in again.',
                    code: 'SESSION_EXPIRED'
                });
            }

            // Validate device_id matches session's device
            if (deviceId && activeSession.device_id !== deviceId) {
                return res.status(403).json({
                    error: 'Device mismatch detected. Please log in again from your registered device.',
                    code: 'DEVICE_SESSION_MISMATCH'
                });
            }

            // Update last_seen timestamp (throttle: only update if > 1 min since last update)
            const lastSeen = new Date(activeSession.last_seen);
            const now = new Date();
            if (now - lastSeen > 60000) {
                db.prepare('UPDATE active_sessions SET last_seen = datetime(\'now\') WHERE id = ?').run(activeSession.id);
            }
        }

        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired. Please log in again.', code: 'TOKEN_EXPIRED' });
        }
        res.status(403).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    }
};

export const authorizeRoles = (...roles) => {
    return (req, res, next) => {
        const userRole = (req.user.role || '').toLowerCase();
        // Flatten the roles array in case it's passed as authorizeRoles(['admin']) or authorizeRoles('admin')
        const flatRoles = roles.flat();
        const allowedRoles = flatRoles.map(role => String(role || '').toLowerCase());

        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
        }
        next();
    };
};

export { JWT_SECRET };
