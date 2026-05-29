import express from 'express';
import bcrypt from 'bcryptjs';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { getAllAppSettings, setSetting } from '../utils/appSettings.js';
import { logUserActivity, sanitizeActivityMetadata } from '../utils/activityLogger.js';

const ALLOWED_REMINDER_ROLES = new Set(['admin', 'manager', 'coordinator', 'final_approver', 'initiator', 'user']);

const normalizeRoleList = (input, fallback = []) => {
    if (!Array.isArray(input)) return fallback;
    const unique = [...new Set(input.map((role) => String(role || '').trim().toLowerCase()).filter(Boolean))];
    return unique.filter((role) => ALLOWED_REMINDER_ROLES.has(role));
};

const router = express.Router();
const PASSWORD_POLICY_REGEX = /^(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PASSWORD_POLICY_MESSAGE = 'New password must be at least 8 characters and include at least one number and one special character';
const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const getTableColumnSet = (tableName) => {
    try {
        const result = db.exec(`PRAGMA table_info(${tableName})`);
        const rows = result?.[0]?.values || [];
        return new Set(rows.map((row) => row[1]));
    } catch {
        return new Set();
    }
};

const tableExists = (tableName) => {
    try {
        const result = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`);
        return Boolean(result?.[0]?.values?.length);
    } catch {
        return false;
    }
};

const ACTIVITY_EVENT_TYPE_CASE = `
    CASE
      WHEN LOWER(COALESCE(event_name, '')) LIKE 'auth.%' THEN 'auth'
      WHEN LOWER(COALESCE(event_name, '')) LIKE 'screen.%' THEN 'screen'
      WHEN LOWER(COALESCE(event_name, '')) LIKE 'error.%' OR COALESCE(success, 1) = 0 OR COALESCE(status_code, 0) >= 400 THEN 'error'
      ELSE 'action'
    END
`;

const parseInteger = (value, fallback) => {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parseDateFilter = (value, endOfDay = false) => {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const finalRaw = endOfDay && raw.length === 10 ? `${raw} 23:59:59` : raw;
    const parsedDate = new Date(finalRaw);
    if (Number.isNaN(parsedDate.getTime())) return null;
    return raw.length === 10 && !endOfDay ? `${raw} 00:00:00` : finalRaw;
};

const toSanitizedMetadataString = (rawMetadata) => {
    if (!rawMetadata) return '{}';
    try {
        const parsed = typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : rawMetadata;
        return JSON.stringify(sanitizeActivityMetadata(parsed || {}));
    } catch {
        return JSON.stringify(sanitizeActivityMetadata({ raw: String(rawMetadata) }));
    }
};

const buildActivityLogFilters = (query) => {
    const whereClauses = [];
    const whereParams = [];

    const userId = parseInteger(query.userId, null);
    if (Number.isFinite(userId) && userId > 0) {
        whereClauses.push('user_id = ?');
        whereParams.push(userId);
    }

    const userName = String(query.userName || '').trim();
    if (userName) {
        whereClauses.push('LOWER(user_name) LIKE ?');
        whereParams.push(`%${userName.toLowerCase()}%`);
    }

    const eventName = String(query.eventName || '').trim();
    if (eventName) {
        whereClauses.push('LOWER(event_name) LIKE ?');
        whereParams.push(`%${eventName.toLowerCase()}%`);
    }

    const moduleName = String(query.module || '').trim();
    if (moduleName && moduleName.toLowerCase() !== 'all') {
        whereClauses.push('LOWER(module) = ?');
        whereParams.push(moduleName.toLowerCase());
    }

    const eventType = String(query.eventType || '').trim().toLowerCase();
    if (eventType && eventType !== 'all' && ['auth', 'screen', 'action', 'error'].includes(eventType)) {
        whereClauses.push(`${ACTIVITY_EVENT_TYPE_CASE} = ?`);
        whereParams.push(eventType);
    }

    const successFilter = String(query.success || '').trim().toLowerCase();
    if (successFilter === 'true' || successFilter === '1') {
        whereClauses.push('success = 1');
    } else if (successFilter === 'false' || successFilter === '0') {
        whereClauses.push('success = 0');
    }

    const fromDate = parseDateFilter(query.fromDate, false);
    if (fromDate) {
        whereClauses.push('created_at >= ?');
        whereParams.push(fromDate);
    }

    const toDate = parseDateFilter(query.toDate, true);
    if (toDate) {
        whereClauses.push('created_at <= ?');
        whereParams.push(toDate);
    }

    const search = String(query.search || '').trim().toLowerCase();
    if (search) {
        whereClauses.push(`(
            LOWER(COALESCE(user_name, '')) LIKE ?
            OR LOWER(COALESCE(event_name, '')) LIKE ?
            OR LOWER(COALESCE(module, '')) LIKE ?
            OR LOWER(COALESCE(screen, '')) LIKE ?
            OR LOWER(COALESCE(entity_type, '')) LIKE ?
            OR LOWER(COALESCE(entity_id, '')) LIKE ?
            OR LOWER(COALESCE(metadata, '')) LIKE ?
        )`);
        const wildcard = `%${search}%`;
        whereParams.push(wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard);
    }

    return {
        whereSQL: whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '',
        whereParams,
    };
};

const mapActivityRowsForResponse = (rows) => rows.map((row) => ({
    ...row,
    metadata: toSanitizedMetadataString(row.metadata),
}));

router.post('/activity', authenticateToken, (req, res) => {
    try {
        const {
            eventName,
            module,
            screen,
            entityType,
            entityId,
            durationMs,
            success,
            statusCode,
            metadata,
            sessionId,
            deviceId,
        } = req.body || {};

        if (!eventName || !String(eventName).trim()) {
            return res.status(400).json({ error: 'eventName is required' });
        }

        logUserActivity({
            userId: req.user.id,
            userName: req.user.name,
            eventName: String(eventName).trim(),
            module,
            screen,
            entityType,
            entityId,
            durationMs,
            success,
            statusCode,
            metadata,
            sessionId: sessionId || req.user.session_token || '',
            deviceId: deviceId || req.headers['x-device-id'] || '',
            ipAddress: req.ip || req.connection?.remoteAddress || '',
            userAgent: req.headers['user-agent'] || '',
        });

        return res.json({ message: 'Activity logged' });
    } catch (error) {
        console.error('Error logging user activity:', error);
        return res.status(500).json({ error: 'Failed to log activity' });
    }
});

router.get('/activity-logs', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const page = Math.max(parseInteger(req.query.page, 1), 1);
        const limitRaw = Number(req.query.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
        const offset = (page - 1) * limit;
        const { whereSQL, whereParams } = buildActivityLogFilters(req.query);

        const countRow = db.prepare(`
            SELECT COUNT(*) AS total
            FROM user_activity_logs
            ${whereSQL}
        `).get(...whereParams);

        const total = countRow?.total || 0;

        const rows = db.prepare(`
            SELECT
              id, user_id, user_name, session_id, device_id, event_name,
              module, screen, entity_type, entity_id, duration_ms, success,
                            status_code, metadata, ip_address, user_agent, created_at,
                            ${ACTIVITY_EVENT_TYPE_CASE} AS event_type
            FROM user_activity_logs
            ${whereSQL}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `).all(...whereParams, limit, offset);

        return res.json({
            rows: mapActivityRowsForResponse(rows),
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        });
    } catch (error) {
        console.error('Error fetching activity logs:', error);
        return res.status(500).json({ error: 'Failed to fetch activity logs' });
    }
});

router.get('/activity-logs/export', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const exportLimitRaw = Number(req.query.limit);
        const exportLimit = Number.isFinite(exportLimitRaw) && exportLimitRaw > 0
            ? Math.min(exportLimitRaw, 10000)
            : 5000;

        const { whereSQL, whereParams } = buildActivityLogFilters(req.query);

        const rows = db.prepare(`
            SELECT
              id, user_id, user_name, session_id, device_id, event_name,
              module, screen, entity_type, entity_id, duration_ms, success,
              status_code, metadata, ip_address, user_agent, created_at,
              ${ACTIVITY_EVENT_TYPE_CASE} AS event_type
            FROM user_activity_logs
            ${whereSQL}
            ORDER BY id DESC
            LIMIT ?
        `).all(...whereParams, exportLimit);

        logUserActivity({
            userId: req.user.id,
            userName: req.user.name,
            eventName: 'admin.logs.export.request',
            module: 'admin-logs',
            screen: '/admin-logs',
            entityType: 'activity_logs',
            success: true,
            metadata: {
                exportLimit,
                filters: req.query,
                rows: rows.length,
            },
            sessionId: req.user.session_token || '',
            deviceId: req.headers['x-device-id'] || '',
            ipAddress: req.ip || req.connection?.remoteAddress || '',
            userAgent: req.headers['user-agent'] || '',
        });

        return res.json({
            rows: mapActivityRowsForResponse(rows),
            total: rows.length,
        });
    } catch (error) {
        console.error('Error exporting activity logs:', error);
        return res.status(500).json({ error: 'Failed to export activity logs' });
    }
});

// Get all users (Admin only) — includes device binding info
router.get('/', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const userColumns = getTableColumnSet('users');
        const hasActiveSessionsTable = tableExists('active_sessions');

        const optionalUserColumns = [
            'must_change_password',
            'profile_completed',
            'registered_device_id',
            'device_bound_at',
            'device_user_agent',
            'device_bound_ip',
            'device_unbound_at',
            'account_limit',
        ];

        const selectOptionalColumns = optionalUserColumns.map((columnName) => (
            userColumns.has(columnName)
                ? columnName
                : `NULL AS ${columnName}`
        ));

        const users = db.prepare(`
            SELECT id, ps_number, name, email, role, created_at,
                   ${selectOptionalColumns.join(',\n                   ')}
            FROM users 
            ORDER BY created_at DESC
        `).all();

        // Attach active session info for each user
        const usersWithSessions = users.map(u => {
            const session = hasActiveSessionsTable
                ? db.prepare(`
                    SELECT id, device_id, ip_address, user_agent, created_at, last_seen, expires_at
                    FROM active_sessions WHERE user_id = ?
                `).get(u.id)
                : null;
            return { ...u, active_session: session || null, account_limit: u.account_limit || 1 };
        });

        res.json(usersWithSessions);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Get current user info with manager (All authenticated users)
router.get('/me', authenticateToken, (req, res) => {
    try {
        const user = db.prepare(`
            SELECT u.id, u.ps_number, u.name, u.email, u.role, u.manager_id, u.profile_completed,
                   m.name as manager_name
            FROM users u
            LEFT JOIN users m ON u.manager_id = m.id
            WHERE u.id = ?
        `).get(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            id: user.id,
            ps_number: user.ps_number,
            name: user.name,
            email: user.email,
            role: user.role,
            profile_completed: Number(user.profile_completed || 0),
            manager_id: user.manager_id,
            manager_name: user.manager_name || null
        });
    } catch (error) {
        console.error('Error fetching current user:', error);
        res.status(500).json({ error: 'Failed to fetch user info' });
    }
});

router.post('/complete-profile', authenticateToken, (req, res) => {
    try {
        const userId = req.user.id;
        const name = String(req.body?.name || '').trim();
        const email = String(req.body?.email || '').trim().toLowerCase();

        if (!name || !email) {
            return res.status(400).json({ error: 'Name and email are required.' });
        }

        if (!SIMPLE_EMAIL_REGEX.test(email)) {
            return res.status(400).json({ error: 'Please enter a valid email address.' });
        }

        const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const emailConflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
        if (emailConflict) {
            return res.status(409).json({ error: 'This email is already linked to another account.' });
        }

        db.prepare(`
            UPDATE users
            SET name = ?,
                email = ?,
                profile_completed = 1,
                profile_verified_at = datetime('now')
            WHERE id = ?
        `).run(name, email, userId);

        const updatedUser = db.prepare(`
            SELECT id, ps_number, name, email, role, must_change_password, profile_completed, profile_verified_at
            FROM users
            WHERE id = ?
        `).get(userId);

        return res.json({ user: updatedUser });
    } catch (error) {
        console.error('Error completing profile:', error);
        return res.status(500).json({ error: 'Failed to complete profile' });
    }
});

// Get all users for assignment (All authenticated users can access)
router.get('/assignable', authenticateToken, (req, res) => {
    try {
        const users = db.prepare(`
            SELECT id, ps_number, name, email, role
            FROM users 
            WHERE role IN ('user', 'initiator', 'manager', 'coordinator', 'admin')
            ORDER BY name ASC
        `).all();

        res.json(users);
    } catch (error) {
        console.error('Error fetching assignable users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Add new user (Admin only)
router.post('/add', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
    try {
        const { ps_number, name, email, password, role } = req.body;

        if (!ps_number || !name || !email || !password || !role) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Enforce L&T domain
        if (!email.toLowerCase().endsWith('@larsentoubro.com')) {
            return res.status(400).json({ error: 'Email must be in @larsentoubro.com domain' });
        }

        // Check if PS number or email already exists
        const existingUser = db.prepare(`SELECT id FROM users WHERE ps_number = ? OR email = ?`).get(ps_number, email.toLowerCase());
        if (existingUser) {
            return res.status(400).json({ error: 'PS number or email already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert new user (must_change_password defaults to 1)
        db.prepare(`
            INSERT INTO users (ps_number, name, email, password, role, must_change_password, profile_completed, profile_verified_at)
            VALUES (?, ?, ?, ?, ?, 1, 0, NULL)
        `).run(ps_number, name, email.toLowerCase(), hashedPassword, role.toLowerCase());

        res.status(201).json({
            message: 'User created successfully',
            ps_number,
            name,
            email: email.toLowerCase(),
            role
        });
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// Update user (Admin only)
router.put('/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
    try {
        const userId = req.params.id;
        const { name, email, role, password, manager_id } = req.body;

        // Validate required fields
        if (!name || !email || !role) {
            return res.status(400).json({ error: 'Name, email, and role are required' });
        }

        // Enforce L&T domain
        if (!email.toLowerCase().endsWith('@larsentoubro.com')) {
            return res.status(400).json({ error: 'Email must be in @larsentoubro.com domain' });
        }

        // Check if user exists
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const normalizedEmail = email.toLowerCase();

        // Build update query dynamically
        let updateFields = [];
        let updateValues = [];

        updateFields.push('name = ?');
        updateValues.push(name);

        updateFields.push('email = ?');
        updateValues.push(normalizedEmail);

        // Normalize role
        const normalizedRole = role.toLowerCase();
        console.log(`Updating user ${userId} with data:`, { name, email: normalizedEmail, role: normalizedRole, manager_id });

        updateFields.push('role = ?');
        updateValues.push(normalizedRole);

        if (manager_id) {
            updateFields.push('manager_id = ?');
            updateValues.push(manager_id);
        } else {
            updateFields.push('manager_id = NULL');
        }

        // Update account_limit if provided
        if (req.body.account_limit !== undefined) {
            const limit = parseInt(req.body.account_limit);
            if (limit >= 1 && limit <= 5) {
                updateFields.push('account_limit = ?');
                updateValues.push(limit);
            }
        }

        // Only update password if provided
        if (password && password.trim()) {
            const hashedPassword = await bcrypt.hash(password, 10);
            updateFields.push('password = ?');
            updateValues.push(hashedPassword);
        }

        // Add user ID at the end for WHERE clause
        updateValues.push(userId);

        const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`;
        db.prepare(query).run(...updateValues);

        res.json({
            message: 'User updated successfully',
            id: userId,
            name,
            email: normalizedEmail,
            role
        });
    } catch (error) {
        console.error('Error updating user:', error);
        // return full error details for debugging
        res.status(500).json({ error: 'Failed to update user', details: error.message });
    }
});

