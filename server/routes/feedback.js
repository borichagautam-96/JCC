import express from 'express';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { sendEmail } from '../utils/emailService.js';

const router = express.Router();

const FEEDBACK_TYPES = new Set(['bug', 'feature_request', 'improvement', 'ui_ux', 'performance', 'other']);
const FEEDBACK_STATUSES = new Set(['new', 'triaged', 'in_progress', 'resolved', 'closed']);
const FEEDBACK_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const DEMO_TITLE_MARKERS = ['feedback api e2e'];
const DEMO_DESCRIPTION_MARKERS = ['automated api token flow check'];

const toTrimmedString = (value) => String(value ?? '').trim();

const parseOptionalInt = (value) => {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
};

const parseBooleanInt = (value, fallback = 0) => {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return 1;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return 0;
    }

    return fallback;
};

const normalizeFeedbackType = (value) => {
    const normalized = toTrimmedString(value).toLowerCase();
    return FEEDBACK_TYPES.has(normalized) ? normalized : null;
};

const normalizeFeedbackStatus = (value) => {
    const normalized = toTrimmedString(value).toLowerCase();
    return FEEDBACK_STATUSES.has(normalized) ? normalized : null;
};

const normalizeFeedbackPriority = (value) => {
    const normalized = toTrimmedString(value).toLowerCase();
    return FEEDBACK_PRIORITIES.has(normalized) ? normalized : null;
};

const parseListLimit = (value, fallback = 100, max = 500) => {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(parsed, max);
};

const isDemoFeedbackSubmission = ({ title, description, submitterEmail }) => {
    const normalizedTitle = toTrimmedString(title).toLowerCase();
    const normalizedDescription = toTrimmedString(description).toLowerCase();
    const normalizedEmail = toTrimmedString(submitterEmail).toLowerCase();

    const titleLooksDemo = DEMO_TITLE_MARKERS.some((marker) => normalizedTitle.includes(marker));
    const descriptionLooksDemo = DEMO_DESCRIPTION_MARKERS.some((marker) => normalizedDescription.includes(marker));
    const isExampleDomain = normalizedEmail.endsWith('@example.com');

    return titleLooksDemo || descriptionLooksDemo || isExampleDomain;
};

const toFeedbackTypeLabel = (feedbackType) => {
    const normalized = toTrimmedString(feedbackType).replaceAll('_', ' ');
    return normalized || 'feedback';
};

