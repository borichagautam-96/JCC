import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { generateJCCPDF } from '../utils/pdfGenerator.js';
import { notifyVoucherCreated, notifyVoucherApproved, notifyNextApprover, notifyVoucherRejected, sendEmail } from '../utils/emailService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


import { extractInvoiceData } from '../utils/ocrProcessor.js';

const router = express.Router();

const PAYMENT_STATUS_META = {
  awaiting_approval: 'Awaiting Approval',
  pending_payment: 'Pending Payment',
  submitted_to_vendor: 'Submitted To Vendor',
  payment_initiated: 'Payment Initiated',
  debited: 'Amount Debited',
  settled: 'Settled',
  failed: 'Failed',
  reversed: 'Reversed',
};

const PAYMENT_TRANSITIONS = {
  awaiting_approval: ['pending_payment'],
  pending_payment: ['submitted_to_vendor', 'payment_initiated', 'failed'],
  submitted_to_vendor: ['payment_initiated', 'failed'],
  payment_initiated: ['debited', 'failed'],
  debited: ['settled', 'reversed'],
  settled: [],
  failed: ['payment_initiated', 'reversed'],
  reversed: ['payment_initiated'],
};

const CLAIM_DATE_LOOKBACK_DAYS = 15;
const INVOICE_DATE_LOOKBACK_DAYS = 15;

const setPaymentTimestamps = (status) => {
  const tsMap = {
    submitted_to_vendor: "payment_submitted_at = COALESCE(payment_submitted_at, datetime('now'))",
    payment_initiated: "payment_initiated_at = COALESCE(payment_initiated_at, datetime('now'))",
    debited: "payment_debited_at = COALESCE(payment_debited_at, datetime('now'))",
    settled: "payment_settled_at = COALESCE(payment_settled_at, datetime('now'))",
    failed: "payment_failed_at = COALESCE(payment_failed_at, datetime('now'))",
    reversed: "payment_reversed_at = COALESCE(payment_reversed_at, datetime('now'))",
  };

  return tsMap[status] || null;
};

const insertPaymentLog = ({ voucherId, oldStatus, newStatus, referenceNo, amount, remarks, actionSource, user }) => {
  db.prepare(`
    INSERT INTO voucher_payment_logs (
      voucher_id, old_status, new_status, reference_no, amount, remarks,
      action_source, action_by_user_id, action_by_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    voucherId,
    oldStatus || null,
    newStatus,
    referenceNo || null,
    amount || null,
    remarks || null,
    actionSource || 'manual',
    user?.id || null,
    user?.name || null
  );
};

const ensureVoucherSuppliersTable = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voucher_suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_name TEXT UNIQUE NOT NULL,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

// Configure multer for voucher attachments
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/vouchers');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'voucher-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images and PDFs are allowed'));
    }
  },
});

const normalizePersonName = (value) => String(value || '').trim();

const findUserByName = (name) => {
  const normalized = normalizePersonName(name);
  if (!normalized) return null;

  return db.prepare(`
    SELECT id, name, email, ps_number
    FROM users
    WHERE lower(trim(name)) = lower(trim(?))
    LIMIT 1
  `).get(normalized) || null;
};

const normalizeDuplicateCsvPair = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return '';

  // Handle duplicated multipart values like "56,56" caused by repeated keys.
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 2 && parts[0] === parts[1]) {
    return parts[0];
  }

  return text;
};

const parseVoucherMaterials = (body) => {
  const normalizeMaterial = (item = {}) => ({
    amount: normalizeDuplicateCsvPair(item.amount ?? item.projectAmount ?? ''),
    projectCode: normalizeDuplicateCsvPair(item.projectCode ?? item.project_code ?? ''),
    projectName: normalizeDuplicateCsvPair(item.projectName ?? item.project_name ?? ''),
  });

  const hasMaterialKeys = (value) => (
    'amount' in value
    || 'projectAmount' in value
    || 'projectCode' in value
    || 'project_code' in value
    || 'projectName' in value
    || 'project_name' in value
  );

  const parseObjectValue = (value, extractFromUnknown) => {
    if (hasMaterialKeys(value)) return [normalizeMaterial(value)];

    // Handle objects with numeric keys: {"0": {...}, "1": {...}}
    const numericKeys = Object.keys(value).filter((key) => /^\d+$/.test(key));
    if (numericKeys.length === 0) return [];

    return numericKeys
      .toSorted((a, b) => Number(a) - Number(b))
      .flatMap((key) => extractFromUnknown(value[key]));
  };

  const parseStringValue = (value, extractFromUnknown) => {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      return extractFromUnknown(JSON.parse(trimmed));
    } catch {
      // Try unwrapping quoted JSON strings once more.
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ) {
        const unwrapped = trimmed.slice(1, -1).replaceAll(String.raw`\"`, '"');
        try {
          return extractFromUnknown(JSON.parse(unwrapped));
        } catch {
          return [];
        }
      }
      return [];
    }
  };

  const extractFromUnknown = (value) => {
    if (value == null) return [];

    if (Array.isArray(value)) {
      return value.flatMap((entry) => extractFromUnknown(entry));
    }

    if (typeof value === 'string') {
      return parseStringValue(value, extractFromUnknown);
    }

    if (typeof value === 'object') {
      return parseObjectValue(value, extractFromUnknown);
    }

    return [];
  };

  const fromMaterialsField = () => extractFromUnknown(body?.materials);
  const fromBracketMaterialsField = () => extractFromUnknown(body?.['materials[]']);
  const fromMaterialsPayloadField = () => extractFromUnknown(body?.materialsPayload);
  const fromMaterialsPayloadB64Field = () => {
    if (typeof body?.materialsPayloadB64 !== 'string' || !body.materialsPayloadB64.trim()) {
      return [];
    }
    try {
      const decoded = Buffer.from(body.materialsPayloadB64, 'base64').toString('utf8');
      return extractFromUnknown(decoded);
    } catch {
      return [];
    }
  };

  const fromIndexedFields = () => {
    const map = new Map();
    const extractIndexAndField = (key) => {
      const patterns = [
        /^materials\[(\d+)\]\[(amount|projectCode|projectName|project_code|project_name)\]$/,
        /^materials\.(\d+)\.(amount|projectCode|projectName|project_code|project_name)$/,
        /^materials\[(\d+)\]\.(amount|projectCode|projectName|project_code|project_name)$/,
        /^(amount|projectCode|projectName|project_code|project_name)_(\d+)$/,
      ];

      for (const pattern of patterns) {
        const match = pattern.exec(key);
        if (!match) continue;

        // Pattern variant where field appears first: amount_0
        if (/^(amount|projectCode|projectName|project_code|project_name)_/.test(key)) {
          return { index: Number(match[2]), field: match[1] };
        }

        return { index: Number(match[1]), field: match[2] };
      }

      return null;
    };

    Object.entries(body || {}).forEach(([key, value]) => {
      const parsed = extractIndexAndField(key);
      if (!parsed) return;

      const { index, field } = parsed;
      if (!map.has(index)) map.set(index, { amount: '', projectCode: '', projectName: '' });
      const target = map.get(index);

      if (field === 'amount') target.amount = value ?? '';
      if (field === 'projectCode' || field === 'project_code') target.projectCode = value ?? '';
      if (field === 'projectName' || field === 'project_name') target.projectName = value ?? '';
    });

    return [...map.entries()]
      .toSorted((a, b) => a[0] - b[0])
      .map(([, material]) => material);
  };

  const fromColumnWiseFields = () => {
    const toList = (value) => {
      if (Array.isArray(value)) return value.map((entry) => String(entry ?? ''));
      if (typeof value === 'string') {
        if (value.includes('\n')) {
          return value
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean);
        }
        return [value];
      }
      if (value == null) return [];
      return [String(value)];
    };

    const amounts = toList(body?.amount);
    const projectCodes = toList(body?.projectCode ?? body?.project_code);
    const projectNames = toList(body?.projectName ?? body?.project_name);

    const maxLen = Math.max(amounts.length, projectCodes.length, projectNames.length);
    if (maxLen === 0) return [];

    const rows = [];
    for (let i = 0; i < maxLen; i += 1) {
      rows.push({
        amount: amounts[i] ?? '',
        projectCode: projectCodes[i] ?? '',
        projectName: projectNames[i] ?? '',
      });
    }
    return rows;
  };

  const payloadCandidates = [
    ...fromMaterialsPayloadField(),
    ...fromMaterialsPayloadB64Field(),
  ];

  // Prefer explicit JSON payloads when present to avoid duplicated multipart keys.
  const fallbackCandidates = payloadCandidates.length > 0
    ? []
    : [
      ...fromMaterialsField(),
      ...fromBracketMaterialsField(),
      ...fromIndexedFields(),
      ...fromColumnWiseFields(),
    ];

  const candidates = [...payloadCandidates, ...fallbackCandidates];

  const uniqueCandidates = [...new Map(
    candidates.map((item) => {
      const normalized = {
        amount: String(item.amount ?? '').trim(),
        projectCode: String(item.projectCode ?? '').trim(),
        projectName: String(item.projectName ?? '').trim(),
      };
      return [JSON.stringify(normalized), normalized];
    })
  ).values()];

  // Keep only rows with at least one meaningful value.
  return uniqueCandidates
    .filter((item) => item.amount || item.projectCode || item.projectName);
};

const SUPPLIER_ACK_TOKEN_VALIDITY_HOURS = 24 * 7;
const SUPPLIER_ACK_ALLOWED_ACTIONS = new Set(['acknowledged', 'rejected']);

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const formatJccId = (voucherId) => `JCC${String(voucherId).padStart(4, '0')}`;

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const resolveAppBaseUrl = (req) => {
  const configuredBaseUrl = String(process.env.APP_BASE_URL || '').trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, '');
  }

  const host = req?.get?.('host');
  if (host) {
    return `${req.protocol || 'http'}://${host}`;
  }

  return '';
};

const hashSupplierToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

const isSupplierTokenExpired = (expiresAt) => {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() <= Date.now();
};