// Change password
router.post('/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.id;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new passwords are required' });
        }

        if (!PASSWORD_POLICY_REGEX.test(String(newPassword || ''))) {
            return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
        }

        // Get current user
        const user = db.prepare(`SELECT password FROM users WHERE id = ?`).get(userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify current password
        const isValid = await bcrypt.compare(currentPassword, user.password);

        if (!isValid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Hash new password
        const newHashedPassword = await bcrypt.hash(newPassword, 10);

        // Update password and set must_change_password to 0
        db.prepare(`
            UPDATE users 
            SET password = ?, must_change_password = 0 
            WHERE id = ?
        `).run(newHashedPassword, userId);

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// Admin reset password (Admin only)
router.post('/admin-reset-password', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
    try {
        const { psNumber, newPassword } = req.body;

        if (!psNumber || !newPassword) {
            return res.status(400).json({ error: 'PS number and new password are required' });
        }

        if (!PASSWORD_POLICY_REGEX.test(String(newPassword || ''))) {
            return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
        }

        // Find user by PS number
        const user = db.prepare(`SELECT id, name FROM users WHERE ps_number = ?`).get(psNumber);

        if (!user) {
            return res.status(404).json({ error: `User with PS number ${psNumber} not found` });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update password and set must_change_password to 0
        db.prepare(`UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?`)
            .run(hashedPassword, user.id);

        res.json({
            message: `Password reset successfully for ${user.name}`,
            userName: user.name
        });
    } catch (error) {
        console.error('Error resetting password:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// Delete user (Admin only)
router.delete('/:id', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const { id } = req.params;

        // Don't allow deleting yourself
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        // Check if user being deleted is an admin
        const userToDelete = db.prepare('SELECT role FROM users WHERE id = ?').get(id);

        if (userToDelete && userToDelete.role === 'admin') {
            // Count total admin users
            const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin');

            if (adminCount.count <= 1) {
                return res.status(400).json({ error: 'Cannot delete the last admin user. At least one admin must exist in the system.' });
            }
        }

        // Also clean up device binding data and sessions
        db.prepare('DELETE FROM active_sessions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);

        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// ===== DEVICE BINDING MANAGEMENT (Admin only) =====

// Unbind a user's device
router.post('/:id/unbind-device', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const userId = req.params.id;

        const user = db.prepare('SELECT id, name, ps_number, registered_device_id FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!user.registered_device_id) {
            return res.status(400).json({ error: 'This user has no device bound' });
        }

        const previousDeviceId = user.registered_device_id;

        // Clear device binding
        db.prepare(`
            UPDATE users SET 
                registered_device_id = NULL,
                device_bound_at = NULL,
                device_user_agent = NULL,
                device_bound_ip = NULL,
                device_unbound_at = datetime('now'),
                device_unbound_by = ?
            WHERE id = ?
        `).run(req.user.id, userId);

        // Invalidate active sessions
        db.prepare('DELETE FROM active_sessions WHERE user_id = ?').run(userId);

        // Audit log
        db.prepare(`
            INSERT INTO device_bind_audit (user_id, device_id, action, performed_by, ip_address, user_agent, details)
            VALUES (?, ?, 'ADMIN_UNBOUND', ?, ?, ?, ?)
        `).run(
            userId, previousDeviceId, req.user.id,
            req.ip || '', req.headers['user-agent'] || '',
            `Admin ${req.user.name} unbound device from user ${user.name}`
        );

        // Notify the affected user
        db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (?, ?, ?, ?)
        `).run(
            userId,
            'Device Unbound',
            `Your device binding has been reset by an administrator (${req.user.name}). Please log in again from your device.`,
            'warning'
        );

        console.log(`✓ Admin ${req.user.name} unbound device for user ${user.name}`);
        res.json({ message: `Device unbound successfully for ${user.name}. They can now log in from a new device.` });
    } catch (error) {
        console.error('Error unbinding device:', error);
        res.status(500).json({ error: 'Failed to unbind device' });
    }
});

// Force-end a user's active session (kick them out)
router.post('/:id/end-session', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const userId = req.params.id;

        const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        db.prepare('DELETE FROM active_sessions WHERE user_id = ?').run(userId);

        // Notify the user
        db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (?, ?, ?, ?)
        `).run(
            userId,
            'Session Ended',
            `Your session has been terminated by an administrator. Please log in again.`,
            'warning'
        );

        res.json({ message: `Active session ended for ${user.name}` });
    } catch (error) {
        console.error('Error ending session:', error);
        res.status(500).json({ error: 'Failed to end session' });
    }
});

// Update account limit for a user
router.post('/:id/account-limit', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const userId = req.params.id;
        const { account_limit } = req.body;

        if (!account_limit || account_limit < 1 || account_limit > 5) {
            return res.status(400).json({ error: 'Account limit must be between 1 and 5' });
        }

        const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        db.prepare('UPDATE users SET account_limit = ? WHERE id = ?').run(account_limit, userId);

        // Audit log
        db.prepare(`
            INSERT INTO device_bind_audit (user_id, device_id, action, performed_by, ip_address, user_agent, details)
            VALUES (?, ?, 'ACCOUNT_LIMIT_CHANGED', ?, ?, ?, ?)
        `).run(
            userId, '', req.user.id,
            req.ip || '', req.headers['user-agent'] || '',
            `Admin ${req.user.name} changed account limit to ${account_limit} for user ${user.name}`
        );

        res.json({ message: `Account limit updated to ${account_limit} for ${user.name}` });
    } catch (error) {
        console.error('Error updating account limit:', error);
        res.status(500).json({ error: 'Failed to update account limit' });
    }
});

// Clear ALL device data for a user (unbind + clear audit history)
router.post('/:id/clear-device-data', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const userId = req.params.id;

        const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Clear device binding
        db.prepare(`
            UPDATE users SET 
                registered_device_id = NULL,
                device_bound_at = NULL,
                device_user_agent = NULL,
                device_bound_ip = NULL,
                device_unbound_at = datetime('now'),
                device_unbound_by = ?
            WHERE id = ?
        `).run(req.user.id, userId);

        // Clear sessions
        db.prepare('DELETE FROM active_sessions WHERE user_id = ?').run(userId);

        // Clear audit logs for this user
        db.prepare('DELETE FROM device_bind_audit WHERE user_id = ?').run(userId);

        // New audit entry
        db.prepare(`
            INSERT INTO device_bind_audit (user_id, device_id, action, performed_by, ip_address, user_agent, details)
            VALUES (?, ?, 'DATA_CLEARED', ?, ?, ?, ?)
        `).run(
            userId, '', req.user.id,
            req.ip || '', req.headers['user-agent'] || '',
            `Admin ${req.user.name} cleared all device data for user ${user.name}`
        );

        res.json({ message: `All device data cleared for ${user.name}` });
    } catch (error) {
        console.error('Error clearing device data:', error);
        res.status(500).json({ error: 'Failed to clear device data' });
    }
});

// Get device binding audit log (Admin only)
router.get('/device-audit-log', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const logs = db.prepare(`
            SELECT d.*, 
                   u.name as user_name, u.ps_number as user_ps_number,
                   p.name as performed_by_name
            FROM device_bind_audit d
            LEFT JOIN users u ON d.user_id = u.id
            LEFT JOIN users p ON d.performed_by = p.id
            ORDER BY d.created_at DESC
            LIMIT 200
        `).all();

        res.json(logs);
    } catch (error) {
        console.error('Error fetching device audit log:', error);
        res.status(500).json({ error: 'Failed to fetch audit log' });
    }
});

