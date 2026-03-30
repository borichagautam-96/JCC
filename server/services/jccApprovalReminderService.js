import db from '../database.js';
import { notifyJccApprovalReminder } from '../utils/emailService.js';

const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REMINDER_GRACE_HOURS = 24;

const getPendingVoucherCandidates = () => {
  return db.prepare(`
    SELECT
      v.id,
      v.user_id,
      v.claimed_by,
      v.department,
      v.supplier,
      v.expense_booking_location,
      v.invoice_number,
      v.invoice_date,
      v.basic_amount,
      v.gross_amount,
      v.nature_of_expenses,
      v.po_number,
      v.approver1_name,
      v.approver2_name,
      v.current_approval_level,
      v.status,
      v.created_at,
      u.ps_number AS creator_ps_number
    FROM voucher_requests v
    LEFT JOIN users u ON u.id = v.user_id
    WHERE v.status IN ('pending_approval_1', 'pending_approval_2')
      AND v.current_approval_level IN (1, 2)
      AND datetime(v.created_at) <= datetime('now', '-' || ? || ' hours')
    ORDER BY datetime(v.created_at) ASC
  `).all(REMINDER_GRACE_HOURS);
};

const getUserByName = (name) => {
  if (!name) return null;
  return db.prepare(`
    SELECT id, name, email, role
    FROM users
    WHERE name = ?
    LIMIT 1
  `).get(name);
};

const reminderAlreadySentToday = (voucherId, approvalLevel, reminderDate) => {
  const row = db.prepare(`
    SELECT id
    FROM jcc_approval_reminder_logs
    WHERE voucher_id = ? AND approval_level = ? AND reminder_date = ?
  `).get(voucherId, approvalLevel, reminderDate);
  return Boolean(row);
};

const insertReminderLog = (voucherId, approvalLevel, reminderDate, recipientsCsv) => {
  db.prepare(`
    INSERT INTO jcc_approval_reminder_logs (voucher_id, approval_level, reminder_date, recipients)
    VALUES (?, ?, ?, ?)
  `).run(voucherId, approvalLevel, reminderDate, recipientsCsv || null);
};

const toVoucherPayload = (voucher) => ({
  voucherRequestId: `JCC${String(voucher.id).padStart(4, '0')}`,
  claimedBy: voucher.claimed_by,
  department: voucher.department,
  supplier: voucher.supplier,
  expenseBookingLocation: voucher.expense_booking_location,
  invoiceNumber: voucher.invoice_number,
  invoiceDate: voucher.invoice_date,
  basicAmount: voucher.basic_amount,
  grossAmount: voucher.gross_amount,
  natureOfExpenses: voucher.nature_of_expenses,
  poNumber: voucher.po_number,
  creatorPsNumber: voucher.creator_ps_number,
  approver1Name: voucher.approver1_name,
  approver2Name: voucher.approver2_name,
});

const resolveRecipientsByRule = (voucher) => {
  const manager = getUserByName(voucher.approver1_name);
  const finalApprover = getUserByName(voucher.approver2_name);

  if (Number(voucher.current_approval_level) === 1) {
    return {
      levelLabel: 'Manager',
      recipients: manager?.email ? [manager] : [],
    };
  }

  if (Number(voucher.current_approval_level) === 2) {
    const recipients = [manager, finalApprover].filter((user) => user?.email);
    return {
      levelLabel: 'Final',
      recipients,
    };
  }

  return {
    levelLabel: 'Approver',
    recipients: [],
  };
};

export const runJccApprovalReminderJob = async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const vouchers = getPendingVoucherCandidates();

    if (!vouchers.length) {
      return { scanned: 0, emailed: 0 };
    }

    let emailedCount = 0;

    for (const voucher of vouchers) {
      const approvalLevel = Number(voucher.current_approval_level) === 2 ? 'level_2' : 'level_1';

      if (reminderAlreadySentToday(voucher.id, approvalLevel, today)) {
        continue;
      }

      const { levelLabel, recipients } = resolveRecipientsByRule(voucher);

      if (!recipients.length) {
        continue;
      }

      const payload = toVoucherPayload(voucher);
      const results = await notifyJccApprovalReminder(payload, recipients, levelLabel);
      const successfulRecipients = recipients.filter((_, index) => results[index]?.success);

      if (!successfulRecipients.length) {
        continue;
      }

      insertReminderLog(
        voucher.id,
        approvalLevel,
        today,
        successfulRecipients.map((user) => `${user.name || '-'}<${user.email}>`).join(', ')
      );

      emailedCount += successfulRecipients.length;
    }

    return { scanned: vouchers.length, emailed: emailedCount };
  } catch (error) {
    console.error('JCC approval reminder scheduler error:', error);
    return { scanned: 0, emailed: 0, error: error.message };
  }
};

export const startJccApprovalReminderScheduler = () => {
  runJccApprovalReminderJob();
  const interval = setInterval(() => {
    runJccApprovalReminderJob();
  }, REMINDER_INTERVAL_MS);

  return interval;
};