const insertSupplierAckEvent = ({ voucherId, tokenId = null, eventType, eventByEmail = null, remarks = null, metadata = null }) => {
  try {
    db.prepare(`
      INSERT INTO voucher_supplier_ack_events (
        voucher_id, token_id, event_type, event_by_email, remarks, metadata
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      voucherId,
      tokenId,
      eventType,
      eventByEmail,
      remarks,
      metadata ? JSON.stringify(metadata) : null
    );
  } catch (error) {
    console.error('Error writing supplier acknowledgement event:', error);
  }
};

const resolveSupplierRecipient = (supplierName) => {
  const normalizedName = String(supplierName || '').trim();
  if (!normalizedName) return null;

  const exactMatch = db.prepare(`
    SELECT id, vendor_name, mail_id
    FROM vendors
    WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(normalizedName);

  if (exactMatch?.mail_id) {
    return exactMatch;
  }

  const partialMatch = db.prepare(`
    SELECT id, vendor_name, mail_id
    FROM vendors
    WHERE LOWER(vendor_name) LIKE LOWER(?)
    ORDER BY LENGTH(vendor_name) ASC
    LIMIT 1
  `).get(`%${normalizedName}%`);

  if (partialMatch?.mail_id) {
    return partialMatch;
  }

  return null;
};

const createSupplierAckToken = ({ voucherId, recipientEmail, createdBy }) => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSupplierToken(rawToken);
  const expiresAt = new Date(Date.now() + (SUPPLIER_ACK_TOKEN_VALIDITY_HOURS * 60 * 60 * 1000)).toISOString();

  const result = db.prepare(`
    INSERT INTO voucher_supplier_ack_tokens (
      voucher_id, recipient_email, token_hash, expires_at, created_by
    ) VALUES (?, ?, ?, ?, ?)
  `).run(voucherId, recipientEmail, tokenHash, expiresAt, createdBy || null);

  return {
    tokenId: Number(result.lastInsertRowid) || null,
    rawToken,
    expiresAt,
  };
};

const invalidateSupplierAckTokens = ({ voucherId, exceptTokenId = null }) => {
  if (exceptTokenId) {
    db.prepare(`
      UPDATE voucher_supplier_ack_tokens
      SET used_at = datetime('now')
      WHERE voucher_id = ?
        AND used_at IS NULL
        AND id != ?
    `).run(voucherId, exceptTokenId);
    return;
  }

  db.prepare(`
    UPDATE voucher_supplier_ack_tokens
    SET used_at = datetime('now')
    WHERE voucher_id = ?
      AND used_at IS NULL
  `).run(voucherId);
};

const getSupplierTokenContext = (token) => {
  const rawToken = String(token || '').trim();
  if (!/^[a-fA-F0-9]{64}$/.test(rawToken)) {
    return null;
  }

  const tokenHash = hashSupplierToken(rawToken);

  return db.prepare(`
    SELECT
      t.id AS token_id,
      t.voucher_id,
      t.recipient_email,
      t.expires_at,
      t.used_at,
      v.user_id,
      v.supplier,
      v.invoice_number,
      v.basic_amount,
      v.status AS voucher_status,
      v.supplier_ack_status,
      v.supplier_ack_email,
      v.supplier_ack_sent_at,
      v.supplier_ack_expires_at,
      v.supplier_ack_at,
      v.supplier_ack_by_email,
      v.supplier_ack_remarks,
      v.approver1_name,
      v.approver2_name
    FROM voucher_supplier_ack_tokens t
    JOIN voucher_requests v ON v.id = t.voucher_id
    WHERE t.token_hash = ?
    LIMIT 1
  `).get(tokenHash);
};

const sendSupplierDispatchEmail = async ({ recipientEmail, voucher, supplierName, ackUrl, pdfUrl, expiresAt }) => {
  const voucherRef = formatJccId(voucher.id);
  const expiryLabel = new Date(expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  return sendEmail(
    recipientEmail,
    (payload) => ({
      subject: `Action Required: ${payload.voucherRef} JCC PDF Acknowledgement`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #1f2937; line-height: 1.6;">
          <h2 style="margin-bottom: 10px;">JCC PDF Shared for Supplier Acknowledgement</h2>
          <p>Dear ${escapeHtml(payload.supplierName || 'Supplier')},</p>
          <p>Please review the JCC PDF and submit your acknowledgement.</p>
          <table style="border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px;">
            <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>JCC Number</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${escapeHtml(payload.voucherRef)}</td></tr>
            <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Supplier</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${escapeHtml(payload.supplierName || '-')}</td></tr>
            <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Invoice Number</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${escapeHtml(payload.invoiceNumber || '-')}</td></tr>
            <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Amount</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">INR ${escapeHtml(payload.amount || '-')}</td></tr>
          </table>
          <p>
            <a href="${escapeHtml(payload.pdfUrl)}" style="display: inline-block; margin-right: 10px; background: #1d4ed8; color: #fff; text-decoration: none; padding: 10px 14px; border-radius: 6px;">Download JCC PDF</a>
            <a href="${escapeHtml(payload.ackUrl)}" style="display: inline-block; background: #065f46; color: #fff; text-decoration: none; padding: 10px 14px; border-radius: 6px;">Acknowledge JCC</a>
          </p>
          <p style="font-size: 12px; color: #6b7280;">This secure link expires on ${escapeHtml(payload.expiryLabel)} IST.</p>
        </div>
      `,
    }),
    [{
      voucherRef,
      supplierName,
      invoiceNumber: voucher.invoice_number,
      amount: voucher.basic_amount,
      ackUrl,
      pdfUrl,
      expiryLabel,
    }],
    {
      entityType: 'supplier_ack',
      entityId: voucherRef,
      templateName: 'supplierJccDispatch',
    }
  );
};

const sendSupplierAckReceiptEmail = async ({ recipientEmail, voucherId, supplierName, action, remarks }) => {
  const voucherRef = formatJccId(voucherId);
  const actionLabel = action === 'acknowledged' ? 'Acknowledged' : 'Rejected';

  return sendEmail(
    recipientEmail,
    (payload) => ({
      subject: `Confirmation: ${payload.voucherRef} marked as ${payload.actionLabel}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #1f2937; line-height: 1.6;">
          <p>Dear ${escapeHtml(payload.supplierName || 'Supplier')},</p>
          <p>We have recorded your response for <strong>${escapeHtml(payload.voucherRef)}</strong> as <strong>${escapeHtml(payload.actionLabel)}</strong>.</p>
          ${payload.remarks ? `<p><strong>Remarks:</strong> ${escapeHtml(payload.remarks)}</p>` : ''}
          <p>Thank you.</p>
        </div>
      `,
    }),
    [{ voucherRef, supplierName, actionLabel, remarks }],
    {
      entityType: 'supplier_ack',
      entityId: voucherRef,
      templateName: 'supplierAckReceipt',
    }
  );
};

const sendInternalSupplierAckEmails = async ({ voucher, action, remarks, supplierEmail }) => {
  const creator = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(voucher.user_id);
  const approver1 = findUserByName(voucher.approver1_name);
  const approver2 = findUserByName(voucher.approver2_name);

  const recipients = [creator, approver1, approver2]
    .filter((user) => user?.email)
    .filter((user, index, arr) => arr.findIndex((item) => item?.email?.toLowerCase() === user.email.toLowerCase()) === index);

  if (recipients.length === 0) {
    return [];
  }

  const voucherRef = formatJccId(voucher.id);
  const actionLabel = action === 'acknowledged' ? 'Acknowledged' : 'Rejected';

  const results = [];
  for (const recipient of recipients) {
    const result = await sendEmail(
      recipient.email,
      (payload) => ({
        subject: `${payload.voucherRef} supplier response: ${payload.actionLabel}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #1f2937; line-height: 1.6;">
            <p>Dear ${escapeHtml(payload.recipientName || 'Team')},</p>
            <p>Supplier response has been captured for <strong>${escapeHtml(payload.voucherRef)}</strong>.</p>
            <table style="border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px;">
              <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Action</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${escapeHtml(payload.actionLabel)}</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Supplier</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${escapeHtml(payload.supplierName || '-')}</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Supplier Email</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${escapeHtml(payload.supplierEmail || '-')}</td></tr>
              ${payload.remarks ? `<tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Remarks</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${escapeHtml(payload.remarks)}</td></tr>` : ''}
            </table>
          </div>
        `,
      }),
      [{
        recipientName: recipient.name,
        voucherRef,
        actionLabel,
        supplierName: voucher.supplier,
        supplierEmail,
        remarks,
      }],
      {
        entityType: 'supplier_ack',
        entityId: voucherRef,
        templateName: 'supplierAckInternalNotice',
      }
    );

    results.push(result);
  }

  return results;
};

const dispatchVoucherToSupplier = async ({ voucherId, actorUser, req }) => {
  const voucher = db.prepare(`
    SELECT id, user_id, supplier, invoice_number, basic_amount, status, approver1_name, approver2_name
    FROM voucher_requests
    WHERE id = ?
  `).get(voucherId);

  if (!voucher) {
    throw createHttpError(404, 'Voucher not found');
  }

  if (voucher.status !== 'approved') {
    throw createHttpError(400, 'Only approved vouchers can be sent to supplier');
  }

  const supplierRecord = resolveSupplierRecipient(voucher.supplier);
  const recipientEmail = String(supplierRecord?.mail_id || '').trim();
  if (!recipientEmail) {
    throw createHttpError(400, `Supplier email not found for "${voucher.supplier || 'Unknown Supplier'}" in Vendor Management`);
  }

  const baseUrl = resolveAppBaseUrl(req);
  if (!baseUrl) {
    throw createHttpError(500, 'APP_BASE_URL is missing. Configure APP_BASE_URL before sending supplier links.');
  }

  const { tokenId, rawToken, expiresAt } = createSupplierAckToken({
    voucherId: voucher.id,
    recipientEmail,
    createdBy: actorUser?.id,
  });

  const ackUrl = `${baseUrl}/api/jcc/supplier/ack/${rawToken}`;
  const pdfUrl = `${baseUrl}/api/jcc/supplier/ack/${rawToken}/pdf`;

  const emailResult = await sendSupplierDispatchEmail({
    recipientEmail,
    voucher,
    supplierName: voucher.supplier,
    ackUrl,
    pdfUrl,
    expiresAt,
  });

  if (!emailResult?.success) {
    db.prepare('DELETE FROM voucher_supplier_ack_tokens WHERE id = ?').run(tokenId);
    throw createHttpError(502, emailResult?.error || emailResult?.message || 'Failed to send supplier email');
  }

  invalidateSupplierAckTokens({
    voucherId: voucher.id,
    exceptTokenId: tokenId,
  });

  db.prepare(`
    UPDATE voucher_requests
    SET supplier_ack_status = 'pending',
        supplier_ack_email = ?,
        supplier_ack_sent_at = datetime('now'),
        supplier_ack_expires_at = ?,
        supplier_ack_at = NULL,
        supplier_ack_by_email = NULL,
        supplier_ack_remarks = NULL
    WHERE id = ?
  `).run(recipientEmail, expiresAt, voucher.id);

  insertSupplierAckEvent({
    voucherId: voucher.id,
    tokenId,
    eventType: 'email_sent',
    eventByEmail: recipientEmail,
    metadata: {
      sentBy: actorUser?.name || null,
      sentByUserId: actorUser?.id || null,
      ackUrl,
      pdfUrl,
      expiresAt,
    },
  });

  return {
    voucher,
    recipientEmail,
    ackUrl,
    pdfUrl,
    expiresAt,
  };
};

const createVoucherPdfArtifact = async (voucherId) => {
  const voucher = db.prepare(`
    SELECT v.*, u.name AS user_name, u.ps_number AS creator_ps_number
    FROM voucher_requests v
    JOIN users u ON v.user_id = u.id
    WHERE v.id = ?
  `).get(voucherId);

  if (!voucher) {
    throw createHttpError(404, 'Voucher not found');
  }

  if (voucher.status !== 'approved') {
    throw createHttpError(403, 'Voucher must be fully approved to download JCC PDF');
  }

  const getPSNumberFromName = (name) => {
    if (!name) return '-';
    const foundUser = findUserByName(name);
    return foundUser?.ps_number || '-';
  };

  const resolvePersonName = (identifier, fallback = '-') => {
    const userRecord = findUserByName(identifier);
    if (userRecord?.name) {
      return userRecord.name;
    }
    const fallbackText = String(fallback || '').trim();
    return fallbackText || '-';
  };

  const creatorFromUserManagement = db.prepare('SELECT name, ps_number FROM users WHERE id = ?').get(voucher.user_id);

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
  };

  let supplierCode = '';
  let supplierAddress = '';
  let poDate = '';
  let poAmount = '';
  if (voucher.po_number) {
    const linkedPO = db.prepare(`
      SELECT supplier_code, supplier_address, po_date, total_budget
      FROM purchase_orders
      WHERE po_number = ?
    `).get(voucher.po_number);

    if (linkedPO) {
      supplierCode = linkedPO.supplier_code || '';
      supplierAddress = linkedPO.supplier_address || '';
      poDate = linkedPO.po_date || '';
      poAmount = linkedPO.total_budget || '';
    }
  }

  const deptCode = (() => {
    const dept = (voucher.department || '').toUpperCase();
    if (dept.includes('DOCUMENTATION') || dept.includes('TRAINING')) return '3559';
    return '';
  })();

  const materialsQuery = db.prepare(`
    SELECT amount, project_code, project_name
    FROM voucher_materials
    WHERE voucher_id = ?
    ORDER BY id ASC
  `).all(voucher.id);

  const normalizedMaterials = [...new Map(
    materialsQuery.map((row) => {
      const normalized = {
        amount: normalizeDuplicateCsvPair(row.amount),
        project_code: normalizeDuplicateCsvPair(row.project_code),
        project_name: normalizeDuplicateCsvPair(row.project_name),
      };
      return [JSON.stringify(normalized), normalized];
    })
  ).values()].filter((row) => row.amount || row.project_code || row.project_name);

  const isMaterialsEmpty = normalizedMaterials.length === 0;

  const pdfItems = isMaterialsEmpty ? [{
    loc: voucher.expense_booking_location || 'PEW',
    dept: (() => {
      const dept = (voucher.department || '').toUpperCase();
      if (dept.includes('DOCUMENTATION') || dept.includes('TRAINING')) return 'DOC & TRNG';
      return voucher.department;
    })(),
    dept_code: deptCode,
    project: voucher.project_name || '',
    project_code: voucher.project_code || '',
    amount: voucher.basic_amount,
  }] : normalizedMaterials.map((material) => ({
    loc: voucher.expense_booking_location || 'PEW',
    dept: (() => {
      const dept = (voucher.department || '').toUpperCase();
      if (dept.includes('DOCUMENTATION') || dept.includes('TRAINING')) return 'DOC & TRNG';
      return voucher.department;
    })(),
    dept_code: deptCode,
    project: material.project_name || '',
    project_code: material.project_code || '',
    amount: material.amount,
  }));

  const pdfData = {
    id: voucher.id,
    voucher_number: formatJccId(voucher.id),
    claimed_by: voucher.claimed_by,
    ps_number: voucher.creator_ps_number || '-',
    department: (() => {
      const dept = (voucher.department || '').toUpperCase();
      if (dept.includes('DOCUMENTATION') || dept.includes('TRAINING')) return 'DOCUMENTATION & TRAINING';
      return voucher.department;
    })(),
    claimed_date: voucher.claimed_date,
    expense_booking_location: voucher.expense_booking_location,
    actions: [
      {
        action_by: 'INITIATOR',
        person: resolvePersonName(voucher.user_name || creatorFromUserManagement?.name, creatorFromUserManagement?.name || voucher.user_name || '-'),
        psno: creatorFromUserManagement?.ps_number || voucher.creator_ps_number || '-',
        action: 'Voucher Initiated',
        date: formatDate(voucher.claimed_date),
      },
      {
        action_by: 'FIRST APPROVER',
        person: resolvePersonName(voucher.approver1_name, voucher.approver1_name || '-'),
        psno: getPSNumberFromName(voucher.approver1_name),
        action: voucher.approver1_status === 'approved' ? 'Approved' : (voucher.approver1_status || '-'),
        date: voucher.approver1_date ? formatDate(voucher.approver1_date) : '-',
      },
      {
        action_by: 'SECOND APPROVER',
        person: resolvePersonName(voucher.approver2_name, voucher.approver2_name || '-'),
        psno: getPSNumberFromName(voucher.approver2_name),
        action: voucher.approver2_status === 'approved' ? 'Approved' : (voucher.approver2_status || '-'),
        date: voucher.approver2_date ? formatDate(voucher.approver2_date) : '-',
      },
    ],
    invoice_no: voucher.invoice_number,
    invoice_date: voucher.invoice_date,
    nature_of_expenses: voucher.nature_of_expenses,
    service_category: '',
    description: voucher.description,
    supplier_name: voucher.supplier,
    supplier_code: supplierCode,
    supplier_address: supplierAddress,
    po_number: voucher.po_number || '',
    po_date: poDate,
    po_amount: poAmount,
    dept_code: deptCode,
    basic_amount: voucher.basic_amount,
    gross_amount: voucher.gross_amount,
    project_code: voucher.project_code,
    project_name: voucher.project_name,
    items: pdfItems,
  };

  const jccId = formatJccId(voucher.id);
  const downloadFilename = `${jccId}.pdf`;
  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const pdfPath = path.join(tempDir, `${jccId}-${uniqueSuffix}.pdf`);

  await generateJCCPDF(pdfData, pdfPath);

  if (!fs.existsSync(pdfPath)) {
    throw createHttpError(500, 'Failed to generate PDF file');
  }

  return { pdfPath, downloadFilename };
};

const sendVoucherPdfDownload = async (res, voucherId) => {
  const { pdfPath, downloadFilename } = await createVoucherPdfArtifact(voucherId);

  res.download(pdfPath, downloadFilename, (downloadError) => {
    if (downloadError) {
      console.error('Error sending PDF:', downloadError);
    }

    try {
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }
    } catch (cleanupError) {
      console.error('Error deleting temp PDF:', cleanupError);
    }
  });
};

const renderSupplierAckPage = ({ title, message, token, voucherContext = null, showForm = false, isError = false }) => {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeSupplier = escapeHtml(voucherContext?.supplier || '-');
  const safeInvoice = escapeHtml(voucherContext?.invoice_number || '-');
  const safeAmount = escapeHtml(voucherContext?.basic_amount ?? '-');
  const safeJccId = escapeHtml(formatJccId(voucherContext?.voucher_id || voucherContext?.id || 0));
  const safePdfUrl = token ? `/api/jcc/supplier/ack/${encodeURIComponent(token)}/pdf` : '#';

  const statusBoxStyle = isError
    ? 'background:#FEF2F2;border:1px solid #FCA5A5;color:#7F1D1D;'
    : 'background:#ECFDF5;border:1px solid #6EE7B7;color:#064E3B;';

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${safeTitle}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
          .wrap { max-width: 760px; margin: 36px auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; }
          h1 { margin: 0 0 10px 0; font-size: 24px; }
          .status { padding: 12px; border-radius: 8px; margin: 14px 0 20px 0; ${statusBoxStyle} }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          td { border: 1px solid #e2e8f0; padding: 8px 10px; font-size: 14px; }
          td:first-child { width: 220px; font-weight: 600; background: #f8fafc; }
          .actions { margin-top: 18px; display: flex; gap: 10px; flex-wrap: wrap; }
          .btn { display: inline-block; border: 0; border-radius: 8px; padding: 10px 14px; font-weight: 600; text-decoration: none; cursor: pointer; }
          .btn-primary { background: #2563eb; color: #fff; }
          .btn-success { background: #047857; color: #fff; }
          .btn-danger { background: #b91c1c; color: #fff; }
          textarea { width: 100%; min-height: 88px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; resize: vertical; }
          .hint { font-size: 12px; color: #64748b; margin-top: 6px; }
        </style>
      </head>
      <body>
        <div class="wrap">
          <h1>${safeTitle}</h1>
          <div class="status">${safeMessage}</div>
          ${voucherContext ? `
            <table>
              <tr><td>JCC Number</td><td>${safeJccId}</td></tr>
              <tr><td>Supplier</td><td>${safeSupplier}</td></tr>
              <tr><td>Invoice Number</td><td>${safeInvoice}</td></tr>
              <tr><td>Amount (INR)</td><td>${safeAmount}</td></tr>
            </table>
            <div class="actions">
              <a class="btn btn-primary" href="${safePdfUrl}">Download JCC PDF</a>
            </div>
          ` : ''}
          ${showForm ? `
            <form method="post" style="margin-top: 22px;">
              <label for="remarks" style="display:block;font-weight:600;margin-bottom:6px;">Remarks (optional)</label>
              <textarea id="remarks" name="remarks" maxlength="1000" placeholder="Add remarks if needed"></textarea>
              <div class="hint">Selecting Reject will mark this JCC as rejected by supplier.</div>
              <div class="actions">
                <button type="submit" name="action" value="acknowledged" class="btn btn-success">Acknowledge JCC</button>
                <button type="submit" name="action" value="rejected" class="btn btn-danger">Reject JCC</button>
              </div>
            </form>
          ` : ''}
        </div>
      </body>
    </html>
  `;
};

// Get list of final approvers
router.get('/final-approvers', authenticateToken, (req, res) => {
  try {
    const approvers = db.prepare(`
      SELECT id, name, email, ps_number
      FROM users
      WHERE role = 'final_approver'
      ORDER BY name ASC
    `).all();

    res.json(approvers);
  } catch (error) {
    console.error('Error fetching final approvers:', error);
    res.status(500).json({ error: 'Failed to fetch final approvers' });
  }
});

// Get supplier list from PO management (distinct vendor names)
router.get('/po-suppliers', authenticateToken, (req, res) => {
  try {
    ensureVoucherSuppliersTable();
    const names = new Set();

    try {
      const poSuppliers = db.prepare(`
        SELECT DISTINCT vendor_name AS supplier_name
        FROM purchase_orders
        WHERE vendor_name IS NOT NULL
          AND TRIM(vendor_name) != ''
      `).all();
      poSuppliers.forEach((row) => names.add(String(row.supplier_name).trim()));
    } catch (poError) {
      console.warn('PO suppliers query failed:', poError.message);
    }

    try {
      const vendorMaster = db.prepare(`
        SELECT DISTINCT vendor_name AS supplier_name
        FROM vendors
        WHERE vendor_name IS NOT NULL
          AND TRIM(vendor_name) != ''
      `).all();
      vendorMaster.forEach((row) => names.add(String(row.supplier_name).trim()));
    } catch (vendorError) {
      console.warn('Vendor master query failed:', vendorError.message);
    }

    try {
      const historical = db.prepare(`
        SELECT DISTINCT supplier AS supplier_name
        FROM voucher_requests
        WHERE supplier IS NOT NULL
          AND TRIM(supplier) != ''
      `).all();
      historical.forEach((row) => names.add(String(row.supplier_name).trim()));
    } catch (voucherError) {
      console.warn('Voucher supplier query failed:', voucherError.message);
    }

    try {
      const customVoucherSuppliers = db.prepare(`
        SELECT DISTINCT supplier_name
        FROM voucher_suppliers
        WHERE supplier_name IS NOT NULL
          AND TRIM(supplier_name) != ''
      `).all();
      customVoucherSuppliers.forEach((row) => names.add(String(row.supplier_name).trim()));
    } catch (customError) {
      console.warn('Voucher custom suppliers query failed:', customError.message);
    }

    const sorted = [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
    res.json(sorted);
  } catch (error) {
    console.error('Error fetching PO suppliers:', error);
    res.status(500).json({ error: 'Failed to fetch suppliers from PO management' });
  }
});

// Admin-only: add supplier to vendor master for voucher supplier dropdown
router.post('/po-suppliers', authenticateToken, authorizeRoles('admin'), (req, res) => {
  try {
    ensureVoucherSuppliersTable();
    const vendorName = String(req.body.vendorName || '').trim();
    if (!vendorName) {
      return res.status(400).json({ error: 'Vendor name is required' });
    }

    const existingInAnySource = db.prepare(`
      SELECT supplier_name AS name FROM voucher_suppliers WHERE LOWER(TRIM(supplier_name)) = LOWER(TRIM(?))
      UNION
      SELECT vendor_name AS name FROM vendors WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))
      UNION
      SELECT vendor_name AS name FROM purchase_orders WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))
      UNION
      SELECT supplier AS name FROM voucher_requests WHERE LOWER(TRIM(supplier)) = LOWER(TRIM(?))
      LIMIT 1
    `).get(vendorName, vendorName, vendorName, vendorName);

    if (existingInAnySource?.name) {
      return res.json({ message: 'Vendor already exists', vendorName: existingInAnySource.name });
    }

    db.prepare(`
      INSERT INTO voucher_suppliers (supplier_name, created_by)
      VALUES (?, ?)
    `).run(vendorName, req.user.id || null);

    res.status(201).json({ message: 'Vendor added successfully', vendorName });
  } catch (error) {
    console.error('Error adding supplier from voucher form:', error);
    res.status(500).json({ error: 'Failed to add supplier' });
  }
});


// Extract data from uploaded invoice
router.post('/extract-invoice', authenticateToken, upload.single('invoice'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No invoice file uploaded' });
    }

    const filePath = req.file.path; // Absolute path from multer
    const fileType = req.file.mimetype;

    console.log(`Processing invoice extraction: ${req.file.originalname} (${fileType})`);

    const result = await extractInvoiceData(filePath, fileType);

    // Return structured data for frontend to pre-fill
    res.json({
      text: result.text,
      lineItems: result.lineItems,
      entities: result.entities,
      confidence: result.confidence
    });

  } catch (error) {
    console.error('Invoice extraction failed:', error);
    res.status(500).json({ error: 'Failed to extract data from invoice' });
  }
});

// Create voucher request with file upload
router.post('/create-voucher', authenticateToken, upload.single('attachment'), (req, res) => {
  try {
    const {
      claimedBy,
      department,
      claimedDate,
      supplier,
      expenseBookingLocation,
      description,
      invoiceNumber,
      invoiceDate,
      basicAmount,
      grossAmount,
      natureOfExpenses,
      poNumber,
      projectCode,
      projectName,
      projectAmount,
      approver1,  // Selected manager from dropdown
      approver2,  // Selected final approver from dropdown
    } = req.body;

    const normalizedClaimedDate = String(claimedDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedClaimedDate)) {
      return res.status(400).json({ error: 'Claim Date is invalid' });
    }

    const claimedDateObj = new Date(`${normalizedClaimedDate}T00:00:00`);
    if (Number.isNaN(claimedDateObj.getTime())) {
      return res.status(400).json({ error: 'Claim Date is invalid' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const minClaimDate = new Date(today);
    minClaimDate.setDate(minClaimDate.getDate() - CLAIM_DATE_LOOKBACK_DAYS);

    if (claimedDateObj < minClaimDate || claimedDateObj > today) {
      return res.status(400).json({ error: `Claim Date must be within the last ${CLAIM_DATE_LOOKBACK_DAYS} days` });
    }

    const normalizedInvoiceDate = String(invoiceDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedInvoiceDate)) {
      return res.status(400).json({ error: 'Invoice Date is invalid' });
    }

    const invoiceDateObj = new Date(`${normalizedInvoiceDate}T00:00:00`);
    if (Number.isNaN(invoiceDateObj.getTime())) {
      return res.status(400).json({ error: 'Invoice Date is invalid' });
    }

    const minInvoiceDate = new Date(today);
    minInvoiceDate.setDate(minInvoiceDate.getDate() - INVOICE_DATE_LOOKBACK_DAYS);

    if (invoiceDateObj < minInvoiceDate || invoiceDateObj > today) {
      return res.status(400).json({ error: `Invoice Date must be within the last ${INVOICE_DATE_LOOKBACK_DAYS} days` });
    }

    const creatorRecord = db.prepare('SELECT id, name, email, ps_number FROM users WHERE id = ?').get(req.user.id);
    const creatorName = creatorRecord?.name || req.user.name || '';
    const creatorEmail = creatorRecord?.email || req.user.email || '';
    const creatorPsNumber = creatorRecord?.ps_number || req.user.ps_number || '';

    // Parse materials and use first entry's project data as fallback
    const materialsArr = parseVoucherMaterials(req.body);
    const materialLikeKeys = Object.keys(req.body || {}).filter((key) =>
      key.toLowerCase().includes('material') || key.toLowerCase().includes('project') || key.toLowerCase().includes('amount')
    );
    if (materialsArr.length === 0 && materialLikeKeys.length > 0) {
      console.warn('[create-voucher] Material fields detected but parsed 0 rows', {
        keys: materialLikeKeys,
        bodyMaterialsType: typeof req.body?.materials,
      });
    }
    const effectiveProjectCode = projectCode || materialsArr[0]?.projectCode || '';
    const effectiveProjectName = projectName || materialsArr[0]?.projectName || '';

    const attachmentPath = req.file ? req.file.filename : null;

    // Validate approver1 was selected
    if (!approver1 || approver1.trim() === '') {
      return res.status(400).json({ error: 'Please select Approver 1 (Manager)' });
    }

    const approver1User = findUserByName(approver1);
    if (!approver1User) {
      return res.status(400).json({ error: 'Selected Approver 1 was not found in User Management' });
    }

    // Validate approver2 was selected
    if (!approver2 || approver2.trim() === '') {
      return res.status(400).json({ error: 'Please select Approver 2 (Final Approver)' });
    }

    // Get Final Approver details
    let finalApproverName = '';
    const finalApproverUser = findUserByName(approver2);
    if (!finalApproverUser) {
      return res.status(400).json({ error: 'Selected Final Approver was not found in User Management' });
    }
    finalApproverName = finalApproverUser.name;

    if (approver1User.id === finalApproverUser.id) {
      return res.status(400).json({ error: 'Approver 1 and Final Approver must be different users' });
    }

    // Only the assignee can create a voucher from an assigned invoice.
    const rawInvoiceId = String(req.body.invoiceId || '').trim();
    const requestedInvoiceId = Number.parseInt(rawInvoiceId, 10);
    let linkedAssignedInvoice = null;

    if (rawInvoiceId && (!Number.isInteger(requestedInvoiceId) || requestedInvoiceId <= 0)) {
      return res.status(400).json({ error: 'Invalid invoice id' });
    }

    if (Number.isInteger(requestedInvoiceId) && requestedInvoiceId > 0) {
      linkedAssignedInvoice = db.prepare(`
        SELECT id
        FROM invoices
        WHERE id = ?
          AND status IN ('assigned', 'pending')
          AND (
            assigned_to_user_id = ?
            OR assigned_to = ?
            OR assigned_to = ?
          )
      `).get(
        requestedInvoiceId,
        req.user.id,
        req.user.ps_number || '',
        req.user.name || ''
      );

      if (!linkedAssignedInvoice) {
        return res.status(403).json({ error: 'You are not allowed to create a voucher for this invoice assignment' });
      }
    }

    if (!linkedAssignedInvoice && invoiceNumber) {
      linkedAssignedInvoice = db.prepare(`
        SELECT id
        FROM invoices
        WHERE invoice_number = ?
          AND status IN ('assigned', 'pending')
          AND (
            assigned_to_user_id = ?
            OR assigned_to = ?
            OR assigned_to = ?
          )
        ORDER BY COALESCE(assigned_at, created_at) DESC
        LIMIT 1
      `).get(
        invoiceNumber,
        req.user.id,
        req.user.ps_number || '',
        req.user.name || ''
      );
    }

    // Insert into voucher_requests table with sequential approval
    const result = db.prepare(`
            INSERT INTO voucher_requests (
                user_id, claimed_by, department, claimed_date,
                supplier, expense_booking_location, description,
                invoice_number, invoice_date, basic_amount, gross_amount,
                nature_of_expenses, po_number, project_code, project_name,
                project_amount, attachment_path,
                approver1_name, approver2_name,
                approver1_status, approver2_status,
                current_approval_level, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval_1')
        `).run(
      req.user.id,
      claimedBy,
      department,
      normalizedClaimedDate,
      supplier,
      expenseBookingLocation,
      description,
      invoiceNumber,
      normalizedInvoiceDate,
      basicAmount,
      grossAmount,
      natureOfExpenses,
      poNumber,
      effectiveProjectCode,
      effectiveProjectName,
      projectAmount,
      attachmentPath,
      approver1User.name,        // Canonical manager name from users table
      finalApproverName,         // Selected final approver
      'pending',                 // approver1_status
      'waiting',                 // approver2_status (waiting for level 1)
      1,                         // current_approval_level
    );

    let voucherId = Number(result.lastInsertRowid) || 0;
    if (!voucherId) {
      const lastInserted = db.exec('SELECT last_insert_rowid() AS id');
      if (lastInserted?.[0]?.values?.[0]?.[0]) {
        voucherId = Number(lastInserted[0].values[0][0]) || 0;
      }
    }
    if (!voucherId) {
      const latestVoucher = db.prepare('SELECT id FROM voucher_requests ORDER BY id DESC LIMIT 1').get();
      voucherId = Number(latestVoucher?.id) || 0;
    }

    // Save individual material lines
    if (materialsArr.length > 0) {
      const stmt = db.prepare(`
        INSERT INTO voucher_materials (voucher_id, amount, project_code, project_name)
        VALUES (?, ?, ?, ?)
      `);
      for (const item of materialsArr) {
        stmt.run(voucherId, item.amount || null, item.projectCode || null, item.projectName || null);
      }
    }

    // If this voucher was created from an assigned invoice, mark that invoice as processed.
    const invoiceIdToUpdate = linkedAssignedInvoice?.id;

    if (invoiceIdToUpdate) {
      db.prepare(`
        UPDATE invoices
        SET status = 'voucher_created',
            accepted_by_user_id = COALESCE(accepted_by_user_id, ?),
            accepted_by_name = COALESCE(accepted_by_name, ?),
            accepted_at = COALESCE(accepted_at, datetime('now')),
            voucher_submitted_at = datetime('now'),
            completed_at = datetime('now')
        WHERE id = ?
      `).run(req.user.id, req.user.name, invoiceIdToUpdate);

      db.prepare(`
        INSERT INTO invoice_assignment_history (
          invoice_id, action_type, action_by_user_id, action_by_name,
          assigned_to_user_id, assigned_to_name, voucher_id, notes
        ) VALUES (?, 'voucher_submitted', ?, ?, ?, ?, ?, ?)
      `).run(
        invoiceIdToUpdate,
        req.user.id,
        req.user.name,
        req.user.id,
        req.user.name,
        voucherId,
        `Voucher JCC${String(voucherId).padStart(4, '0')} submitted`
      );

      db.prepare(`
        INSERT INTO invoice_assignment_history (
          invoice_id, action_type, action_by_user_id, action_by_name,
          assigned_to_user_id, assigned_to_name, voucher_id, notes
        ) VALUES (?, 'voucher_completed', ?, ?, ?, ?, ?, ?)
      `).run(
        invoiceIdToUpdate,
        req.user.id,
        req.user.name,
        req.user.id,
        req.user.name,
        voucherId,
        `Voucher work completed by ${req.user.name}`
      );

      // Create audit log for invoice status change
      db.prepare(`
        INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        req.user.id,
        req.user.name,
        'VOUCHER_CREATED_FROM_INVOICE',
        'invoice',
        invoiceIdToUpdate,
        `JCC voucher JCC${String(voucherId).padStart(4, '0')} created from Invoice #${invoiceIdToUpdate} by ${req.user.name} on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      );
    }

    // Create audit log
    db.prepare(`
            INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
      req.user.id,
      req.user.name,
      'CREATE_VOUCHER',
      'voucher_request',
      voucherId,
      `Created voucher for supplier: ${supplier}, Invoice: ${invoiceNumber}, Amount: ${basicAmount}`
    );

    // Create notification for user (confirmation)
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, ?)
    `).run(
      req.user.id,
      'JCC Voucher Created',
      `Your JCC voucher JCC${String(voucherId).padStart(4, '0')} for ${supplier} (₹${basicAmount}) has been submitted for approval.`,
      'success'
    );

    // Notify all admins/coordinators about new voucher
    const admins = db.prepare(`
      SELECT id FROM users WHERE role IN ('admin', 'coordinator')
    `).all();

    admins.forEach(admin => {
      db.prepare(`
        INSERT INTO notifications (user_id, title, message, type)
        VALUES (?, ?, ?, ?)
      `).run(
        admin.id,
        'New JCC Request',
        `New JCC voucher JCC${String(voucherId).padStart(4, '0')} from ${req.user.name} requires approval.`,
        'info'
      );
    });

    // Send email notifications and in-app notifications to approvers
    try {
      const voucherData = {
        voucherRequestId: `JCC${String(voucherId).padStart(4, '0')}`,
        supplier,
        invoiceNumber,
        invoiceDate,
        department,
        basicAmount,
        grossAmount,
        poNumber,
        claimedBy,
        natureOfExpenses,
        expenseBookingLocation,
        creatorPsNumber: creatorPsNumber,
        approver1Name: approver1User.name,
        approver2Name: finalApproverName
      };

      const creatorData = {
        name: creatorName,
        email: creatorEmail
      };

      // Canonical approver records from users table
      const approver2User = finalApproverUser;

      // Send emails asynchronously — always runs (creator email is independent of approvers)
      notifyVoucherCreated(voucherData, creatorData, approver1User, approver2User)
        .then(results => console.log('[Email] JCC creation notifications sent:', results))
        .catch(err => console.error('[Email] JCC creation notification error:', err));

      // In-app notification for Approver 1 (Manager)
      if (approver1User) {
        db.prepare(`
          INSERT INTO notifications (user_id, title, message, type)
          VALUES (?, ?, ?, ?)
        `).run(
          approver1User.id,
          'New JCC Pending Your Approval',
          `JCC ${voucherData.voucherRequestId} from ${creatorName} (${supplier}, ₹${basicAmount}) requires your Level 1 approval.`,
          'warning'
        );
      }

      // In-app notification for Final Approver (Approver 2)
      if (approver2User && approver2User.id !== approver1User?.id) {
        db.prepare(`
          INSERT INTO notifications (user_id, title, message, type)
        VALUES (?, ?, ?, ?)
        `).run(
          approver2User.id,
          'New JCC — Final Approval Will Be Required',
          `JCC ${voucherData.voucherRequestId} from ${creatorName} (${supplier}, ₹${basicAmount}) will need your final approval after Level 1.`,
          'info'
        );
      }
    } catch (emailError) {
      console.error('Error sending email/notification on JCC creation:', emailError);
      // Don't fail the request if email/notification fails
    }

    res.status(201).json({
      success: true,
      message: 'JCC voucher created successfully',
      voucherId,
    });
  } catch (error) {
    console.error('Error creating voucher:', error);
    res.status(500).json({ error: 'Failed to create voucher request' });
  }
});

// Get voucher attachment file
router.get('/voucher-file/:id', authenticateToken, (req, res) => {
  try {
    const voucher = db.prepare('SELECT attachment_path FROM voucher_requests WHERE id = ?').get(req.params.id);

    if (!voucher || !voucher.attachment_path) {
      return res.status(404).json({ error: 'File not found' });
    }

    const filePath = path.join(__dirname, '../../uploads/vouchers', voucher.attachment_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.sendFile(filePath);
  } catch (error) {
    console.error('Error fetching voucher file:', error);
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

// Download JCC PDF for approved voucher (authenticated users)
router.get(['/download-jcc-pdf/:id', '/voucher/:id/pdf', '/vouchers/:id/pdf'], authenticateToken, async (req, res) => {
  try {
    await sendVoucherPdfDownload(res, req.params.id);
  } catch (error) {
    console.error('Error generating JCC PDF:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Failed to generate JCC PDF' });
  }
});

// Send approved voucher JCC to supplier email for acknowledgement
router.post('/vouchers/:id/send-to-supplier', authenticateToken, authorizeRoles('admin', 'coordinator', 'manager', 'final_approver'), async (req, res) => {
  try {
    const result = await dispatchVoucherToSupplier({
      voucherId: req.params.id,
      actorUser: req.user,
      req,
    });

    return res.json({
      message: `JCC sent to supplier (${result.recipientEmail})`,
      recipientEmail: result.recipientEmail,
      ackUrl: result.ackUrl,
      pdfUrl: result.pdfUrl,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    console.error('Error sending JCC to supplier:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Failed to send JCC to supplier' });
  }
});

// Public supplier acknowledgement landing page
router.get('/supplier/ack/:token', (req, res) => {
  const token = req.params.token;
  const tokenContext = getSupplierTokenContext(token);

  if (!tokenContext) {
    return res.status(404).send(renderSupplierAckPage({
      title: 'Invalid acknowledgement link',
      message: 'This supplier acknowledgement link is invalid. Please request a fresh link.',
      isError: true,
    }));
  }

  if (isSupplierTokenExpired(tokenContext.expires_at)) {
    db.prepare(`
      UPDATE voucher_requests
      SET supplier_ack_status = CASE WHEN supplier_ack_status = 'pending' THEN 'expired' ELSE supplier_ack_status END
      WHERE id = ?
    `).run(tokenContext.voucher_id);

    insertSupplierAckEvent({
      voucherId: tokenContext.voucher_id,
      tokenId: tokenContext.token_id,
      eventType: 'link_expired',
      eventByEmail: tokenContext.recipient_email,
    });

    return res.status(410).send(renderSupplierAckPage({
      title: 'Acknowledgement link expired',
      message: 'This link has expired. Please contact the InFloAI team to receive a fresh acknowledgement email.',
      voucherContext: tokenContext,
      isError: true,
    }));
  }

  const alreadySubmitted = ['acknowledged', 'rejected'].includes(String(tokenContext.supplier_ack_status || '').toLowerCase()) || Boolean(tokenContext.used_at);

  insertSupplierAckEvent({
    voucherId: tokenContext.voucher_id,
    tokenId: tokenContext.token_id,
    eventType: 'link_opened',
    eventByEmail: tokenContext.recipient_email,
  });

  if (alreadySubmitted) {
    return res.send(renderSupplierAckPage({
      title: 'Response already submitted',
      message: `This JCC has already been marked as ${tokenContext.supplier_ack_status || 'processed'}.`,
      voucherContext: tokenContext,
    }));
  }

  return res.send(renderSupplierAckPage({
    title: 'Supplier JCC Acknowledgement',
    message: 'Please review the JCC PDF and submit your response.',
    token,
    voucherContext: tokenContext,
    showForm: true,
  }));
});

// Public supplier acknowledgement action
router.post('/supplier/ack/:token', async (req, res) => {
  const token = req.params.token;
  const tokenContext = getSupplierTokenContext(token);

  if (!tokenContext) {
    return res.status(404).send(renderSupplierAckPage({
      title: 'Invalid acknowledgement link',
      message: 'This supplier acknowledgement link is invalid. Please request a fresh link.',
      isError: true,
    }));
  }

  if (isSupplierTokenExpired(tokenContext.expires_at)) {
    db.prepare(`
      UPDATE voucher_requests
      SET supplier_ack_status = CASE WHEN supplier_ack_status = 'pending' THEN 'expired' ELSE supplier_ack_status END
      WHERE id = ?
    `).run(tokenContext.voucher_id);

    insertSupplierAckEvent({
      voucherId: tokenContext.voucher_id,
      tokenId: tokenContext.token_id,
      eventType: 'action_expired',
      eventByEmail: tokenContext.recipient_email,
    });

    return res.status(410).send(renderSupplierAckPage({
      title: 'Acknowledgement link expired',
      message: 'This link has expired. Please contact the InFloAI team to receive a fresh acknowledgement email.',
      voucherContext: tokenContext,
      isError: true,
    }));
  }

  const action = String(req.body.action || '').trim().toLowerCase();
  const remarks = String(req.body.remarks || '').trim().slice(0, 1000);

  if (!SUPPLIER_ACK_ALLOWED_ACTIONS.has(action)) {
    return res.status(400).send(renderSupplierAckPage({
      title: 'Invalid response',
      message: 'Please choose either Acknowledge JCC or Reject JCC.',
      token,
      voucherContext: tokenContext,
      showForm: true,
      isError: true,
    }));
  }

  const alreadySubmitted = ['acknowledged', 'rejected'].includes(String(tokenContext.supplier_ack_status || '').toLowerCase()) || Boolean(tokenContext.used_at);
  if (alreadySubmitted) {
    return res.send(renderSupplierAckPage({
      title: 'Response already submitted',
      message: `This JCC has already been marked as ${tokenContext.supplier_ack_status || 'processed'}.`,
      voucherContext: tokenContext,
    }));
  }

  db.prepare(`
    UPDATE voucher_requests
    SET supplier_ack_status = ?,
        supplier_ack_at = datetime('now'),
        supplier_ack_by_email = ?,
        supplier_ack_remarks = ?
    WHERE id = ?
  `).run(action, tokenContext.recipient_email, remarks || null, tokenContext.voucher_id);

  db.prepare(`
    UPDATE voucher_supplier_ack_tokens
    SET used_at = datetime('now')
    WHERE voucher_id = ? AND used_at IS NULL
  `).run(tokenContext.voucher_id);

  insertSupplierAckEvent({
    voucherId: tokenContext.voucher_id,
    tokenId: tokenContext.token_id,
    eventType: action,
    eventByEmail: tokenContext.recipient_email,
    remarks,
  });

  const voucherForNotifications = {
    id: tokenContext.voucher_id,
    user_id: tokenContext.user_id,
    supplier: tokenContext.supplier,
    approver1_name: tokenContext.approver1_name,
    approver2_name: tokenContext.approver2_name,
  };

  try {
    await Promise.all([
      sendSupplierAckReceiptEmail({
        recipientEmail: tokenContext.recipient_email,
        voucherId: tokenContext.voucher_id,
        supplierName: tokenContext.supplier,
        action,
        remarks,
      }),
      sendInternalSupplierAckEmails({
        voucher: voucherForNotifications,
        action,
        remarks,
        supplierEmail: tokenContext.recipient_email,
      }),
    ]);
  } catch (emailError) {
    console.error('Error sending supplier acknowledgement emails:', emailError);
  }

  return res.send(renderSupplierAckPage({
    title: 'Response recorded successfully',
    message: `Thank you. ${formatJccId(tokenContext.voucher_id)} has been marked as ${action}.`,
    voucherContext: tokenContext,
  }));
});

// Public supplier tokenized JCC PDF download
router.get('/supplier/ack/:token/pdf', async (req, res) => {
  const token = req.params.token;
  const tokenContext = getSupplierTokenContext(token);

  if (!tokenContext) {
    return res.status(404).send(renderSupplierAckPage({
      title: 'Invalid PDF link',
      message: 'This PDF link is invalid. Please use the latest supplier email link.',
      isError: true,
    }));
  }

  if (isSupplierTokenExpired(tokenContext.expires_at)) {
    db.prepare(`
      UPDATE voucher_requests
      SET supplier_ack_status = CASE WHEN supplier_ack_status = 'pending' THEN 'expired' ELSE supplier_ack_status END
      WHERE id = ?
    `).run(tokenContext.voucher_id);

    insertSupplierAckEvent({
      voucherId: tokenContext.voucher_id,
      tokenId: tokenContext.token_id,
      eventType: 'pdf_expired',
      eventByEmail: tokenContext.recipient_email,
    });

    return res.status(410).send(renderSupplierAckPage({
      title: 'PDF link expired',
      message: 'This secure PDF link has expired. Please request a fresh supplier email.',
      voucherContext: tokenContext,
      isError: true,
    }));
  }

  insertSupplierAckEvent({
    voucherId: tokenContext.voucher_id,
    tokenId: tokenContext.token_id,
    eventType: 'pdf_downloaded',
    eventByEmail: tokenContext.recipient_email,
  });

  try {
    await sendVoucherPdfDownload(res, tokenContext.voucher_id);
  } catch (error) {
    console.error('Error downloading tokenized JCC PDF:', error);
    return res.status(error.statusCode || 500).send(renderSupplierAckPage({
      title: 'Unable to download PDF',
      message: error.message || 'Failed to download JCC PDF',
      voucherContext: tokenContext,
      isError: true,
    }));
  }
});

// Verify invoice and create JCC entry
router.post('/verify/:invoiceId', authenticateToken, authorizeRoles('coordinator', 'admin'), (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { category, description, approvedAmount } = req.body;

    // Update invoice status
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run('approved', invoiceId);

    // Create JCC entry
    const result = db.prepare(`
      INSERT INTO jcc_entries (invoice_id, coordinator_id, category, description, approved_amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(invoiceId, req.user.id, category, description, approvedAmount);

    res.json({
      message: 'Invoice verified and JCC entry created',
      jccEntryId: result.lastInsertRowid,
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Failed to verify invoice' });
  }
});

// Get all JCC entries
router.get('/entries', authenticateToken, (req, res) => {
  try {
    const entries = db.prepare(`
      SELECT 
        j.*,
        i.vendor_name,
        i.invoice_number,
        i.amount as original_amount,
        u.name as coordinator_name
      FROM jcc_entries j
      LEFT JOIN invoices i ON j.invoice_id = i.id
      JOIN users u ON j.coordinator_id = u.id
      ORDER BY j.created_at DESC
    `).all();

    res.json(entries);
  } catch (error) {
    console.error('Error fetching JCC entries:', error);
    res.status(500).json({ error: 'Failed to fetch JCC entries' });
  }
});

// Get all voucher requests (filtered by role)
router.get('/vouchers', authenticateToken, (req, res) => {
  try {
    let vouchers;

    // Admin/coordinator/manager can see all vouchers, others only see their own
    // Admin/coordinator/manager/final_approver can see all vouchers, others only see their own
    if (req.user.role === 'admin' || req.user.role === 'coordinator' || req.user.role === 'manager' || req.user.role === 'final_approver') {
      vouchers = db.prepare(`
        SELECT v.*, u.name as user_name
        FROM voucher_requests v
        JOIN users u ON v.user_id = u.id
        ORDER BY v.created_at DESC
      `).all();
    } else {
      vouchers = db.prepare(`
        SELECT v.*, u.name as user_name
        FROM voucher_requests v
        JOIN users u ON v.user_id = u.id
        WHERE v.user_id = ?
        ORDER BY v.created_at DESC
      `).all(req.user.id);
    }

    res.json(vouchers);
  } catch (error) {
    console.error('Error fetching vouchers:', error);
    res.status(500).json({ error: 'Failed to fetch vouchers' });
  }
});

router.get('/vouchers/:id/payment-log', authenticateToken, (req, res) => {
  try {
    const voucherId = req.params.id;
    const voucher = db.prepare(`
      SELECT id, supplier, invoice_number, basic_amount, status, payment_status,
             payment_reference, payment_remarks, payment_submitted_at, payment_initiated_at,
             payment_debited_at, payment_settled_at, payment_failed_at, payment_reversed_at,
             supplier_ack_status, supplier_ack_email, supplier_ack_sent_at,
             supplier_ack_expires_at, supplier_ack_at, supplier_ack_by_email, supplier_ack_remarks
      FROM voucher_requests
      WHERE id = ?
    `).get(voucherId);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    const logs = db.prepare(`
      SELECT *
      FROM voucher_payment_logs
      WHERE voucher_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(voucherId);

    return res.json({ voucher, logs, paymentStatusMeta: PAYMENT_STATUS_META });
  } catch (error) {
    console.error('Error fetching voucher payment log:', error);
    return res.status(500).json({ error: 'Failed to fetch payment logs' });
  }
});

router.post('/vouchers/:id/payment-status', authenticateToken, authorizeRoles('admin', 'coordinator', 'manager', 'final_approver'), async (req, res) => {
  try {
    const voucherId = req.params.id;
    const { status, referenceNo, remarks, amount, actionSource } = req.body;

    if (!status || !PAYMENT_STATUS_META[status]) {
      return res.status(400).json({ error: 'Invalid payment status' });
    }

    const voucher = db.prepare(`
      SELECT id, user_id, supplier, basic_amount, status, payment_status
      FROM voucher_requests
      WHERE id = ?
    `).get(voucherId);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    if (voucher.status !== 'approved' && status !== 'awaiting_approval') {
      return res.status(400).json({ error: 'Voucher must be approved before payment tracking updates' });
    }

    const currentStatus = voucher.payment_status || 'awaiting_approval';
    if (currentStatus !== status) {
      const allowedNext = PAYMENT_TRANSITIONS[currentStatus] || [];
      if (!allowedNext.includes(status)) {
        return res.status(400).json({
          error: `Invalid status transition from ${PAYMENT_STATUS_META[currentStatus] || currentStatus} to ${PAYMENT_STATUS_META[status] || status}`,
        });
      }
    }

    let supplierDispatch = null;
    if (status === 'submitted_to_vendor' && currentStatus !== 'submitted_to_vendor') {
      supplierDispatch = await dispatchVoucherToSupplier({
        voucherId,
        actorUser: req.user,
        req,
      });
    }

    const timestampAssignment = setPaymentTimestamps(status);
    const updateSql = timestampAssignment
      ? `
          UPDATE voucher_requests
          SET payment_status = ?, payment_reference = ?, payment_remarks = ?, ${timestampAssignment}
          WHERE id = ?
        `
      : `
          UPDATE voucher_requests
          SET payment_status = ?, payment_reference = ?, payment_remarks = ?
          WHERE id = ?
        `;

    db.prepare(updateSql).run(status, referenceNo || null, remarks || null, voucherId);

    insertPaymentLog({
      voucherId,
      oldStatus: currentStatus,
      newStatus: status,
      referenceNo,
      amount: amount || voucher.basic_amount,
      remarks,
      actionSource,
      user: req.user,
    });

    db.prepare(`
      INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      req.user.name,
      'UPDATE_PAYMENT_STATUS',
      'voucher_request',
      voucherId,
      `Payment status changed from ${currentStatus} to ${status} for voucher JCC${String(voucherId).padStart(4, '0')}`
    );

    if (['debited', 'settled', 'failed', 'reversed'].includes(status)) {
      db.prepare(`
        INSERT INTO notifications (user_id, title, message, type)
        VALUES (?, ?, ?, ?)
      `).run(
        voucher.user_id,
        `Payment ${PAYMENT_STATUS_META[status]}`,
        `JCC${String(voucherId).padStart(4, '0')} for ${voucher.supplier} is now ${PAYMENT_STATUS_META[status]}${referenceNo ? ` (Ref: ${referenceNo})` : ''}.`,
        status === 'settled' ? 'success' : (status === 'debited' ? 'info' : 'warning')
      );
    }

    return res.json({
      message: 'Payment status updated successfully',
      status,
      label: PAYMENT_STATUS_META[status],
      supplierDispatch,
    });
  } catch (error) {
    console.error('Error updating voucher payment status:', error);
    return res.status(500).json({ error: 'Failed to update payment status' });
  }
});

// Get list of managers for approver dropdown
router.get('/managers', authenticateToken, (req, res) => {
  try {
    const managers = db.prepare(`
      SELECT id, name, email, ps_number
      FROM users
      WHERE role = 'manager'
      ORDER BY name ASC
    `).all();

    res.json(managers);
  } catch (error) {
    console.error('Error fetching managers:', error);
    res.status(500).json({ error: 'Failed to fetch managers' });
  }
});

// Approve voucher at Level 1
router.post('/approve-level-1/:id', authenticateToken, authorizeRoles('manager'), (req, res) => {
  try {
    const { remark } = req.body;
    const voucherId = req.params.id;

    // Check if voucher is at approval level 1
    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    if (voucher.current_approval_level !== 1) {
      return res.status(400).json({ error: 'Voucher is not at approval level 1' });
    }

    // Update to move to level 2 and enable approver 2
    db.prepare(`
      UPDATE voucher_requests SET
        approver1_status = 'approved',
        approver1_remark = ?,
        approver1_date = datetime('now'),
        approver2_status = 'pending',
        current_approval_level = 2,
        status = 'pending_approval_2'
      WHERE id = ?
    `).run(remark, voucherId);

    try {
      const creator = db.prepare('SELECT id, name, email, ps_number FROM users WHERE id = ?').get(voucher.user_id);
      const approver = { name: req.user.name, email: req.user.email };
      const voucherData = {
        voucherRequestId: `JCC${String(voucher.id).padStart(4, '0')}`,
        supplier: voucher.supplier,
        invoiceNumber: voucher.invoice_number,
        invoiceDate: voucher.invoice_date,
        department: voucher.department,
        basicAmount: voucher.basic_amount,
        grossAmount: voucher.gross_amount,
        poNumber: voucher.po_number,
        claimedBy: voucher.claimed_by,
        natureOfExpenses: voucher.nature_of_expenses,
        expenseBookingLocation: voucher.expense_booking_location,
        creatorPsNumber: creator ? creator.ps_number : '',
        approver1Name: voucher.approver1_name,
        approver2Name: voucher.approver2_name
      };

      // Email: creator (level 1 approved) + approver (confirmation)
      notifyVoucherApproved(voucherData, approver, creator, 'Level 1 Manager')
        .then(results => console.log('[Email] Level 1 approval notifications sent:', results))
        .catch(err => console.error('[Email] Level 1 approval notification error:', err));

      // Email + in-app: notify Final Approver (their turn now)
      if (voucher.approver2_name) {
        const nextApprover = findUserByName(voucher.approver2_name);
        if (nextApprover) {
          notifyNextApprover(voucherData, creator, nextApprover)
            .then(result => console.log('[Email] Final approver notified:', result))
            .catch(err => console.error('[Email] Final approver notification error:', err));

          // In-app for final approver
          db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
            .run(
              nextApprover.id,
              'Action Required: JCC Final Approval',
              `JCC ${voucherData.voucherRequestId} from ${creator ? creator.name : 'user'} has passed Level 1 and needs your final approval.`,
              'warning'
            );
        }
      }

      // In-app for creator: level 1 approved
      if (creator) {
        db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
          .run(
            creator.id,
            'JCC Approved at Level 1',
            `Your JCC ${voucherData.voucherRequestId} has been approved by ${req.user.name} (Level 1 Manager) and is now pending Final Approval.`,
            'info'
          );
      }
    } catch (emailError) {
      console.error('Error sending Level 1 approval emails/notifications:', emailError);
    }

    res.json({ message: 'Voucher approved by Approver 1, moved to Approver 2' });
  } catch (error) {
    console.error('Error approving level 1:', error);
    res.status(500).json({ error: 'Failed to approve voucher' });
  }
});


// Approve voucher at Level 2 (Final Approval)
router.post('/approve-level-2/:id', authenticateToken, authorizeRoles('final_approver'), (req, res) => {
  try {
    const { remark } = req.body;
    const voucherId = req.params.id;

    // Check if voucher is at approval level 2 and level 1 is approved
    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    if (voucher.current_approval_level !== 2) {
      return res.status(400).json({ error: 'Voucher is not at approval level 2' });
    }

    if (voucher.approver1_status !== 'approved') {
      return res.status(400).json({ error: 'Approver 1 must approve first' });
    }

    // Final approval
    db.prepare(`
      UPDATE voucher_requests SET
        approver2_status = 'approved',
        approver2_remark = ?,
        approver2_date = datetime('now'),
        current_approval_level = NULL,
        status = 'approved',
        payment_status = 'pending_payment'
      WHERE id = ?
    `).run(remark, voucherId);

    insertPaymentLog({
      voucherId,
      oldStatus: voucher.payment_status || 'awaiting_approval',
      newStatus: 'pending_payment',
      referenceNo: null,
      amount: voucher.basic_amount,
      remarks: 'Voucher fully approved and moved to payment queue',
      actionSource: 'approval_level_2',
      user: req.user,
    });

    try {
      const creator = db.prepare('SELECT id, name, email, ps_number FROM users WHERE id = ?').get(voucher.user_id);
      const manager = voucher.approver1_name
        ? findUserByName(voucher.approver1_name)
        : null;
      const approver = { name: req.user.name, email: req.user.email };
      const appBaseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
      const voucherData = {
        voucherId: voucher.id,
        voucherRequestId: `JCC${String(voucher.id).padStart(4, '0')}`,
        supplier: voucher.supplier,
        invoiceNumber: voucher.invoice_number,
        invoiceDate: voucher.invoice_date,
        department: voucher.department,
        basicAmount: voucher.basic_amount,
        grossAmount: voucher.gross_amount,
        poNumber: voucher.po_number,
        claimedBy: voucher.claimed_by,
        natureOfExpenses: voucher.nature_of_expenses,
        expenseBookingLocation: voucher.expense_booking_location,
        jccLink: appBaseUrl ? `${appBaseUrl}/api/jcc/download-jcc-pdf/${voucher.id}` : '',
        creatorPsNumber: creator ? creator.ps_number : '',
        approver1Name: voucher.approver1_name,
        approver2Name: voucher.approver2_name
      };

      // Email: initiator + manager (final approved notice) and final approver (confirmation)
      notifyVoucherApproved(voucherData, approver, creator, 'Final Approver', manager)
        .then(results => console.log('[Email] Level 2 approval notifications sent:', results))
        .catch(err => console.error('[Email] Level 2 approval notification error:', err));

      // In-app for creator: fully approved
      if (creator) {
        db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
          .run(
            creator.id,
            'JCC Successfully Approved! ✓',
            `Your JCC ${voucherData.voucherRequestId} (${voucher.supplier}, ₹${voucher.basic_amount}) has been fully approved by ${req.user.name}. You can now download the JCC PDF.`,
            'success'
          );
      }
    } catch (emailError) {
      console.error('Error sending Level 2 approval emails/notifications:', emailError);
    }

    res.json({
      message: 'Voucher fully approved by both approvers',
      voucherId: voucherId,
      downloadPdf: true  // Signal frontend to download PDF
    });
  } catch (error) {
    console.error('Error approving level 2:', error);
    res.status(500).json({ error: 'Failed to approve voucher' });
  }
});

// Reject voucher at Level 1
router.post('/reject-level-1/:id', authenticateToken, authorizeRoles('manager'), (req, res) => {
  try {
    const { remark } = req.body;
    const voucherId = req.params.id;

    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    if (voucher.current_approval_level !== 1) {
      return res.status(400).json({ error: 'Voucher is not at approval level 1' });
    }

    // Reject at level 1
    db.prepare(`
      UPDATE voucher_requests SET
        approver1_status = 'rejected',
        approver1_remark = ?,
        approver1_date = datetime('now'),
        current_approval_level = NULL,
        status = 'rejected'
      WHERE id = ?
    `).run(remark, voucherId);

    // Email + in-app notifications
    try {
      const creator = db.prepare('SELECT id, name, email, ps_number FROM users WHERE id = ?').get(voucher.user_id);
      const rejector = { name: req.user.name, email: req.user.email };
      const voucherData = {
        voucherRequestId: `JCC${String(voucher.id).padStart(4, '0')}`,
        supplier: voucher.supplier,
        invoiceNumber: voucher.invoice_number,
        invoiceDate: voucher.invoice_date,
        department: voucher.department,
        basicAmount: voucher.basic_amount,
        grossAmount: voucher.gross_amount,
        poNumber: voucher.po_number,
        claimedBy: voucher.claimed_by,
        natureOfExpenses: voucher.nature_of_expenses,
        expenseBookingLocation: voucher.expense_booking_location,
        creatorPsNumber: creator ? creator.ps_number : ''
      };

      notifyVoucherRejected(voucherData, rejector, creator, 'Level 1 Manager', remark)
        .then(result => console.log('[Email] Level 1 rejection notification sent:', result))
        .catch(err => console.error('[Email] Level 1 rejection notification error:', err));

      if (creator) {
        db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
          .run(
            creator.id,
            'JCC Rejected at Level 1',
            `Your JCC ${voucherData.voucherRequestId} (${voucher.supplier}) has been rejected by ${req.user.name}.${remark ? ` Reason: ${remark}` : ''}`,
            'error'
          );
      }
    } catch (emailError) {
      console.error('Error sending Level 1 rejection emails/notifications:', emailError);
    }

    res.json({ message: 'Voucher rejected by Approver 1' });
  } catch (error) {
    console.error('Error rejecting level 1:', error);
    res.status(500).json({ error: 'Failed to reject voucher' });
  }
});


// Reject voucher at Level 2
router.post('/reject-level-2/:id', authenticateToken, authorizeRoles('final_approver'), (req, res) => {
  try {
    const { remark } = req.body;
    const voucherId = req.params.id;

    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    if (voucher.current_approval_level !== 2) {
      return res.status(400).json({ error: 'Voucher is not at approval level 2' });
    }

    // Reject at level 2
    db.prepare(`
      UPDATE voucher_requests SET
        approver2_status = 'rejected',
        approver2_remark = ?,
        approver2_date = datetime('now'),
        current_approval_level = NULL,
        status = 'rejected'
      WHERE id = ?
    `).run(remark, voucherId);

    // Email + in-app notifications
    try {
      const creator = db.prepare('SELECT id, name, email, ps_number FROM users WHERE id = ?').get(voucher.user_id);
      const rejector = { name: req.user.name, email: req.user.email };
      const voucherData = {
        voucherRequestId: `JCC${String(voucher.id).padStart(4, '0')}`,
        supplier: voucher.supplier,
        invoiceNumber: voucher.invoice_number,
        invoiceDate: voucher.invoice_date,
        department: voucher.department,
        basicAmount: voucher.basic_amount,
        grossAmount: voucher.gross_amount,
        poNumber: voucher.po_number,
        claimedBy: voucher.claimed_by,
        natureOfExpenses: voucher.nature_of_expenses,
        expenseBookingLocation: voucher.expense_booking_location,
        creatorPsNumber: creator ? creator.ps_number : ''
      };

      notifyVoucherRejected(voucherData, rejector, creator, 'Final Approver', remark)
        .then(result => console.log('[Email] Level 2 rejection notification sent:', result))
        .catch(err => console.error('[Email] Level 2 rejection notification error:', err));

      if (creator) {
        db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
          .run(
            creator.id,
            'JCC Rejected by Final Approver',
            `Your JCC ${voucherData.voucherRequestId} (${voucher.supplier}) has been rejected by ${req.user.name} (Final Approver).${remark ? ` Reason: ${remark}` : ''}`,
            'error'
          );
      }
    } catch (emailError) {
      console.error('Error sending Level 2 rejection emails/notifications:', emailError);
    }

    res.json({ message: 'Voucher rejected by Approver 2' });
  } catch (error) {
    console.error('Error rejecting level 2:', error);
    res.status(500).json({ error: 'Failed to reject voucher' });
  }
});

// Resubmit rejected voucher
router.post('/vouchers/:id/resubmit', authenticateToken, (req, res) => {
  try {
    const voucherId = req.params.id;
    const { description, gross_amount, basic_amount, po_number, invoice_number } = req.body;

    // Verify ownership and status
    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    if (voucher.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to resubmit this voucher' });
    }

    if (voucher.status !== 'rejected') {
      return res.status(400).json({ error: 'Only rejected vouchers can be resubmitted' });
    }

    // Update voucher and reset approval status
    db.prepare(`
      UPDATE voucher_requests SET
        description = ?,
        gross_amount = ?,
        basic_amount = ?,
        po_number = ?,
        invoice_number = ?,
        payment_status = 'awaiting_approval',
        payment_reference = NULL,
        payment_remarks = NULL,
        payment_submitted_at = NULL,
        payment_initiated_at = NULL,
        payment_debited_at = NULL,
        payment_settled_at = NULL,
        payment_failed_at = NULL,
        payment_reversed_at = NULL,
        status = 'pending_approval_1',
        approver1_status = 'pending',
        approver1_remark = NULL,
        approver1_date = NULL,
        approver2_status = 'pending',
        approver2_remark = NULL,
        approver2_date = NULL,
        current_approval_level = 1,
        created_at = datetime('now') -- Optional: Update timestamp to now
      WHERE id = ?
    `).run(
      description,
      gross_amount || voucher.gross_amount,
      basic_amount || voucher.basic_amount,
      po_number || voucher.po_number,
      invoice_number || voucher.invoice_number,
      voucherId
    );

    res.json({ message: 'Voucher resubmitted successfully' });
  } catch (error) {
    console.error('Error resubmitting voucher:', error);
    res.status(500).json({ error: 'Failed to resubmit voucher' });
  }
});

// Get audit logs  
router.get('/audit-logs', authenticateToken, authorizeRoles('coordinator', 'admin'), (req, res) => {
  try {
    const logs = db.prepare(`
            SELECT * FROM audit_logs
            ORDER BY created_at DESC
            LIMIT 100
        `).all();
    res.json(logs);
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// Approve voucher
router.post('/approve-voucher/:voucherId', authenticateToken, authorizeRoles('coordinator', 'admin'), (req, res) => {
  try {
    const { voucherId } = req.params;

    // Get voucher details first
    const voucher = db.prepare(`
      SELECT v.*, u.id as user_id, u.name as user_name
      FROM voucher_requests v
      JOIN users u ON v.user_id = u.id
      WHERE v.id = ?
    `).get(voucherId);

    // Update voucher status to approved
    db.prepare(`
      UPDATE voucher_requests
      SET status = 'approved',
          payment_status = 'pending_payment'
      WHERE id = ?
    `).run(voucherId);

    insertPaymentLog({
      voucherId,
      oldStatus: voucher.payment_status || 'awaiting_approval',
      newStatus: 'pending_payment',
      referenceNo: null,
      amount: voucher.basic_amount,
      remarks: 'Voucher approved and moved to payment queue',
      actionSource: 'approve_voucher_legacy',
      user: req.user,
    });

    // Create audit log
    db.prepare(`
      INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      req.user.name,
      'APPROVE_VOUCHER',
      'voucher_request',
      voucherId,
      `Approved voucher VR-${voucherId}`
    );

    // Notify the user who created the voucher
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, ?)
    `).run(
      voucher.user_id,
      'Voucher Approved! ✓',
      `Your voucher VR-${voucherId} for ${voucher.supplier} (₹${voucher.basic_amount}) has been approved by ${req.user.name}.`,
      'success'
    );

    res.json({ message: 'Voucher approved successfully' });
  } catch (error) {
    console.error('Voucher approval error:', error);
    res.status(500).json({ error: 'Failed to approve voucher' });
  }
});

// Reject voucher
router.post('/reject-voucher/:voucherId', authenticateToken, authorizeRoles('coordinator', 'admin'), (req, res) => {
  try {
    const { voucherId } = req.params;
    const { reason } = req.body;

    // Get voucher details first
    const voucher = db.prepare(`
      SELECT v.*, u.id as user_id, u.name as user_name
      FROM voucher_requests v
      JOIN users u ON v.user_id = u.id
      WHERE v.id = ?
    `).get(voucherId);

    // Update voucher status to rejected
    db.prepare(`
      UPDATE voucher_requests
      SET status = 'rejected'
      WHERE id = ?
    `).run(voucherId);

    // Create audit log
    db.prepare(`
      INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      req.user.name,
      'REJECT_VOUCHER',
      'voucher_request',
      voucherId,
      `Rejected voucher VR-${voucherId}. Reason: ${reason || 'Not specified'}`
    );

    // Notify the user who created the voucher
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, ?)
    `).run(
      voucher.user_id,
      'Voucher Rejected',
      `Your voucher VR-${voucherId} for ${voucher.supplier} was rejected by ${req.user.name}. ${reason ? `Reason: ${reason}` : ''}`,
      'error'
    );

    res.json({ message: 'Voucher rejected successfully' });
  } catch (error) {
    console.error('Voucher rejection error:', error);
    res.status(500).json({ error: 'Failed to reject voucher' });
  }
});

// Get user notifications
router.get('/notifications', authenticateToken, (req, res) => {
  try {
    const notifications = db.prepare(`
      SELECT * FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(req.user.id);

    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
router.post('/notifications/:id/read', authenticateToken, (req, res) => {
  try {
    db.prepare(`
      UPDATE notifications
      SET read = 1
      WHERE id = ? AND user_id = ?
    `).run(req.params.id, req.user.id);

    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
router.post('/notifications/read-all', authenticateToken, (req, res) => {
  try {
    db.prepare(`
      UPDATE notifications
      SET read = 1
      WHERE user_id = ?
    `).run(req.user.id);

    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

export default router;