// Get app-level settings (Admin only)
router.get('/settings/app', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const settings = getAllAppSettings();
        return res.json({
            session_timeout_hours: Number.parseInt(settings.session_timeout_hours || '8', 10),
            return_maker_checker_enabled: String(settings.return_maker_checker_enabled || '0') === '1',
            return_reminder_advance_days: Number.parseInt(settings.return_reminder_advance_days || '2', 10),
            reminder_email_roles: String(settings.reminder_email_roles || 'admin,manager,coordinator,final_approver')
                .split(',')
                .map((role) => role.trim().toLowerCase())
                .filter(Boolean),
            reminder_notification_roles: String(settings.reminder_notification_roles || 'admin,manager,coordinator,final_approver')
                .split(',')
                .map((role) => role.trim().toLowerCase())
                .filter(Boolean),
        });
    } catch (error) {
        console.error('Error fetching app settings:', error);
        return res.status(500).json({ error: 'Failed to fetch app settings' });
    }
});

// Update app-level settings (Admin only)
router.put('/settings/app', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const timeoutHours = Number.parseInt(req.body.session_timeout_hours, 10);
        const reminderDays = Number.parseInt(req.body.return_reminder_advance_days, 10);
        const makerChecker = req.body.return_maker_checker_enabled === true || String(req.body.return_maker_checker_enabled) === '1';
        const emailRoles = normalizeRoleList(req.body.reminder_email_roles, ['admin', 'manager', 'coordinator', 'final_approver']);
        const notificationRoles = normalizeRoleList(req.body.reminder_notification_roles, ['admin', 'manager', 'coordinator', 'final_approver']);

        if (!Number.isFinite(timeoutHours) || timeoutHours < 1 || timeoutHours > 72) {
            return res.status(400).json({ error: 'session_timeout_hours must be between 1 and 72' });
        }

        if (!Number.isFinite(reminderDays) || reminderDays < 0 || reminderDays > 30) {
            return res.status(400).json({ error: 'return_reminder_advance_days must be between 0 and 30' });
        }

        if (!emailRoles.length) {
            return res.status(400).json({ error: 'At least one role must be enabled for email reminders' });
        }

        if (!notificationRoles.length) {
            return res.status(400).json({ error: 'At least one role must be enabled for notification reminders' });
        }

        setSetting('session_timeout_hours', String(timeoutHours));
        setSetting('return_reminder_advance_days', String(reminderDays));
        setSetting('return_maker_checker_enabled', makerChecker ? '1' : '0');
        setSetting('reminder_email_roles', emailRoles.join(','));
        setSetting('reminder_notification_roles', notificationRoles.join(','));

        return res.json({ message: 'App settings updated successfully' });
    } catch (error) {
        console.error('Error updating app settings:', error);
        return res.status(500).json({ error: 'Failed to update app settings' });
    }
});

