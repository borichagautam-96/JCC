import db from '../database.js';
import { sendEmail } from '../utils/emailService.js';
import { getIntSetting, getRoleListSetting } from '../utils/appSettings.js';

const createReminderPayload = (assignment) => ({
  title: assignment.is_overdue ? 'Asset Return Overdue' : 'Asset Return Reminder',
  message: assignment.is_overdue
    ? `Asset ${assignment.asset_uid} (${assignment.asset_name}) is overdue since ${assignment.expected_return_date}.`
    : `Asset ${assignment.asset_uid} (${assignment.asset_name}) is due on ${assignment.expected_return_date}.`,
  type: assignment.is_overdue ? 'error' : 'warning',
  reminderType: assignment.is_overdue ? 'overdue' : 'due_soon',
});

const getReminderCandidates = () => {
  const advanceDays = Math.max(0, getIntSetting('return_reminder_advance_days', 2));
  return db.prepare(`
    SELECT
      aa.id AS assignment_id,
      aa.asset_id,
      aa.assigned_to_name,
      aa.expected_return_date,
      aa.start_date,
      aa.status,
      aa.return_request_status,
      a.asset_uid,
      a.asset_name,
      a.vendor_name,
      CASE WHEN date(aa.expected_return_date) < date('now') THEN 1 ELSE 0 END AS is_overdue
    FROM asset_assignments aa
    JOIN assets a ON a.id = aa.asset_id
    WHERE aa.status = 'open'
      AND aa.expected_return_date IS NOT NULL
      AND date(aa.expected_return_date) <= date('now', '+' || ? || ' day')
      AND COALESCE(aa.return_request_status, 'none') NOT IN ('approved')
    ORDER BY date(aa.expected_return_date) ASC
  `).all(advanceDays);
};

const getRecipientsByRoles = (roles = []) => {
  if (!roles.length) return [];
  const placeholders = roles.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, name, email, role
    FROM users
    WHERE role IN (${placeholders})
  `).all(...roles);
};

export const runReturnReminderJob = async () => {
  try {
    const candidates = getReminderCandidates();
    if (!candidates.length) return { scanned: 0, notified: 0 };

    const emailRoles = getRoleListSetting('reminder_email_roles', ['admin', 'manager', 'coordinator', 'final_approver']);
    const notificationRoles = getRoleListSetting('reminder_notification_roles', ['admin', 'manager', 'coordinator', 'final_approver']);
    const notificationRecipients = getRecipientsByRoles(notificationRoles);
    const emailRecipients = getRecipientsByRoles(emailRoles).filter((user) => user.email && user.email.includes('@'));

    if (!notificationRecipients.length && !emailRecipients.length) {
      return { scanned: candidates.length, notified: 0 };
    }

    let notifiedCount = 0;
    const today = new Date().toISOString().slice(0, 10);

    for (const assignment of candidates) {
      const reminder = createReminderPayload(assignment);

      const existing = db.prepare(`
        SELECT id FROM asset_return_reminder_logs
        WHERE assignment_id = ? AND reminder_type = ? AND reminder_date = ?
      `).get(assignment.assignment_id, reminder.reminderType, today);

      if (existing) continue;

      db.prepare(`
        INSERT INTO asset_return_reminder_logs (assignment_id, reminder_type, reminder_date)
        VALUES (?, ?, ?)
      `).run(assignment.assignment_id, reminder.reminderType, today);

      notificationRecipients.forEach((recipient) => {
        db.prepare(`
          INSERT INTO notifications (user_id, title, message, type)
          VALUES (?, ?, ?, ?)
        `).run(recipient.id, reminder.title, reminder.message, reminder.type);
      });

      const emailSubjectPrefix = assignment.is_overdue ? '[Overdue]' : '[Reminder]';
      const emailBody = `
        <p>Hello Team,</p>
        <p>${reminder.message}</p>
        <p><strong>Vendor:</strong> ${assignment.vendor_name || '-'}</p>
        <p><strong>Assigned To:</strong> ${assignment.assigned_to_name || '-'}</p>
        <p><strong>Taken Date:</strong> ${assignment.start_date || '-'}</p>
        <p><strong>Expected Return:</strong> ${assignment.expected_return_date || '-'}</p>
      `;

      for (const target of emailRecipients) {
        try {
          await sendEmail(
            target.email,
            () => ({
              subject: `${emailSubjectPrefix} Asset ${assignment.asset_uid} return ${assignment.is_overdue ? 'overdue' : 'due soon'}`,
              html: emailBody,
            }),
            []
          );
        } catch (emailError) {
          console.error('Return reminder email error:', emailError);
        }
      }

      notifiedCount += notificationRecipients.length;
    }

    return { scanned: candidates.length, notified: notifiedCount };
  } catch (error) {
    console.error('Return reminder scheduler error:', error);
    return { scanned: 0, notified: 0, error: error.message };
  }
};

export const startReturnReminderScheduler = () => {
  runReturnReminderJob();
  const interval = setInterval(() => {
    runReturnReminderJob();
  }, 30 * 60 * 1000);

  return interval;
};