const trimToMaxLength = (value, maxLength = 150) => {
    const normalized = toTrimmedString(value);
    if (!normalized) {
        return '';
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return normalized.slice(0, maxLength).trim();
};

const buildFeedbackFallbackTitle = ({ feedbackType, description }) => {
    const typeLabel = toFeedbackTypeLabel(feedbackType);
    const normalizedDescription = toTrimmedString(description).replaceAll(/\s+/g, ' ');
    const seed = normalizedDescription ? `${typeLabel}: ${normalizedDescription}` : `${typeLabel} feedback`;
    return trimToMaxLength(seed, 150) || 'feedback';
};

const getFeedbackNotificationRecipients = () => {
    const roles = Array.isArray(env.feedbackNotificationRoles) && env.feedbackNotificationRoles.length
        ? env.feedbackNotificationRoles
        : ['admin'];

    const placeholders = roles.map(() => '?').join(', ');
    return db.prepare(`
        SELECT id, name, email, role
        FROM users
        WHERE lower(role) IN (${placeholders})
        ORDER BY id ASC
    `).all(...roles);
};

const feedbackSubmissionEmailTemplate = ({
    recipientName,
    submissionId,
    submittedByName,
    feedbackTypeLabel,
    title,
    modulePath,
}) => {
    const moduleLine = modulePath
        ? `<p><strong>Module:</strong> ${modulePath}</p>`
        : '';

    return {
        subject: `[Feedback] #${submissionId} ${feedbackTypeLabel} submitted`,
        html: `
            <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.55;">
                <p>Dear <strong>${recipientName || 'Team'}</strong>,</p>
                <p>A new feedback item has been submitted and is ready for triage.</p>
                <p><strong>ID:</strong> #${submissionId}</p>
                <p><strong>Submitted By:</strong> ${submittedByName}</p>
                <p><strong>Type:</strong> ${feedbackTypeLabel}</p>
                <p><strong>Title:</strong> ${title}</p>
                ${moduleLine}
            </div>
        `,
    };
};

const triggerFeedbackSubmissionNotifications = async ({
    submissionId,
    submittedByName,
    feedbackType,
    title,
    modulePath,
}) => {
    if (!env.feedbackInAppNotificationsEnabled && !env.feedbackEmailNotificationsEnabled) {
        return;
    }

    const recipients = getFeedbackNotificationRecipients();
    if (!recipients.length) {
        return;
    }

    const feedbackTypeLabel = toFeedbackTypeLabel(feedbackType);

    if (env.feedbackInAppNotificationsEnabled) {
        const notificationTitle = 'New Feedback Submitted';
        const moduleSuffix = modulePath ? ` (${modulePath})` : '';
        const notificationMessage = `${submittedByName} submitted ${feedbackTypeLabel} feedback #${submissionId}: ${title}${moduleSuffix}`;

        recipients.forEach((recipient) => {
            db.prepare(`
                INSERT INTO notifications (user_id, title, message, type)
                VALUES (?, ?, ?, ?)
            `).run(recipient.id, notificationTitle, notificationMessage, 'info');
        });
    }

    if (env.feedbackEmailNotificationsEnabled) {
        const emailRecipients = recipients.filter((recipient) => toTrimmedString(recipient.email));
        await Promise.all(emailRecipients.map((recipient) => (
            sendEmail(
                recipient.email,
                feedbackSubmissionEmailTemplate,
                [{
                    recipientName: recipient.name,
                    submissionId,
                    submittedByName,
                    feedbackTypeLabel,
                    title,
                    modulePath,
                }],
                {
                    entityType: 'feedback',
                    entityId: String(submissionId),
                    templateName: 'feedbackSubmissionAlert',
                }
            )
        )));
    }
};

const resolveAssignedToValue = (existingAssignedTo, hasAssignedTo, assignedToRaw) => {
    if (!hasAssignedTo) {
        return { value: existingAssignedTo || null };
    }

    const parsedAssignedTo = parseOptionalInt(assignedToRaw);
    if (parsedAssignedTo === null) {
        return { value: null };
    }

    const userExists = db.prepare('SELECT id FROM users WHERE id = ?').get(parsedAssignedTo);
    if (!userExists) {
        return { error: 'Assigned user not found' };
    }

    return { value: parsedAssignedTo };
};

const buildFeedbackUpdateValues = (existing, body) => {
    const hasStatus = Object.hasOwn(body, 'status');
    const hasPriority = Object.hasOwn(body, 'priority');
    const hasAssignedTo = Object.hasOwn(body, 'assignedTo');
    const hasAdminNote = Object.hasOwn(body, 'adminNote');

    const nextStatus = hasStatus
        ? normalizeFeedbackStatus(body.status)
        : String(existing.status || 'new');
    if (hasStatus && !nextStatus) {
        return { error: 'Invalid status value' };
    }

    const nextPriority = hasPriority
        ? normalizeFeedbackPriority(body.priority)
        : String(existing.priority || 'medium');
    if (hasPriority && !nextPriority) {
        return { error: 'Invalid priority value' };
    }

    const assignedToResult = resolveAssignedToValue(existing.assigned_to, hasAssignedTo, body.assignedTo);
    if (assignedToResult.error) {
        return { error: assignedToResult.error };
    }
    const nextAssignedTo = assignedToResult.value;

    const nextAdminNote = hasAdminNote
        ? toTrimmedString(body.adminNote)
        : toTrimmedString(existing.admin_note);

    const resolvedStatuses = new Set(['resolved', 'closed']);
    let resolvedAt = existing.resolved_at || null;
    if (resolvedStatuses.has(nextStatus)) {
        resolvedAt = resolvedAt || new Date().toISOString();
    } else {
        resolvedAt = null;
    }

    return {
        values: {
            nextStatus,
            nextPriority,
            nextAssignedTo,
            nextAdminNote,
            resolvedAt,
        },
    };
};

router.post('/', authenticateToken, (req, res) => {
    try {
        const {
            feedbackType,
            rating,
            title,
            description,
            modulePath,
            stepsToReproduce,
            expectedResult,
            actualResult,
            attachmentPath,
            contactAllowed,
        } = req.body || {};

        const normalizedType = normalizeFeedbackType(feedbackType);
        if (!normalizedType) {
            return res.status(400).json({ error: 'Valid feedbackType is required' });
        }

        const normalizedDescription = toTrimmedString(description);
        if (!normalizedDescription) {
            return res.status(400).json({ error: 'Description is required' });
        }

        const normalizedTitleInput = toTrimmedString(title);
        if (normalizedTitleInput.length > 150) {
            return res.status(400).json({ error: 'Title must be 150 characters or less' });
        }

        const normalizedTitle = normalizedTitleInput || buildFeedbackFallbackTitle({
            feedbackType: normalizedType,
            description: normalizedDescription,
        });

        const submittedByEmail = toTrimmedString(req.user?.email);
        if (!env.allowDemoFeedback && isDemoFeedbackSubmission({
            title: normalizedTitle,
            description: normalizedDescription,
            submitterEmail: submittedByEmail,
        })) {
            return res.status(400).json({ error: 'Demo/test feedback submissions are blocked.' });
        }

        const parsedRating = parseOptionalInt(rating);
        if (parsedRating !== null && (parsedRating < 1 || parsedRating > 5)) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5' });
        }

        const contactAllowedInt = parseBooleanInt(contactAllowed, 0);

        const result = db.prepare(`
            INSERT INTO feedback_submissions (
                user_id,
                feedback_type,
                rating,
                title,
                description,
                module_path,
                steps_to_reproduce,
                expected_result,
                actual_result,
                attachment_path,
                contact_allowed,
                status,
                priority,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'medium', datetime('now'), datetime('now'))
        `).run(
            req.user.id,
            normalizedType,
            parsedRating,
            normalizedTitle,
            normalizedDescription,
            toTrimmedString(modulePath),
            toTrimmedString(stepsToReproduce),
            toTrimmedString(expectedResult),
            toTrimmedString(actualResult),
            toTrimmedString(attachmentPath),
            contactAllowedInt,
        );

        const submissionId = Number(result.lastInsertRowid);
        const trimmedModulePath = toTrimmedString(modulePath);
        const submittedByName = toTrimmedString(req.user?.name) || 'A user';

        triggerFeedbackSubmissionNotifications({
            submissionId,
            submittedByName,
            feedbackType: normalizedType,
            title: normalizedTitle,
            modulePath: trimmedModulePath,
        }).catch((notificationError) => {
            console.error('Feedback notification hook failed:', notificationError);
        });

        return res.status(201).json({
            message: 'Feedback submitted successfully',
            id: submissionId,
        });
    } catch (error) {
        console.error('Error submitting feedback:', error);
        return res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

router.get('/mine', authenticateToken, (req, res) => {
    try {
        const limit = parseListLimit(req.query.limit, 50, 200);
        const rows = db.prepare(`
            SELECT
                id,
                feedback_type,
                rating,
                title,
                description,
                module_path,
                status,
                priority,
                admin_note,
                created_at,
                updated_at,
                resolved_at
            FROM feedback_submissions
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT ?
        `).all(req.user.id, limit);

        return res.json(rows || []);
    } catch (error) {
        console.error('Error fetching user feedback:', error);
        return res.status(500).json({ error: 'Failed to fetch feedback' });
    }
});

router.get('/', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const whereClauses = [];
        const whereParams = [];

        const status = normalizeFeedbackStatus(req.query.status);
        if (status) {
            whereClauses.push('fs.status = ?');
            whereParams.push(status);
        }

        const type = normalizeFeedbackType(req.query.type);
        if (type) {
            whereClauses.push('fs.feedback_type = ?');
            whereParams.push(type);
        }

        const search = toTrimmedString(req.query.search).toLowerCase();
        if (search) {
            whereClauses.push(`(
                LOWER(COALESCE(fs.title, '')) LIKE ?
                OR LOWER(COALESCE(fs.description, '')) LIKE ?
                OR LOWER(COALESCE(fs.module_path, '')) LIKE ?
                OR LOWER(COALESCE(u.name, '')) LIKE ?
                OR LOWER(COALESCE(u.email, '')) LIKE ?
            )`);
            const wildcard = `%${search}%`;
            whereParams.push(wildcard, wildcard, wildcard, wildcard, wildcard);
        }

        const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

        const limit = parseListLimit(req.query.limit, 100, 500);
        const pageRaw = Number.parseInt(String(req.query.page || '1'), 10);
        const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
        const offset = (page - 1) * limit;

        const totalRow = db.prepare(`
            SELECT COUNT(*) AS total
            FROM feedback_submissions fs
            LEFT JOIN users u ON u.id = fs.user_id
            ${whereSQL}
        `).get(...whereParams);

        const rows = db.prepare(`
            SELECT
                fs.id,
                fs.user_id,
                fs.feedback_type,
                fs.rating,
                fs.title,
                fs.description,
                fs.module_path,
                fs.steps_to_reproduce,
                fs.expected_result,
                fs.actual_result,
                fs.attachment_path,
                fs.contact_allowed,
                fs.status,
                fs.priority,
                fs.assigned_to,
                fs.admin_note,
                fs.created_at,
                fs.updated_at,
                fs.resolved_at,
                u.name AS submitted_by_name,
                u.email AS submitted_by_email,
                au.name AS assigned_to_name
            FROM feedback_submissions fs
            LEFT JOIN users u ON u.id = fs.user_id
            LEFT JOIN users au ON au.id = fs.assigned_to
            ${whereSQL}
            ORDER BY fs.id DESC
            LIMIT ? OFFSET ?
        `).all(...whereParams, limit, offset);

        return res.json({
            rows: rows || [],
            page,
            limit,
            total: totalRow?.total || 0,
            totalPages: Math.ceil((totalRow?.total || 0) / limit),
        });
    } catch (error) {
        console.error('Error fetching feedback list:', error);
        return res.status(500).json({ error: 'Failed to fetch feedback list' });
    }
});

router.patch('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const feedbackId = parseOptionalInt(req.params.id);
        const body = req.body || {};
        if (!feedbackId) {
            return res.status(400).json({ error: 'Valid feedback id is required' });
        }

        const existing = db.prepare('SELECT * FROM feedback_submissions WHERE id = ?').get(feedbackId);
        if (!existing) {
            return res.status(404).json({ error: 'Feedback not found' });
        }

        const updatePayload = buildFeedbackUpdateValues(existing, body);
        if (updatePayload.error) {
            return res.status(400).json({ error: updatePayload.error });
        }

        const {
            nextStatus,
            nextPriority,
            nextAssignedTo,
            nextAdminNote,
            resolvedAt,
        } = updatePayload.values;

        db.prepare(`
            UPDATE feedback_submissions
            SET
                status = ?,
                priority = ?,
                assigned_to = ?,
                admin_note = ?,
                resolved_at = ?,
                updated_at = datetime('now')
            WHERE id = ?
        `).run(
            nextStatus,
            nextPriority,
            nextAssignedTo,
            nextAdminNote,
            resolvedAt,
            feedbackId,
        );

        return res.json({ message: 'Feedback updated successfully' });
    } catch (error) {
        console.error('Error updating feedback:', error);
        return res.status(500).json({ error: 'Failed to update feedback' });
    }
});

export default router;