// Reminder history (Admin only)
router.get('/reminder-history', authenticateToken, authorizeRoles(['admin']), (req, res) => {
    try {
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 1000);
        const moduleFilter = String(req.query.module || 'all').toLowerCase();

        const rows = [];

        if (moduleFilter === 'all' || moduleFilter === 'asset') {
            const assetRows = db.prepare(`
                SELECT
                    rl.id,
                    'asset' AS module,
                    rl.reminder_type AS reminder_code,
                    CASE
                        WHEN rl.reminder_type = 'overdue' THEN 'Overdue'
                        ELSE 'Due Soon'
                    END AS reminder_label,
                    rl.reminder_date,
                    rl.created_at,
                    a.asset_uid AS reference_no,
                    a.asset_name AS subject_name,
                    a.vendor_name AS party_name,
                    aa.assigned_to_name AS pending_with,
                    aa.expected_return_date AS pending_since_or_due,
                    COALESCE(aa.return_request_status, 'none') AS status_text,
                    u.name AS requester_name,
                    u.role AS requester_role,
                    '' AS recipients
                FROM asset_return_reminder_logs rl
                LEFT JOIN asset_assignments aa ON aa.id = rl.assignment_id
                LEFT JOIN assets a ON a.id = aa.asset_id
                LEFT JOIN users u ON u.id = aa.return_requested_by
                ORDER BY datetime(rl.created_at) DESC
                LIMIT ?
            `).all(limit);

            rows.push(...assetRows);
        }

        if (moduleFilter === 'all' || moduleFilter === 'jcc') {
            const jccRows = db.prepare(`
                SELECT
                    rl.id,
                    'jcc' AS module,
                    rl.approval_level AS reminder_code,
                    CASE
                        WHEN rl.approval_level = 'level_1' THEN 'Manager Approval Pending'
                        ELSE 'Final Approval Pending'
                    END AS reminder_label,
                    rl.reminder_date,
                    rl.created_at,
                    ('JCC' || printf('%04d', v.id)) AS reference_no,
                    'JCC Approval' AS subject_name,
                    v.supplier AS party_name,
                    CASE
                        WHEN rl.approval_level = 'level_1' THEN v.approver1_name
                        ELSE COALESCE(v.approver2_name, v.approver1_name)
                    END AS pending_with,
                    v.created_at AS pending_since_or_due,
                    v.status AS status_text,
                    u.name AS requester_name,
                    u.role AS requester_role,
                    COALESCE(rl.recipients, '') AS recipients
                FROM jcc_approval_reminder_logs rl
                LEFT JOIN voucher_requests v ON v.id = rl.voucher_id
                LEFT JOIN users u ON u.id = v.user_id
                ORDER BY datetime(rl.created_at) DESC
                LIMIT ?
            `).all(limit);

            rows.push(...jccRows);
        }

        rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

        return res.json(rows.slice(0, limit).map((row) => ({
            ...row,
            row_id: `${row.module}-${row.id}`,
        })));
    } catch (error) {
        console.error('Error fetching reminder history:', error);
        return res.status(500).json({ error: 'Failed to fetch reminder history' });
    }
});

export default router;
