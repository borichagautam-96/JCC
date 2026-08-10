import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import db from '../database.js';
import { authenticateToken, authorizeRoles, JWT_SECRET } from '../middleware/auth.js';
import { generateJCCPDF } from '../utils/pdfGenerator.js';
import { notifyVoucherCreated, notifyVoucherApproved, notifyNextApprover, notifyVoucherRejected, sendEmail } from '../utils/emailService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


import { extractInvoiceData } from '../utils/ocrProcessor.js';
import { extractPdfWithOpenDataLoader } from '../services/pdfExtractor.js';
import { formatStoredDateDMY } from '../utils/datetime.js';

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
// Outdoor/field-duty exception: when the claimer was out on duty they may file an
// invoice older than the standard 15-day window, bounded by this hard cap.
const OUTDOOR_DUTY_LOOKBACK_DAYS = 45;
const OUTDOOR_REMARK_MIN_LENGTH = 10;

// One-click email approval: a signed, expiring token bound to a specific voucher,
// approval level, approver, AND the voucher's current approval_nonce. GET shows a
// confirmation page (so email link scanners cannot auto-approve); POST performs it.
// The nonce is bumped whenever a voucher re-enters approval (resubmit / respond-info),
// which invalidates any older email link — preventing replay of a stale link.
const APPROVAL_TOKEN_TTL = '7d';

const currentApprovalNonce = (voucherId) => {
  const row = db.prepare('SELECT approval_nonce FROM voucher_requests WHERE id = ?').get(voucherId);
  return Number(row?.approval_nonce) || 0;
};

const generateApprovalToken = (voucherId, level, approverId) =>
  jwt.sign(
    { purpose: 'jcc-approve', voucherId: Number(voucherId), level: Number(level), approverId: Number(approverId), nonce: currentApprovalNonce(voucherId) },
    JWT_SECRET,
    { expiresIn: APPROVAL_TOKEN_TTL }
  );

// Points at the in-app approval screen. That route is public (the token carries the
// authority) and renders the claim inside the portal instead of a bare API page.
// /api/jcc/approve-via-link/:token still works for links already sitting in inboxes.
const approvalLink = (voucherId, level, approverId) => {
  const base = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  if (!base) return '';
  return `${base}/approve/${generateApprovalToken(voucherId, level, approverId)}`;
};

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

// Authorization for viewing a voucher's data / files: the creator, an assigned
// approver, or a privileged oversight role. Blocks IDOR (one claimant reading
// another claimant's attachment/PDF by guessing the id).
const canViewVoucher = (req, voucher) => {
  if (!voucher) return false;
  if (['admin', 'coordinator', 'manager', 'final_approver'].includes(req.user.role)) return true;
  if (voucher.user_id === req.user.id) return true;
  const name = String(req.user.name || '').trim().toLowerCase();
  return String(voucher.approver1_name || '').trim().toLowerCase() === name
    || String(voucher.approver2_name || '').trim().toLowerCase() === name;
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

// Exported for tests. This parser is where descriptionOfMaterial was once lost: it
// accepts several body shapes, and a field missing from any one of them disappears
// without an error. Testing it directly is the only way to pin every shape.
// Department codes cost may be booked against. Mirrors src/constants/departments.js —
// the server must not trust whatever the form posts, since this routes real money.
const VALID_DEPARTMENT_CODES = ['3559', '3998'];

export const parseVoucherMaterials = (body) => {
  const normalizeMaterial = (item = {}) => ({
    amount: normalizeDuplicateCsvPair(item.amount ?? item.projectAmount ?? ''),
    projectCode: normalizeDuplicateCsvPair(item.projectCode ?? item.project_code ?? ''),
    projectName: normalizeDuplicateCsvPair(item.projectName ?? item.project_name ?? ''),
    // ─── FIX: descriptionOfMaterial was previously missing from this mapper ───
    // Without this, the frontend's descriptionOfMaterial was silently discarded
    // and never written to the voucher_materials table → blank in the PDF.
    descriptionOfMaterial: normalizeDuplicateCsvPair(
      item.descriptionOfMaterial ?? item.description_of_material ?? ''
    ),
    quantity: normalizeDuplicateCsvPair(item.quantity ?? ''),
  });

  const hasMaterialKeys = (value) => (
    'amount' in value
    || 'projectAmount' in value
    || 'projectCode' in value
    || 'project_code' in value
    || 'projectName' in value
    || 'project_name' in value
    || 'descriptionOfMaterial' in value
    || 'description_of_material' in value
    || 'quantity' in value
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
        /^materials\[(\d+)\]\[(amount|projectCode|projectName|project_code|project_name|descriptionOfMaterial|description_of_material|quantity)\]$/,
        /^materials\.(\d+)\.(amount|projectCode|projectName|project_code|project_name|descriptionOfMaterial|description_of_material|quantity)$/,
        /^materials\[(\d+)\]\.(amount|projectCode|projectName|project_code|project_name|descriptionOfMaterial|description_of_material|quantity)$/,
        /^(amount|projectCode|projectName|project_code|project_name|descriptionOfMaterial|description_of_material|quantity)_(\d+)$/,
      ];

      for (const pattern of patterns) {
        const match = pattern.exec(key);
        if (!match) continue;

        // Pattern variant where field appears first: amount_0
        if (/^(amount|projectCode|projectName|project_code|project_name|descriptionOfMaterial|description_of_material|quantity)_/.test(key)) {
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
      if (!map.has(index)) map.set(index, { amount: '', projectCode: '', projectName: '', descriptionOfMaterial: '', quantity: '' });
      const target = map.get(index);

      if (field === 'amount') target.amount = value ?? '';
      if (field === 'projectCode' || field === 'project_code') target.projectCode = value ?? '';
      if (field === 'projectName' || field === 'project_name') target.projectName = value ?? '';
      if (field === 'descriptionOfMaterial' || field === 'description_of_material') target.descriptionOfMaterial = value ?? '';
      if (field === 'quantity') target.quantity = value ?? '';
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
        // descriptionOfMaterial MUST be included — omitting it caused it to be silently dropped
        descriptionOfMaterial: String(item.descriptionOfMaterial ?? '').trim(),
        quantity: String(item.quantity ?? '').trim(),
      };
      // Dedup key excludes description so that rows with same amount/code/name but different
      // descriptions aren't wrongly merged. When there IS a duplicate, prefer the one with a description.
      const dedupKey = JSON.stringify({
        amount: normalized.amount,
        projectCode: normalized.projectCode,
        projectName: normalized.projectName,
      });
      return [dedupKey, normalized];
    })
  ).values()];

  // Keep only rows with at least one meaningful value.
  return uniqueCandidates
    .filter((item) => item.amount || item.projectCode || item.projectName || item.descriptionOfMaterial || item.quantity);
};

const SUPPLIER_ACK_TOKEN_VALIDITY_HOURS = 24 * 7;
const SUPPLIER_ACK_ALLOWED_ACTIONS = new Set(['acknowledged', 'rejected']);

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// ─── JCC Number: Financial-Year-Aware Sequential Generator ──────────────────
// Format:  JCC/YY-YY/NNNN  (e.g. JCC/25-26/0001)
// The sequence resets every April 1st (start of Indian financial year).
// Numbers are stored in the voucher_requests table itself (jcc_number column).
// For backward-compat, old rows without jcc_number fall back to JCC0001 style.

(() => {
  // Ensure the jcc_number column exists (idempotent)
  try {
    db.exec(`ALTER TABLE voucher_requests ADD COLUMN jcc_number TEXT`);
  } catch (_) { /* column already exists */ }
})();

/**
 * Returns the Indian financial year string for a given date.
 * April–March:  2025-04-01 → "25-26", 2025-03-31 → "24-25"
 */
const getFinancialYear = (date = new Date()) => {
  const month = date.getMonth(); // 0-based
  const year  = date.getFullYear();
  if (month >= 3) { // April (3) onwards
    return `${String(year).slice(-2)}-${String(year + 1).slice(-2)}`;
  }
  return `${String(year - 1).slice(-2)}-${String(year).slice(-2)}`;
};

/**
 * Assigns a new unique JCC number to a freshly-inserted voucher and saves it.
 * Uses a sequential counter (total JCC numbers assigned so far + 1)
 * so the FIRST claim is always JCC0001 regardless of the database row ID.
 * Returns the JCC number string (e.g. "JCC0001").
 */
const assignJccNumber = (voucherId) => {
  // Count how many vouchers already have a jcc_number assigned
  // (excluding the one we are about to assign, which has none yet)
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count FROM voucher_requests
    WHERE jcc_number IS NOT NULL AND jcc_number != ''
  `).get();

  const seq = (count || 0) + 1;
  const jccNum = `JCC${String(seq).padStart(4, '0')}`;

  db.prepare(`UPDATE voucher_requests SET jcc_number = ? WHERE id = ?`)
    .run(jccNum, voucherId);

  return jccNum;
};

/**
 * Returns the display JCC number for a voucher.
 * Prefers the stored jcc_number; falls back to legacy JCC0001 style for old rows.
 */
const formatJccId = (voucherId) => {
  if (!voucherId) return 'JCC0000';
  const row = db.prepare(`SELECT jcc_number FROM voucher_requests WHERE id = ?`).get(voucherId);
  return row?.jcc_number || `JCC${String(voucherId).padStart(4, '0')}`;
};
// ─────────────────────────────────────────────────────────────────────────────


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

  if (voucher.status !== 'approved' && voucher.status !== 'processed') {
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

  const formatDate = (dateStr) => formatStoredDateDMY(dateStr);

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

  // What the initiator actually chose wins. The name-based derivation below is only a
  // fallback for vouchers raised before the field existed — it cannot tell 3559 from
  // 3998, because both belong to the same department, so it must never override a
  // recorded choice.
  const deptCode = (() => {
    const stored = String(voucher.department_code || '').trim();
    if (stored) return stored;
    const dept = (voucher.department || '').toUpperCase();
    if (dept.includes('DOCUMENTATION') || dept.includes('TRAINING')) return '3559';
    return '';
  })();

  const materialsQuery = db.prepare(`
    SELECT amount, project_code, project_name, description_of_material, quantity
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
        description_of_material: normalizeDuplicateCsvPair(row.description_of_material),
        quantity: row.quantity,
      };
      return [JSON.stringify(normalized), normalized];
    })
  ).values()].filter((row) => row.amount || row.project_code || row.project_name
    || row.description_of_material || row.quantity != null);

  const isMaterialsEmpty = normalizedMaterials.length === 0;

  // Use the voucher's main description field as fallback when individual
  // material rows have no description_of_material saved.
  const voucherDescriptionFallback = String(voucher.description || '').trim();

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
    description_of_material: voucherDescriptionFallback,
    quantity: null,
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
    // Use material-specific description if available; fall back to voucher description
    description_of_material: String(material.description_of_material || '').trim() || voucherDescriptionFallback,
    quantity: material.quantity,
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
        action: 'Initiated',
        date: formatDate(voucher.claimed_date),
      },
      {
        action_by: 'FIRST APPROVER',
        person: resolvePersonName(voucher.approver1_name, voucher.approver1_name || '-'),
        psno: getPSNumberFromName(voucher.approver1_name),
        action: voucher.approver1_status === 'approved' ? 'Reviewed' : (voucher.approver1_status || '-'),
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
  const downloadFilename = `${jccId.replace(/\//g, '-')}.pdf`;
  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const safeJccId = jccId.replace(/\//g, '-');
  const pdfPath = path.join(tempDir, `${safeJccId}-${uniqueSuffix}.pdf`);

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


// Extract data from PDF using OpenDataLoader
router.post('/extract-pdf', authenticateToken, upload.single('invoice'), async (req, res) => {
  let uploadedPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Invoice file is required' });
    }

    uploadedPath = req.file.path;
    const fileType = req.file.mimetype || '';
    
    if (fileType !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are supported for this extraction method' });
    }

    // ── Step 1: Try OpenDataLoader (Java/Apache Tika-based) ──────────────────────────
    // Wrapped in try/catch: Java may be unavailable or crash in some environments
    // (e.g. missing native lcms2 lib, OOM, etc.). In that case we fall straight to
    // the pdfjs geometric parser which requires NO Java at all.
    let extraction = { invoiceNumber: '', amount: '', basicAmount: '', date: '', poNumber: '', vendorName: '', rawText: '', lineItems: [] };
    let openDataLoaderFailed = false;
    try {
      extraction = await extractPdfWithOpenDataLoader(uploadedPath);
    } catch (odlError) {
      openDataLoaderFailed = true;
      console.warn('⚠️  OpenDataLoader/Java failed — falling back directly to pdfjs geometric parser. Reason:', odlError.message?.split('\n')[0] || odlError.message);
    }

    // ── Step 2: Fallback to pdfjs/Tesseract OCR parser ───────────────────────────────
    // Triggers when: (a) OpenDataLoader threw an error, OR (b) it returned incomplete data
    if (openDataLoaderFailed || !extraction.invoiceNumber || !extraction.amount || !extraction.date || !extraction.poNumber || !extraction.lineItems || extraction.lineItems.length === 0) {
        try {
            if (!openDataLoaderFailed) {
                console.log('OpenDataLoader missed some fields or line items, falling back to OCR/Geometric parser...');
            }
            const fallbackResult = await extractInvoiceData(uploadedPath, fileType);
            
            // Merge missing fields from fallback
            extraction.invoiceNumber = extraction.invoiceNumber || fallbackResult.invoiceNumber || '';
            extraction.amount = extraction.amount || fallbackResult.amount || '';
            extraction.date = extraction.date || fallbackResult.date || '';
            extraction.poNumber = extraction.poNumber || fallbackResult.poNumber || '';
            extraction.vendorName = extraction.vendorName || fallbackResult.vendorName || '';
            
            // If rawText was basically empty (like an image tag), replace it with OCR text
            const textLen = (extraction.rawText || '').replace(/!\[.*?\]\(.*?\)/g, '').trim().length;
            if (textLen < 50 && fallbackResult.text) {
                extraction.rawText = fallbackResult.text;
            }

            if (!extraction.lineItems || extraction.lineItems.length === 0) {
                extraction.lineItems = fallbackResult.lineItems || [];
            }
        } catch (fbError) {
            console.warn('Fallback extraction failed, proceeding with original data:', fbError.message);
        }
    }


    // Hornbill Vendor Specific Cleanup: Strip the generic 'Services' prefix to expose actual item details
    // Check both vendorName and rawText (covers both text and image-based PDFs)
    const hornbillCheckText = (extraction.vendorName || '') + ' ' + (extraction.rawText || '');
    const isHornbill = /hornbill|AAECH5664G1ZG|HBS\//i.test(hornbillCheckText);
                       
    if (isHornbill && extraction.lineItems) {
        // Set vendorName explicitly if not already set
        if (!extraction.vendorName || !extraction.vendorName.toLowerCase().includes('hornbill')) {
            extraction.vendorName = 'Hornbill Studios Private Limited';
        }
        extraction.lineItems.forEach(item => {
            if (item.description) {
                // Remove 'Services' or 'Services \n' from the start of the description
                item.description = item.description.replace(/^services\s*[\n\r]*\s*/i, '').trim();
            }
        });
    }

    // ─── Auto-derive basicAmount and grossAmount from line items if not already set ───
    // This handles vendors (e.g. Hornbill) whose PDFs don't carry explicit TAXABLE AMOUNT labels
    const nonSummaryItems = (extraction.lineItems || []).filter(item => !item.isSummary);
    if (nonSummaryItems.length > 0) {
        const itemsSum = nonSummaryItems.reduce((sum, item) => {
            const raw = String(item.amount || '').replace(/[₹,\s]/g, '');
            return sum + (parseFloat(raw) || 0);
        }, 0);

        if (itemsSum > 0) {
            // Set basicAmount from line items sum if not already provided
            if (!extraction.basicAmount || parseFloat(extraction.basicAmount) <= 0) {
                extraction.basicAmount = itemsSum.toFixed(2);
            }
            // Set gross amount if not already provided: basic + 18% GST
            if (!extraction.amount || parseFloat(extraction.amount) <= 0) {
                extraction.amount = (parseFloat(extraction.basicAmount) * 1.18).toFixed(2);
            }
        }
    }

    return res.json({
      vendorName: extraction.vendorName || '',
      invoiceNumber: extraction.invoiceNumber || '',
      amount: extraction.amount || '',
      basicAmount: extraction.basicAmount || '',
      date: extraction.date || '',
      poNumber: extraction.poNumber || '',
      rawText: extraction.rawText || '',
      lineItems: extraction.lineItems || []
    });
  } catch (error) {
    console.error('JCC PDF extraction API error:', error);
    return res.status(500).json({ error: 'Failed to extract PDF data: ' + error.message });
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try {
        fs.unlinkSync(uploadedPath);
      } catch (cleanupError) {
        console.warn('Failed to clean up extracted temp file:', cleanupError.message);
      }
    }
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
router.post('/create-voucher', authenticateToken, authorizeRoles('initiator', 'user', 'admin'), upload.single('attachment'), async (req, res) => {
  try {
    const {
      claimedBy,
      department,
      departmentCode,
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
      outdoorDuty,      // 'true' when the claimer was out on field duty
      outdoorFrom,      // start of outdoor duty (YYYY-MM-DD)
      outdoorTo,        // end / return date of outdoor duty (YYYY-MM-DD)
      outdoorRemark,    // justification for the backdated invoice
    } = req.body;

    // Normalize the outdoor-duty flag (multipart form fields arrive as strings)
    const isOutdoorDuty = outdoorDuty === true || outdoorDuty === 'true' || outdoorDuty === 'on' || outdoorDuty === '1';

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

    // Outdoor/field-duty exception path. When the claimer was out on duty we allow
    // an older invoice (up to OUTDOOR_DUTY_LOOKBACK_DAYS), but only if the trip is
    // documented and the invoice actually falls within the trip window — this
    // prevents unrelated old invoices from being backdated under the exception.
    let normalizedOutdoorFrom = null;
    let normalizedOutdoorTo = null;
    let normalizedOutdoorRemark = null;

    if (isOutdoorDuty) {
      normalizedOutdoorFrom = String(outdoorFrom || '').trim();
      normalizedOutdoorTo = String(outdoorTo || '').trim();
      normalizedOutdoorRemark = String(outdoorRemark || '').trim();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedOutdoorFrom)) {
        return res.status(400).json({ error: 'Outdoor duty "From" date is invalid' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedOutdoorTo)) {
        return res.status(400).json({ error: 'Outdoor duty "To" date is invalid' });
      }
      if (normalizedOutdoorRemark.length < OUTDOOR_REMARK_MIN_LENGTH) {
        return res.status(400).json({ error: `Please provide a reason for the outdoor duty (at least ${OUTDOOR_REMARK_MIN_LENGTH} characters)` });
      }

      const outdoorFromObj = new Date(`${normalizedOutdoorFrom}T00:00:00`);
      const outdoorToObj = new Date(`${normalizedOutdoorTo}T00:00:00`);
      if (Number.isNaN(outdoorFromObj.getTime()) || Number.isNaN(outdoorToObj.getTime())) {
        return res.status(400).json({ error: 'Outdoor duty dates are invalid' });
      }
      if (outdoorFromObj > outdoorToObj) {
        return res.status(400).json({ error: 'Outdoor duty "From" date cannot be after the "To" date' });
      }
      if (outdoorToObj > today) {
        return res.status(400).json({ error: 'Outdoor duty "To" date cannot be in the future' });
      }

      const minOutdoorDate = new Date(today);
      minOutdoorDate.setDate(minOutdoorDate.getDate() - OUTDOOR_DUTY_LOOKBACK_DAYS);
      if (outdoorFromObj < minOutdoorDate) {
        return res.status(400).json({ error: `Outdoor duty cannot start more than ${OUTDOOR_DUTY_LOOKBACK_DAYS} days ago` });
      }

      // Invoice must belong to the trip: between the outdoor start and today.
      if (invoiceDateObj < outdoorFromObj || invoiceDateObj > today) {
        return res.status(400).json({ error: 'Invoice Date must fall within your outdoor duty period' });
      }
    } else {
      const minInvoiceDate = new Date(today);
      minInvoiceDate.setDate(minInvoiceDate.getDate() - INVOICE_DATE_LOOKBACK_DAYS);

      if (invoiceDateObj < minInvoiceDate || invoiceDateObj > today) {
        return res.status(400).json({ error: `Invoice Date must be within the last ${INVOICE_DATE_LOOKBACK_DAYS} days` });
      }
    }

    // ── Duplicate-invoice guard ──────────────────────────────────────────────
    // Block an exact re-submission (same supplier + invoice number + amount that
    // is not already rejected) — the classic accidental double-claim / double-pay.
    const dupMatches = findDuplicateVouchers({ supplier, invoiceNumber });
    const exactDup = dupMatches.find(d => Math.abs((parseFloat(d.basic_amount) || 0) - (parseFloat(basicAmount) || 0)) < 0.01);
    if (exactDup) {
      const dupId = exactDup.jcc_number || `JCC${String(exactDup.id).padStart(4, '0')}`;
      return res.status(409).json({
        error: `Duplicate claim: ${dupId} already exists for supplier "${supplier}", invoice "${invoiceNumber}" with the same amount (status: ${exactDup.status}). If this is genuinely a separate claim, please contact an administrator.`
      });
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

    const poRecord = poNumber
      ? db.prepare(`
          SELECT buyer_name, buyer_email, vendor_name
          FROM purchase_orders
          WHERE po_number = ?
          LIMIT 1
        `).get(poNumber)
      : null;

    // ── Backend PO Budget Guard ──────────────────────────────────────────────────
    // Block submission entirely if the selected PO has exceeded its budget,
    // OR if this new claim would push it over. Server-side safety net.
    if (poNumber) {
      const poRow = db.prepare(`SELECT CAST(total_budget AS REAL) as totalBudget FROM purchase_orders WHERE po_number = ? AND status != 'closed' LIMIT 1`).get(poNumber);
      if (poRow) {
        const usedRow = db.prepare(`SELECT COALESCE(SUM(CAST(basic_amount AS REAL)), 0) as usedAmount FROM voucher_requests WHERE po_number = ? AND status != 'rejected'`).get(poNumber);
        const totalBudget = poRow.totalBudget || 0;
        const usedAmount = usedRow?.usedAmount || 0;
        const thisClaimAmount = parseFloat(basicAmount) || 0;
        // Block if already exceeded OR if this claim would push it over
        if (totalBudget > 0 && (usedAmount >= totalBudget || (usedAmount + thisClaimAmount) > totalBudget)) {
          const remaining = totalBudget - usedAmount;
          return res.status(400).json({
            error: usedAmount >= totalBudget
              ? `PO ${poNumber} has already exceeded its approved budget (Used: ₹${usedAmount.toFixed(2)}, Total: ₹${totalBudget.toFixed(2)}). Please select a different PO.`
              : `This claim (₹${thisClaimAmount.toFixed(2)}) would exceed the PO budget. Remaining: ₹${remaining.toFixed(2)}, Total: ₹${totalBudget.toFixed(2)}. Please select a different PO or reduce the amount.`
          });
        }
      }
    }

    const buyerName = poRecord?.buyer_name || '';
    const buyerEmail = poRecord?.buyer_email || '';

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
          user_id, claimed_by, department, department_code, claimed_date,
          supplier, buyer_name, buyer_email, expense_booking_location, description,
          invoice_number, invoice_date, basic_amount, gross_amount,
          nature_of_expenses, po_number, project_code, project_name,
          project_amount, attachment_path,
          outdoor_duty, outdoor_from, outdoor_to, outdoor_remark,
          approver1_name, approver2_name,
          approver1_status, approver2_status,
          current_approval_level, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval_1')
      `).run(
      req.user.id,
      claimedBy,
      department,
      // Validated against the shared list rather than trusted: this is the code cost is
      // booked against, and an arbitrary string here misroutes it silently.
      VALID_DEPARTMENT_CODES.includes(String(departmentCode ?? '').trim())
        ? String(departmentCode).trim()
        : null,
      normalizedClaimedDate,
      supplier,
      buyerName,
      buyerEmail,
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
      isOutdoorDuty ? 1 : 0,           // outdoor_duty
      normalizedOutdoorFrom,           // outdoor_from (null when not outdoor)
      normalizedOutdoorTo,             // outdoor_to
      normalizedOutdoorRemark,         // outdoor_remark
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

    // Assign a unique financial-year-aware JCC number (e.g. JCC/25-26/0001)
    // This is stored in the DB and used everywhere — PDF header, emails, notifications.
    const jccNumber = assignJccNumber(voucherId);

    let finalMaterials = [...materialsArr];

    // Root cause fix: Automatically fetch the Description of Material seamlessly
    // from the attached PDF when the claim is submitted, exactly as requested by user.
    if (attachmentPath && attachmentPath.toLowerCase().endsWith('.pdf')) {
      try {
        const filePath = path.join(__dirname, '../uploads', attachmentPath);
        if (fs.existsSync(filePath)) {
          const data = await extractInvoiceData(filePath, 'application/pdf');
          if (data && data.lineItems) {
            const extractedItems = data.lineItems.filter(item => !item.isSummary);
            if (extractedItems.length > 0) {
              if (finalMaterials.length > 0) {
                 // Map descriptions to existing materials based on amount or index
                 finalMaterials = finalMaterials.map(mat => {
                    if (!mat.descriptionOfMaterial) {
                       const matAmountNum = parseFloat(String(mat.amount).replace(/[^0-9.-]/g, ''));
                       const match = extractedItems.find(item => {
                           const extAmt = parseFloat(String(item.amount).replace(/[^0-9.-]/g, ''));
                           return Math.abs(extAmt - matAmountNum) < 0.01;
                       });
                       if (match && (match.description || match.text)) {
                           return { ...mat, descriptionOfMaterial: match.description || match.text };
                       }
                    }
                    return mat;
                 });
              } else {
                 // Auto-populate all materials if none were provided
                 finalMaterials = extractedItems.map(item => ({
                    amount: item.amount ? String(item.amount).replace(/[^0-9.-]/g, '') : '',
                    projectCode: effectiveProjectCode || '',
                    projectName: effectiveProjectName || '',
                    descriptionOfMaterial: item.description || item.text || ''
                 }));
              }
            }
          }
        }
      } catch (err) {
        console.error('Auto-extraction during voucher creation failed:', err.message);
      }
    }

    if (finalMaterials.length > 0) {
      const stmt = db.prepare(`
        INSERT INTO voucher_materials (voucher_id, amount, project_code, project_name, description_of_material, quantity)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      // Use the voucher's main description as fallback when a material row has no description
      const voucherDescFallback = String(description || '').trim() || null;
      for (const item of finalMaterials) {
        const descValue = String(item.descriptionOfMaterial || '').trim() || voucherDescFallback;
        // Stored NULL rather than 0 when left blank: quantity is optional, and 0 would
        // read as "none were claimed" rather than "not stated".
        const qtyValue = String(item.quantity ?? '').trim() === '' ? null : Number(item.quantity);
        stmt.run(voucherId, item.amount || null, item.projectCode || null, item.projectName || null,
                 descValue, Number.isFinite(qtyValue) ? qtyValue : null);
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
      `Your JCC voucher ${jccNumber} for ${supplier} (₹${basicAmount}) has been submitted for approval.`,
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
        approver2Name: finalApproverName,
        // One-click approve link for the Level 1 manager (opens a confirmation page)
        approveLink: approvalLink(voucherId, 1, approver1User.id),
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
      jccNumber,
    });
  } catch (error) {
    console.error('Error creating voucher:', error);
    res.status(500).json({ error: 'Failed to create voucher request' });
  }
});

// Get voucher attachment file
router.get('/voucher-file/:id', authenticateToken, (req, res) => {
  try {
    const voucher = db.prepare('SELECT user_id, attachment_path, approver1_name, approver2_name FROM voucher_requests WHERE id = ?').get(req.params.id);

    if (!voucher || !voucher.attachment_path) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!canViewVoucher(req, voucher)) {
      return res.status(403).json({ error: 'Not authorized to view this file' });
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
    const voucher = db.prepare('SELECT user_id, approver1_name, approver2_name FROM voucher_requests WHERE id = ?').get(req.params.id);
    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }
    if (!canViewVoucher(req, voucher)) {
      return res.status(403).json({ error: 'Not authorized to download this JCC' });
    }
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
      // LEFT JOIN, not JOIN. An inner join drops the voucher entirely when its creator
      // no longer resolves — a claim would silently disappear from history because of
      // something done to somebody's account, which is the worst possible failure for a
      // financial record. Soft-deleting users mostly closed this, but a NULL or dangling
      // user_id from older data would still do it.
      vouchers = db.prepare(`
        SELECT v.*, COALESCE(u.name, v.claimed_by, 'Unknown user') as user_name
        FROM voucher_requests v
        LEFT JOIN users u ON v.user_id = u.id
        ORDER BY v.created_at DESC
      `).all();
    } else {
      vouchers = db.prepare(`
        SELECT v.*, COALESCE(u.name, v.claimed_by, 'Unknown user') as user_name
        FROM voucher_requests v
        LEFT JOIN users u ON v.user_id = u.id
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

// ─── GET /vouchers/:id ───────────────────────────────────────────────────────
// Returns a single voucher by ID (live, fresh from DB).
// Used by the frontend to get the current status before approve/reject.
router.get('/vouchers/:id', authenticateToken, (req, res) => {
  try {
    const voucherId = req.params.id;
    const voucher = db.prepare(`
      SELECT v.*, COALESCE(u.name, v.claimed_by, 'Unknown user') as user_name
      FROM voucher_requests v
      LEFT JOIN users u ON v.user_id = u.id
      WHERE v.id = ?
    `).get(voucherId);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    // Authorisation: own voucher, admin/coordinator, or assigned approver
    const isOwner = voucher.user_id === req.user.id;
    const isPrivileged = ['admin', 'coordinator', 'manager', 'final_approver'].includes(req.user.role);
    const userName = String(req.user.name || '').trim().toLowerCase();
    const isApprover1 = String(voucher.approver1_name || '').trim().toLowerCase() === userName;
    const isApprover2 = String(voucher.approver2_name || '').trim().toLowerCase() === userName;

    if (!isOwner && !isPrivileged && !isApprover1 && !isApprover2) {
      return res.status(403).json({ error: 'Not authorized to view this voucher' });
    }

    res.json(voucher);
  } catch (error) {
    console.error('Error fetching voucher:', error);
    res.status(500).json({ error: 'Failed to fetch voucher' });
  }
});

// ─── GET /my-approvals ────────────────────────────────────────────────────────
// Returns ONLY the vouchers where the logged-in user is the assigned approver
// at the current pending level. Uses DB-level LOWER() matching for reliability.
router.get('/my-approvals', authenticateToken, authorizeRoles('manager', 'final_approver', 'admin'), (req, res) => {
  try {
    const userName = String(req.user.name || '').trim();
    const role = req.user.role;
    let vouchers = [];

    if (role === 'manager' || role === 'admin') {
      // Manager sees vouchers at Level 1 assigned to them
      const level1 = db.prepare(`
        SELECT v.*, u.name as user_name
        FROM voucher_requests v
        JOIN users u ON v.user_id = u.id
        WHERE v.status = 'pending_approval_1'
          AND v.approver1_status = 'pending'
          AND LOWER(TRIM(v.approver1_name)) = LOWER(TRIM(?))
        ORDER BY v.created_at DESC
      `).all(userName);
      vouchers = [...vouchers, ...level1];
    }

    if (role === 'final_approver' || role === 'admin') {
      // Final approver sees vouchers at Level 2 assigned to them
      const level2 = db.prepare(`
        SELECT v.*, u.name as user_name
        FROM voucher_requests v
        JOIN users u ON v.user_id = u.id
        WHERE v.status = 'pending_approval_2'
          AND v.approver2_status = 'pending'
          AND v.approver1_status = 'approved'
          AND LOWER(TRIM(v.approver2_name)) = LOWER(TRIM(?))
        ORDER BY v.created_at DESC
      `).all(userName);
      vouchers = [...vouchers, ...level2];
    }

    // ── Delegated approvals ──────────────────────────────────────────────────
    // Also surface claims assigned to anyone who has an active delegation to me,
    // tagged so the UI can show "on behalf of <delegator>".
    const delegators = getActiveDelegatorsFor(req.user.id);
    const seen = new Set(vouchers.map(v => v.id));
    for (const d of delegators) {
      const dName = String(d.delegator_name || '').trim();
      if (!dName) continue;
      const rows = [];
      if (role === 'manager' || role === 'admin') {
        rows.push(...db.prepare(`
          SELECT v.*, u.name as user_name FROM voucher_requests v JOIN users u ON v.user_id = u.id
          WHERE v.status = 'pending_approval_1' AND v.approver1_status = 'pending'
            AND LOWER(TRIM(v.approver1_name)) = LOWER(TRIM(?)) ORDER BY v.created_at DESC
        `).all(dName));
      }
      if (role === 'final_approver' || role === 'admin') {
        rows.push(...db.prepare(`
          SELECT v.*, u.name as user_name FROM voucher_requests v JOIN users u ON v.user_id = u.id
          WHERE v.status = 'pending_approval_2' AND v.approver2_status = 'pending' AND v.approver1_status = 'approved'
            AND LOWER(TRIM(v.approver2_name)) = LOWER(TRIM(?)) ORDER BY v.created_at DESC
        `).all(dName));
      }
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        vouchers.push({ ...r, delegatedFrom: d.delegator_name });
      }
    }

    res.json(vouchers);
  } catch (error) {
    console.error('Error fetching my-approvals:', error);
    res.status(500).json({ error: 'Failed to fetch approvals' });
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

// Guard the single approve/reject endpoints: the caller must be the assigned
// approver for this level (or an admin, or an active delegate of that approver),
// and the claim must actually be awaiting that level's approval (blocks acting on
// an info_requested / already-actioned claim). Returns null if allowed, else an
// { code, error } to respond with.
const authorizeApprover = (req, voucher, level) => {
  if (voucher.status !== `pending_approval_${level}`) {
    return { code: 400, error: `This claim is not awaiting Level ${level} approval.` };
  }
  if (req.user.role === 'admin') return null;
  const userName = String(req.user.name || '').trim().toLowerCase();
  const assignedName = String((level === 1 ? voucher.approver1_name : voucher.approver2_name) || '').trim().toLowerCase();
  if (assignedName && assignedName === userName) return null;
  // Active out-of-office delegate of the assigned approver may also act
  const isDelegate = getActiveDelegatorsFor(req.user.id).some(
    (d) => String(d.delegator_name || '').trim().toLowerCase() === assignedName
  );
  if (isDelegate) return null;
  return { code: 403, error: 'This claim is assigned to a different approver.' };
};

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

    const authErr = authorizeApprover(req, voucher, 1);
    if (authErr) return res.status(authErr.code).json({ error: authErr.error });

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
          // One-click approve link for the Final Approver (Level 2)
          const nextApproverData = { ...voucherData, approveLink: approvalLink(voucher.id, 2, nextApprover.id) };
          notifyNextApprover(nextApproverData, creator, nextApprover)
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
router.post('/approve-level-2/:id', authenticateToken, authorizeRoles('final_approver'), async (req, res) => {
  try {
    const { remark } = req.body;
    const voucherId = req.params.id;

    // Check if voucher is at approval level 2 and level 1 is approved
    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    const authErr = authorizeApprover(req, voucher, 2);
    if (authErr) return res.status(authErr.code).json({ error: authErr.error });

    if (voucher.current_approval_level !== 2) {
      return res.status(400).json({ error: 'Voucher is not at approval level 2' });
    }

    if (voucher.approver1_status !== 'approved') {
      return res.status(400).json({ error: 'Approver 1 must approve first' });
    }

    // ── STEP 1: Update DB immediately (this is the critical operation) ─────────
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

    // ── STEP 2: Insert payment log (non-critical, wrapped safely) ──────────────
    try {
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
    } catch (logError) {
      console.error('[approve-level-2] Payment log insert failed (non-critical):', logError);
    }

    // ── STEP 3: Respond immediately — approver should NEVER wait for emails/PDFs ──
    res.json({
      message: 'Voucher fully approved by both approvers',
      voucherId: voucherId,
      downloadPdf: true
    });

    // ── STEP 4: Background post-processing (fire-and-forget) ─────────────────
    // Wrapped in an async IIFE so any failure here NEVER affects the response above.
    (async () => {
      try {
        const creator = db.prepare('SELECT id, name, email, ps_number FROM users WHERE id = ?').get(voucher.user_id);
        const manager = voucher.approver1_name ? findUserByName(voucher.approver1_name) : null;
        const approver = { name: req.user.name, email: req.user.email };
        const appBaseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

        // Re-read the stored jcc_number so emails always show the correct number
        const updatedVoucher = db.prepare('SELECT jcc_number FROM voucher_requests WHERE id = ?').get(voucherId);
        const jccDisplayId = updatedVoucher?.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`;

        const voucherData = {
          voucherId: voucher.id,
          voucherRequestId: jccDisplayId,
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

        // In-app notification for creator
        if (creator) {
          try {
            db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
              .run(
                creator.id,
                'JCC Successfully Approved! ✓',
                `Your JCC ${jccDisplayId} (${voucher.supplier}, ₹${voucher.basic_amount}) has been fully approved by ${req.user.name}. You can now download the JCC PDF.`,
                'success'
              );
          } catch (notifError) {
            console.error('[approve-level-2] In-app notification error:', notifError);
          }
        }

        // Buyer email with PDF attachment (only if buyer_email is present)
        const buyerEmail = String(voucher.buyer_email || '').trim();
        if (buyerEmail) {
          let pdfArtifact = null;
          try {
            pdfArtifact = await createVoucherPdfArtifact(voucher.id);
            const buyerPayload = {
              buyerName: voucher.buyer_name || 'Buyer',
              poNumber: voucher.po_number || '-',
              supplier: voucher.supplier || '-',
              amount: voucher.basic_amount || '-',
              invoiceNumber: voucher.invoice_number || '-',
              jccId: jccDisplayId,
              pdfLink: voucherData.jccLink || ''
            };

            await sendEmail(
              buyerEmail,
              (payload) => ({
                subject: `${payload.jccId} approved for PO ${payload.poNumber}`,
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #1f2937; line-height: 1.6;">
                    <p>Dear ${payload.buyerName},</p>
                    <p><strong>${payload.jccId}</strong> has been approved against PO <strong>${payload.poNumber}</strong>.</p>
                    <table style="border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px;">
                      <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Supplier</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${payload.supplier}</td></tr>
                      <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Invoice Number</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${payload.invoiceNumber}</td></tr>
                      <tr><td style="padding: 6px 10px; border: 1px solid #e5e7eb;"><strong>Amount</strong></td><td style="padding: 6px 10px; border: 1px solid #e5e7eb;">INR ${payload.amount}</td></tr>
                    </table>
                    <p>JCC PDF is attached for your reference.</p>
                    ${payload.pdfLink ? `<p>Download link: <a href="${payload.pdfLink}" style="color:#2563eb;">${payload.jccId} PDF</a></p>` : ''}
                  </div>
                `
              }),
              [buyerPayload],
              {
                entityType: 'buyer_notice',
                entityId: jccDisplayId,
                templateName: 'buyerJccApproved',
                attachments: [{
                  filename: pdfArtifact.downloadFilename,
                  path: pdfArtifact.pdfPath
                }]
              }
            );
          } catch (buyerEmailError) {
            console.error('[Email] Buyer approval email error:', buyerEmailError);
          } finally {
            try {
              if (pdfArtifact?.pdfPath && fs.existsSync(pdfArtifact.pdfPath)) {
                fs.unlinkSync(pdfArtifact.pdfPath);
              }
            } catch (cleanupError) {
              console.error('Error deleting buyer PDF attachment:', cleanupError);
            }
          }
        }
      } catch (bgError) {
        console.error('[approve-level-2] Background post-processing error (approval already saved):', bgError);
      }
    })();

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

    const authErr = authorizeApprover(req, voucher, 1);
    if (authErr) return res.status(authErr.code).json({ error: authErr.error });

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

    const authErr = authorizeApprover(req, voucher, 2);
    if (authErr) return res.status(authErr.code).json({ error: authErr.error });

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

    if (voucher.status !== 'rejected' && voucher.status !== 'recalled') {
      return res.status(400).json({ error: 'Only rejected or recalled claims can be resubmitted' });
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
        approval_nonce = COALESCE(approval_nonce, 0) + 1,
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

// ─── Recall a claim (by its creator or an admin) ─────────────────────────────
// Pulls a claim back so the raiser can fix a mistake and resubmit under the SAME
// JCC number. Puts it into an editable 'recalled' state; the existing resubmit
// flow then sends it back through approval (same row → PO counted once). Bumps the
// approval nonce so any outstanding email-approve links are invalidated.
router.post('/vouchers/:id/recall', authenticateToken, (req, res) => {
  try {
    const voucherId = req.params.id;
    const reason = String(req.body?.reason || '').trim();

    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });

    if (voucher.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only recall your own claim' });
    }
    // Can recall while the claim is still in the pipeline or already approved.
    if (!['pending_approval_1', 'pending_approval_2', 'approved'].includes(voucher.status)) {
      return res.status(400).json({ error: `A ${voucher.status} claim cannot be recalled` });
    }

    const jccId = voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`;

    // Move to the editable 'recalled' state; take it out of approval/payment queues.
    db.prepare(`
      UPDATE voucher_requests SET
        status = 'recalled',
        current_approval_level = NULL,
        payment_status = 'awaiting_approval',
        recall_reason = ?,
        recalled_by = ?,
        recalled_at = datetime('now'),
        approval_nonce = COALESCE(approval_nonce, 0) + 1
      WHERE id = ?
    `).run(reason || null, req.user.name, voucherId);

    // Audit trail (recall erases prior approvals — record who/when/why)
    try {
      db.prepare(`INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(req.user.id, req.user.name, 'RECALL_JCC', 'voucher_request', voucherId, `Recalled ${jccId}${reason ? ` — ${reason}` : ''}`);
    } catch (e) { console.error('[recall] audit log failed:', e); }

    // Notify the assigned approvers that the claim was pulled back
    try {
      [voucher.approver1_name, voucher.approver2_name].forEach((name) => {
        const appr = name ? findUserByName(name) : null;
        if (appr) {
          db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
            .run(appr.id, 'JCC recalled by claimant', `${req.user.name} recalled ${jccId} to make changes${reason ? ` (${reason})` : ''}. It will return for your approval after they resubmit.`, 'warning');
        }
      });
    } catch (e) { console.error('[recall] notify failed:', e); }

    res.json({ message: `${jccId} recalled. Edit it and resubmit — it keeps the same number and goes back for approval.` });
  } catch (error) {
    console.error('Error recalling voucher:', error);
    res.status(500).json({ error: 'Failed to recall claim' });
  }
});

// ─── "Request more info" (soft-return) ───────────────────────────────────────
// Approver sends the claim back to the claimant with a question, WITHOUT rejecting.
// The claim keeps all its data + any prior-level approval, and returns to the same
// approver once the claimant responds.
router.post('/request-info/:id', authenticateToken, authorizeRoles('manager', 'final_approver', 'admin'), (req, res) => {
  try {
    const voucherId = req.params.id;
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Please add a note describing what you need' });

    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });

    const level = voucher.current_approval_level;
    const role = req.user.role;
    const userName = String(req.user.name || '').trim().toLowerCase();
    const isA1 = String(voucher.approver1_name || '').trim().toLowerCase() === userName;
    const isA2 = String(voucher.approver2_name || '').trim().toLowerCase() === userName;
    const canL1 = level === 1 && voucher.status === 'pending_approval_1' && (role === 'manager' || role === 'admin') && (isA1 || role === 'admin');
    const canL2 = level === 2 && voucher.status === 'pending_approval_2' && (role === 'final_approver' || role === 'admin') && (isA2 || role === 'admin');
    if (!canL1 && !canL2) {
      return res.status(400).json({ error: 'This claim is not awaiting your review right now' });
    }

    db.prepare(`UPDATE voucher_requests SET status='info_requested', info_requested_level=?, info_request_note=?, info_request_by=?, info_request_at=datetime('now'), info_response_note=NULL WHERE id=?`)
      .run(level, note, req.user.name, voucherId);

    const jccId = voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`;
    const creator = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(voucher.user_id);
    if (creator) {
      db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
        .run(creator.id, 'More info needed on your JCC', `${req.user.name} needs more info on ${jccId}: "${note}"`, 'warning');
      if (creator.email) {
        try {
          sendEmail(creator.email, () => ({
            subject: `${jccId} — More information needed before approval`,
            html: `<p><strong>${req.user.name}</strong> has requested more information on <strong>${jccId}</strong> before approving it:</p>
                   <blockquote style="border-left:3px solid #f59e0b; padding-left:12px; color:#334155;">${note}</blockquote>
                   <p>Please open the portal, update the claim if needed, and resend it — your claim is preserved and goes straight back to the same approver.</p>`,
          }), [voucher], { entityType: 'jcc', entityId: jccId, templateName: 'jccInfoRequested' })
            .catch(err => console.error('[Email] info-request failed:', err));
        } catch (e) { console.error('[Email] info-request error:', e); }
      }
    }

    res.json({ message: `Sent back to ${creator?.name || 'the claimant'} for more info` });
  } catch (error) {
    console.error('Error requesting info:', error);
    res.status(500).json({ error: 'Failed to request info' });
  }
});

// Claimant responds to an info request and resends to the SAME approver/level.
// Preserves any earlier-level approval (e.g. if L2 asked, L1 stays approved).
router.post('/vouchers/:id/respond-info', authenticateToken, (req, res) => {
  try {
    const voucherId = req.params.id;
    const { description, gross_amount, basic_amount, po_number, invoice_number, responseNote } = req.body || {};

    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
    if (voucher.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to respond to this claim' });
    }
    if (voucher.status !== 'info_requested') {
      return res.status(400).json({ error: 'This claim is not awaiting your input' });
    }

    const returnLevel = Number(voucher.info_requested_level) === 2 ? 2 : 1;
    const note = String(responseNote || '').trim();
    const merged = {
      description: description !== undefined ? description : voucher.description,
      gross_amount: gross_amount || voucher.gross_amount,
      basic_amount: basic_amount || voucher.basic_amount,
      po_number: po_number || voucher.po_number,
      invoice_number: invoice_number || voucher.invoice_number,
    };

    if (returnLevel === 2) {
      db.prepare(`UPDATE voucher_requests SET description=?, gross_amount=?, basic_amount=?, po_number=?, invoice_number=?, info_response_note=?, status='pending_approval_2', current_approval_level=2, approver2_status='pending', approver2_remark=NULL, approver2_date=NULL, approval_nonce=COALESCE(approval_nonce,0)+1 WHERE id=?`)
        .run(merged.description, merged.gross_amount, merged.basic_amount, merged.po_number, merged.invoice_number, note, voucherId);
    } else {
      db.prepare(`UPDATE voucher_requests SET description=?, gross_amount=?, basic_amount=?, po_number=?, invoice_number=?, info_response_note=?, status='pending_approval_1', current_approval_level=1, approver1_status='pending', approver1_remark=NULL, approver1_date=NULL, approval_nonce=COALESCE(approval_nonce,0)+1 WHERE id=?`)
        .run(merged.description, merged.gross_amount, merged.basic_amount, merged.po_number, merged.invoice_number, note, voucherId);
    }

    const approverName = returnLevel === 2 ? voucher.approver2_name : voucher.approver1_name;
    const approver = findUserByName(approverName);
    const jccId = voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`;
    if (approver) {
      db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
        .run(approver.id, 'Claimant responded — ready for review', `${req.user.name} responded on ${jccId} and resent it for your approval.${note ? ` Note: "${note}"` : ''}`, 'info');
    }

    res.json({ message: 'Response sent — your claim is back with the approver' });
  } catch (error) {
    console.error('Error responding to info request:', error);
    res.status(500).json({ error: 'Failed to send response' });
  }
});

// ─── Claimant nudge: "Remind approver" ───────────────────────────────────────
// Lets the person waiting ping the current approver (in-app + email).
// Rate-limited to once per day per claim, and logged for the audit/escalation trail.
router.post('/vouchers/:id/remind', authenticateToken, (req, res) => {
  try {
    const voucherId = req.params.id;
    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
    if (voucher.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only remind on your own claims' });
    }
    if (!['pending_approval_1', 'pending_approval_2'].includes(voucher.status)) {
      return res.status(400).json({ error: 'This claim is not awaiting approval right now' });
    }

    const level = Number(voucher.current_approval_level) === 2 ? 2 : 1;

    // A reminder is only allowed once the current approver has actually held the
    // claim for REMIND_MIN_DAYS. Measure from when it reached this approver:
    // submission (created_at) for Level 1, or Level-1 approval for Level 2.
    // Computed in SQL (julianday) so it is timezone-safe (both values are UTC).
    const REMIND_MIN_DAYS = 3;
    const sinceDate = level === 2 ? (voucher.approver1_date || voucher.created_at) : voucher.created_at;
    const waitedRow = db.prepare(`SELECT (julianday('now') - julianday(?)) AS d`).get(sinceDate);
    const waitedDays = Math.floor(Number(waitedRow?.d) || 0);
    if (waitedDays < REMIND_MIN_DAYS) {
      return res.status(400).json({ error: `You can remind the approver after ${REMIND_MIN_DAYS} days. This claim has been with the approver for ${waitedDays} day${waitedDays === 1 ? '' : 's'}.` });
    }

    // Rate-limit: one reminder per claim per day
    const already = db.prepare(`SELECT id FROM jcc_reminder_nudges WHERE voucher_id = ? AND date(created_at) = date('now') LIMIT 1`).get(voucherId);
    if (already) {
      return res.status(429).json({ error: 'You already reminded the approver today. Please try again tomorrow.' });
    }

    const approverName = level === 2 ? voucher.approver2_name : voucher.approver1_name;
    const approver = findUserByName(approverName);
    const jccId = voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`;

    if (!approver) {
      return res.status(400).json({ error: 'Could not find the current approver to remind' });
    }

    // Log the nudge (audit + rate-limit + feeds escalation later)
    db.prepare(`INSERT INTO jcc_reminder_nudges (voucher_id, reminded_by_id, reminded_by_name, approver_name, level) VALUES (?, ?, ?, ?, ?)`)
      .run(voucherId, req.user.id, req.user.name, approver.name, level);

    // In-app notification
    db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
      .run(approver.id, 'Reminder: JCC pending your approval', `${req.user.name} is waiting on ${jccId} — it is still pending your ${level === 2 ? 'final ' : ''}approval.`, 'warning');

    // Best-effort email
    if (approver.email) {
      try {
        sendEmail(approver.email, () => ({
          subject: `Reminder: ${jccId} is still pending your approval`,
          html: `<p><strong>${req.user.name}</strong> is waiting on <strong>${jccId}</strong>, which is still pending your ${level === 2 ? 'final ' : ''}approval.</p>
                 <p>Supplier: ${voucher.supplier || '-'} · Amount: ₹${Number(voucher.basic_amount || 0).toLocaleString('en-IN')}</p>
                 <p>Please review it in the portal when you get a moment.</p>`,
        }), [voucher], { entityType: 'jcc', entityId: jccId, templateName: 'jccManualReminder' })
          .catch(err => console.error('[Email] manual reminder failed:', err));
      } catch (e) { console.error('[Email] manual reminder error:', e); }
    }

    res.json({ message: `Reminder sent to ${approver.name}` });
  } catch (error) {
    console.error('Error sending reminder:', error);
    res.status(500).json({ error: 'Failed to send reminder' });
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

// ─── GET /vouchers/:id/materials-list ────────────────────────────────────────
// Returns all material rows for a single voucher (owner or admin/coordinator).
router.get('/vouchers/:id/materials-list', authenticateToken, (req, res) => {
  try {
    const voucherId = req.params.id;
    const voucher = db.prepare('SELECT user_id FROM voucher_requests WHERE id = ?').get(voucherId);
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });

    const isOwner = voucher.user_id === req.user.id;
    const isPrivileged = ['admin', 'coordinator', 'manager', 'final_approver'].includes(req.user.role);
    if (!isOwner && !isPrivileged) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const materials = db.prepare(`
      SELECT id, amount, project_code, project_name, description_of_material, quantity
      FROM voucher_materials WHERE voucher_id = ? ORDER BY id ASC
    `).all(voucherId);

    return res.json({ materials });
  } catch (error) {
    console.error('Error fetching materials list:', error);
    return res.status(500).json({ error: 'Failed to fetch materials' });
  }
});

// ─── POST /vouchers/:id/auto-extract-materials ───────────────────────────────
// Extracts line items from the attached invoice and attempts to map them to materials
router.post('/vouchers/:id/auto-extract-materials', authenticateToken, async (req, res) => {
  try {
    const voucherId = req.params.id;
    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });

    const isOwner = voucher.user_id === req.user.id;
    const isPrivileged = ['admin', 'coordinator', 'manager', 'final_approver'].includes(req.user.role);
    if (!isOwner && !isPrivileged) return res.status(403).json({ error: 'Not authorized' });

    if (!voucher.attachment_path) return res.status(400).json({ error: 'No invoice attached to this voucher' });
    const filePath = path.join(__dirname, '../../uploads', voucher.attachment_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attached invoice file not found' });

    const data = await extractInvoiceData(filePath, 'application/pdf');
    if (!data || !data.lineItems) return res.json({ materials: [] });

    const extractedItems = data.lineItems.filter(item => !item.isSummary);
    const materials = extractedItems.map(item => ({
      descriptionOfMaterial: item.description || item.text || '',
      amount: item.amount ? String(item.amount).replace(/[^0-9.-]/g, '') : '',
      projectCode: voucher.project_code || '',
      projectName: voucher.project_name || ''
    }));

    res.json({ materials });
  } catch (error) {
    console.error('Error auto-extracting materials:', error);
    res.status(500).json({ error: 'Failed to extract materials from invoice' });
  }
});

// ─── PUT /vouchers/:id/materials ─────────────────────────────────────────────

// Update material rows for an existing voucher (owner or admin/coordinator).
// Allows filling in description_of_material for vouchers created before the fix.
router.put('/vouchers/:id/materials', authenticateToken, async (req, res) => {
  try {
    const voucherId = req.params.id;
    const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(voucherId);

    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });

    // Only owner or admin/coordinator can update materials
    const isOwner = voucher.user_id === req.user.id;
    const isPrivileged = ['admin', 'coordinator'].includes(req.user.role);
    if (!isOwner && !isPrivileged) {
      return res.status(403).json({ error: 'Not authorized to update this voucher' });
    }

    const materials = req.body?.materials;
    if (!Array.isArray(materials) || materials.length === 0) {
      return res.status(400).json({ error: 'materials array is required' });
    }

    // Get existing material IDs for this voucher (ordered by id)
    const existingRows = db.prepare(
      'SELECT id FROM voucher_materials WHERE voucher_id = ? ORDER BY id ASC'
    ).all(voucherId);

    const updateStmt = db.prepare(
      'UPDATE voucher_materials SET description_of_material = ?, project_code = ?, project_name = ?, amount = ?, quantity = ? WHERE id = ?'
    );

    // Update each row by position; if frontend sends more rows than DB, insert them
    const insertStmt = db.prepare(
      'INSERT INTO voucher_materials (voucher_id, amount, project_code, project_name, description_of_material, quantity) VALUES (?, ?, ?, ?, ?, ?)'
    );

    materials.forEach((mat, i) => {
      const desc = String(mat.descriptionOfMaterial ?? mat.description_of_material ?? '').trim();
      const projCode = String(mat.projectCode ?? mat.project_code ?? '').trim();
      const projName = String(mat.projectName ?? mat.project_name ?? '').trim();
      const amount = String(mat.amount ?? '').trim();
      // Blank stays NULL rather than becoming 0 — "not stated" and "none" are different.
      const rawQty = String(mat.quantity ?? '').trim();
      const qty = rawQty === '' || !Number.isFinite(Number(rawQty)) ? null : Number(rawQty);

      if (i < existingRows.length) {
        updateStmt.run(desc || null, projCode || null, projName || null, amount || null, qty, existingRows[i].id);
      } else {
        insertStmt.run(voucherId, amount || null, projCode || null, projName || null, desc || null, qty);
      }
    });

    // Audit log
    db.prepare(
      'INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      req.user.id, req.user.name, 'UPDATE_MATERIALS', 'voucher_request', voucherId,
      `Updated ${materials.length} material rows for voucher ${formatJccId(Number(voucherId))}`
    );

    return res.json({ success: true, message: 'Materials updated successfully' });
  } catch (error) {
    console.error('Error updating voucher materials:', error);
    return res.status(500).json({ error: 'Failed to update materials' });
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

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

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

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

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

// ════════════════════════════════════════════════════════════════════════════
// PRODUCTIVITY FEATURES — drafts, clone/autofill, bulk approve, pending actions,
// global search. All additive; none alter the existing approval money-path.
// ════════════════════════════════════════════════════════════════════════════

// Map a voucher_requests row → camelCase prefill object matching the request form.
const mapVoucherToPrefill = (v) => ({
  supplier: v.supplier || '',
  buyerName: v.buyer_name || '',
  buyerEmail: v.buyer_email || '',
  department: v.department || '',
  expenseBookingLocation: v.expense_booking_location || '',
  natureOfExpenses: v.nature_of_expenses || '',
  poNumber: v.po_number || '',
  projectCode: v.project_code || '',
  projectName: v.project_name || '',
  approver1: v.approver1_name || '',
  approver2: v.approver2_name || '',
});

const PRIVILEGED_ROLES = ['admin', 'coordinator', 'manager', 'final_approver'];

// Find non-rejected vouchers with the same supplier + invoice number (case/space
// insensitive). Used for duplicate-invoice detection.
const findDuplicateVouchers = ({ supplier, invoiceNumber, excludeId }) => {
  const s = String(supplier || '').trim();
  const inv = String(invoiceNumber || '').trim();
  if (!s || !inv) return [];
  let rows = db.prepare(`
    SELECT id, jcc_number, supplier, invoice_number, basic_amount, status, created_at, user_id
    FROM voucher_requests
    WHERE LOWER(TRIM(supplier)) = LOWER(TRIM(?))
      AND LOWER(TRIM(invoice_number)) = LOWER(TRIM(?))
      AND status != 'rejected'
    ORDER BY created_at DESC
  `).all(s, inv);
  if (excludeId) rows = rows.filter(r => r.id !== Number(excludeId));
  return rows;
};

// Today's date as YYYY-MM-DD via SQLite (keeps timezone consistent with date('now'))
const isoToday = () => db.prepare(`SELECT date('now') AS d`).get()?.d || '';

// Users who have delegated their approval authority TO `userId` and whose window
// is active today. Returns [{ delegator_id, delegator_name }].
const getActiveDelegatorsFor = (userId) => {
  return db.prepare(`
    SELECT delegator_id, delegator_name
    FROM approval_delegations
    WHERE delegate_id = ? AND date('now') BETWEEN from_date AND to_date
  `).all(userId);
};

// ─── Drafts ───────────────────────────────────────────────────────────────────
// Save (create or update) a draft. Body: { id?, title?, formData }
router.post('/drafts', authenticateToken, (req, res) => {
  try {
    const { id, title, formData } = req.body || {};
    if (!formData || typeof formData !== 'object') {
      return res.status(400).json({ error: 'formData is required' });
    }
    const json = JSON.stringify(formData);
    const draftTitle = String(title || formData.supplier || 'Untitled draft').slice(0, 120);

    if (id) {
      // Update only if the draft belongs to this user
      const existing = db.prepare('SELECT id FROM voucher_drafts WHERE id = ? AND user_id = ?').get(id, req.user.id);
      if (!existing) {
        return res.status(404).json({ error: 'Draft not found' });
      }
      db.prepare(`UPDATE voucher_drafts SET title = ?, form_data = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
        .run(draftTitle, json, id, req.user.id);
      return res.json({ id, message: 'Draft updated' });
    }

    const result = db.prepare(`INSERT INTO voucher_drafts (user_id, title, form_data) VALUES (?, ?, ?)`)
      .run(req.user.id, draftTitle, json);
    const newId = Number(result.lastInsertRowid) || db.prepare('SELECT last_insert_rowid() AS id').get()?.id;
    res.json({ id: newId, message: 'Draft saved' });
  } catch (error) {
    console.error('Error saving draft:', error);
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

// List current user's drafts (newest first)
router.get('/drafts', authenticateToken, (req, res) => {
  try {
    const drafts = db.prepare(`SELECT id, title, updated_at FROM voucher_drafts WHERE user_id = ? ORDER BY updated_at DESC`).all(req.user.id);
    res.json(drafts);
  } catch (error) {
    console.error('Error listing drafts:', error);
    res.status(500).json({ error: 'Failed to list drafts' });
  }
});

// Get a single draft (with parsed form data)
router.get('/drafts/:id', authenticateToken, (req, res) => {
  try {
    const draft = db.prepare(`SELECT id, title, form_data, updated_at FROM voucher_drafts WHERE id = ? AND user_id = ?`).get(req.params.id, req.user.id);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    let formData = {};
    try { formData = JSON.parse(draft.form_data); } catch { formData = {}; }
    res.json({ id: draft.id, title: draft.title, updatedAt: draft.updated_at, formData });
  } catch (error) {
    console.error('Error fetching draft:', error);
    res.status(500).json({ error: 'Failed to fetch draft' });
  }
});

// Delete a draft
router.delete('/drafts/:id', authenticateToken, (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM voucher_drafts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    db.prepare('DELETE FROM voucher_drafts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ message: 'Draft deleted' });
  } catch (error) {
    console.error('Error deleting draft:', error);
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

// ─── Clone / smart autofill ─────────────────────────────────────────────────
// Prefill data to clone an existing voucher into a new claim. Invoice-specific
// fields (number, date, amounts) are intentionally left blank to re-enter.
router.get('/vouchers/:id/clone-data', authenticateToken, (req, res) => {
  try {
    const v = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(req.params.id);
    if (!v) {
      return res.status(404).json({ error: 'Voucher not found' });
    }
    const isOwner = v.user_id === req.user.id;
    if (!isOwner && !PRIVILEGED_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized to clone this voucher' });
    }
    res.json({ prefill: mapVoucherToPrefill(v) });
  } catch (error) {
    console.error('Error building clone data:', error);
    res.status(500).json({ error: 'Failed to build clone data' });
  }
});

// Most recent voucher created by the current user, as prefill (for "Repeat last claim")
router.get('/last-claim', authenticateToken, (req, res) => {
  try {
    const v = db.prepare('SELECT * FROM voucher_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
    if (!v) {
      return res.json({ prefill: null });
    }
    res.json({ prefill: mapVoucherToPrefill(v), fromJcc: v.jcc_number || `JCC${String(v.id).padStart(4, '0')}` });
  } catch (error) {
    console.error('Error fetching last claim:', error);
    res.status(500).json({ error: 'Failed to fetch last claim' });
  }
});

// Chained autofill: given a supplier, return the PO/buyer/project/approvers from
// the current user's most recent claim for that supplier.
router.get('/last-used-by-vendor', authenticateToken, (req, res) => {
  try {
    const supplier = String(req.query.supplier || '').trim();
    if (!supplier) {
      return res.status(400).json({ error: 'supplier is required' });
    }
    const v = db.prepare(`
      SELECT * FROM voucher_requests
      WHERE user_id = ? AND LOWER(TRIM(supplier)) = LOWER(TRIM(?))
      ORDER BY created_at DESC LIMIT 1
    `).get(req.user.id, supplier);
    if (!v) {
      return res.json({ prefill: null });
    }
    res.json({ prefill: mapVoucherToPrefill(v) });
  } catch (error) {
    console.error('Error fetching last-used-by-vendor:', error);
    res.status(500).json({ error: 'Failed to fetch vendor defaults' });
  }
});

// ─── Bulk approve / reject ───────────────────────────────────────────────────
// Applies the same DB transitions as the single-approval endpoints, per voucher,
// at whichever level the current user is authorised for. Skips anything not
// assigned to them or not at the right level, and reports per-id results.
const bulkProcess = (req, res, mode /* 'approve' | 'reject' */) => {
  try {
    const { ids, remark } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    if (mode === 'reject' && !String(remark || '').trim()) {
      return res.status(400).json({ error: 'A remark is required when rejecting' });
    }

    const role = req.user.role;
    const userName = String(req.user.name || '').trim().toLowerCase();
    const results = [];

    for (const rawId of ids) {
      const id = Number(rawId);
      const v = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(id);
      if (!v) { results.push({ id: rawId, ok: false, reason: 'not found' }); continue; }

      const level = v.current_approval_level;
      const isApprover1 = String(v.approver1_name || '').trim().toLowerCase() === userName;
      const isApprover2 = String(v.approver2_name || '').trim().toLowerCase() === userName;

      // Determine if this user may act on this voucher at its current level
      const canLevel1 = level === 1 && v.status === 'pending_approval_1' && (isApprover1 || role === 'admin') && (role === 'manager' || role === 'admin');
      const canLevel2 = level === 2 && v.status === 'pending_approval_2' && v.approver1_status === 'approved' && (isApprover2 || role === 'admin') && (role === 'final_approver' || role === 'admin');

      if (!canLevel1 && !canLevel2) {
        results.push({ id: rawId, ok: false, reason: 'not actionable by you at its current stage' });
        continue;
      }

      const creator = db.prepare('SELECT id, name, email, ps_number FROM users WHERE id = ?').get(v.user_id);
      const jccDisplayId = v.jcc_number || `JCC${String(v.id).padStart(4, '0')}`;

      try {
        if (mode === 'approve' && canLevel1) {
          db.prepare(`UPDATE voucher_requests SET approver1_status='approved', approver1_remark=?, approver1_date=datetime('now'), approver2_status='pending', current_approval_level=2, status='pending_approval_2' WHERE id=?`)
            .run(remark || 'Bulk approved', id);
          // Notify next approver + creator in-app (best effort)
          if (v.approver2_name) {
            const nextApprover = findUserByName(v.approver2_name);
            if (nextApprover) {
              db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
                .run(nextApprover.id, 'Action Required: JCC Final Approval', `JCC ${jccDisplayId} has passed Level 1 and needs your final approval.`, 'warning');
            }
          }
          if (creator) {
            db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
              .run(creator.id, 'JCC Approved at Level 1', `Your JCC ${jccDisplayId} was approved by ${req.user.name} (Level 1) and is pending Final Approval.`, 'info');
          }
          results.push({ id: rawId, ok: true, action: 'approved-level-1' });
        } else if (mode === 'approve' && canLevel2) {
          db.prepare(`UPDATE voucher_requests SET approver2_status='approved', approver2_remark=?, approver2_date=datetime('now'), current_approval_level=NULL, status='approved', payment_status='pending_payment' WHERE id=?`)
            .run(remark || 'Bulk approved', id);
          try {
            insertPaymentLog({ voucherId: id, oldStatus: v.payment_status || 'awaiting_approval', newStatus: 'pending_payment', referenceNo: null, amount: v.basic_amount, remarks: 'Bulk approved (Level 2) and moved to payment queue', actionSource: 'bulk_approval_level_2', user: req.user });
          } catch (e) { console.error('[bulk] payment log failed (non-critical):', e); }
          if (creator) {
            db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
              .run(creator.id, 'JCC Fully Approved', `Your JCC ${jccDisplayId} has been fully approved.`, 'success');
          }
          results.push({ id: rawId, ok: true, action: 'approved-level-2' });
        } else if (mode === 'reject') {
          const isLevel1 = canLevel1;
          db.prepare(`UPDATE voucher_requests SET ${isLevel1 ? "approver1_status='rejected', approver1_remark=?, approver1_date=datetime('now')" : "approver2_status='rejected', approver2_remark=?, approver2_date=datetime('now')"}, current_approval_level=NULL, status='rejected' WHERE id=?`)
            .run(remark, id);
          if (creator) {
            db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
              .run(creator.id, 'JCC Rejected', `Your JCC ${jccDisplayId} was rejected by ${req.user.name}. Reason: ${remark}`, 'error');
          }
          results.push({ id: rawId, ok: true, action: isLevel1 ? 'rejected-level-1' : 'rejected-level-2' });
        }
      } catch (opErr) {
        console.error(`[bulk ${mode}] failed for voucher ${id}:`, opErr);
        results.push({ id: rawId, ok: false, reason: 'update failed' });
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    res.json({ message: `${succeeded} of ${ids.length} ${mode === 'approve' ? 'approved' : 'rejected'}`, succeeded, total: ids.length, results });
  } catch (error) {
    console.error(`Error in bulk ${mode}:`, error);
    res.status(500).json({ error: `Failed to bulk ${mode}` });
  }
};

router.post('/bulk-approve', authenticateToken, authorizeRoles('manager', 'final_approver', 'admin'), (req, res) => bulkProcess(req, res, 'approve'));
router.post('/bulk-reject', authenticateToken, authorizeRoles('manager', 'final_approver', 'admin'), (req, res) => bulkProcess(req, res, 'reject'));

// ─── My Pending Actions (home widget) ────────────────────────────────────────
router.get('/pending-actions', authenticateToken, (req, res) => {
  try {
    const role = req.user.role;
    const userName = String(req.user.name || '').trim();
    let toApprove = 0;

    if (role === 'manager' || role === 'admin') {
      toApprove += db.prepare(`SELECT COUNT(*) AS c FROM voucher_requests WHERE status='pending_approval_1' AND approver1_status='pending' AND LOWER(TRIM(approver1_name)) = LOWER(TRIM(?))`).get(userName)?.c || 0;
    }
    if (role === 'final_approver' || role === 'admin') {
      toApprove += db.prepare(`SELECT COUNT(*) AS c FROM voucher_requests WHERE status='pending_approval_2' AND approver2_status='pending' AND approver1_status='approved' AND LOWER(TRIM(approver2_name)) = LOWER(TRIM(?))`).get(userName)?.c || 0;
    }

    // Include approvals delegated to me (active out-of-office cover)
    let delegated = 0;
    for (const d of getActiveDelegatorsFor(req.user.id)) {
      const dName = String(d.delegator_name || '').trim();
      if (!dName) continue;
      if (role === 'manager' || role === 'admin') {
        delegated += db.prepare(`SELECT COUNT(*) AS c FROM voucher_requests WHERE status='pending_approval_1' AND approver1_status='pending' AND LOWER(TRIM(approver1_name)) = LOWER(TRIM(?))`).get(dName)?.c || 0;
      }
      if (role === 'final_approver' || role === 'admin') {
        delegated += db.prepare(`SELECT COUNT(*) AS c FROM voucher_requests WHERE status='pending_approval_2' AND approver2_status='pending' AND approver1_status='approved' AND LOWER(TRIM(approver2_name)) = LOWER(TRIM(?))`).get(dName)?.c || 0;
      }
    }
    toApprove += delegated;

    const drafts = db.prepare('SELECT COUNT(*) AS c FROM voucher_drafts WHERE user_id = ?').get(req.user.id)?.c || 0;
    const rejected = db.prepare(`SELECT COUNT(*) AS c FROM voucher_requests WHERE user_id = ? AND status = 'rejected'`).get(req.user.id)?.c || 0;
    const pendingMine = db.prepare(`SELECT COUNT(*) AS c FROM voucher_requests WHERE user_id = ? AND status IN ('pending_approval_1','pending_approval_2')`).get(req.user.id)?.c || 0;
    const needsMyInput = db.prepare(`SELECT COUNT(*) AS c FROM voucher_requests WHERE user_id = ? AND status = 'info_requested'`).get(req.user.id)?.c || 0;

    res.json({ toApprove, drafts, rejected, pendingMine, needsMyInput });
  } catch (error) {
    console.error('Error fetching pending actions:', error);
    res.status(500).json({ error: 'Failed to fetch pending actions' });
  }
});

// ─── Global search ───────────────────────────────────────────────────────────
router.get('/search', authenticateToken, (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ results: [] });
    }
    const like = `%${q}%`;
    const privileged = PRIVILEGED_ROLES.includes(req.user.role);
    const base = `
      SELECT v.id, v.jcc_number, v.supplier, v.invoice_number, v.basic_amount, v.status, v.created_at
      FROM voucher_requests v
      WHERE (v.jcc_number LIKE ? OR v.supplier LIKE ? OR v.invoice_number LIKE ?)
    `;
    const rows = privileged
      ? db.prepare(`${base} ORDER BY v.created_at DESC LIMIT 20`).all(like, like, like)
      : db.prepare(`${base} AND v.user_id = ? ORDER BY v.created_at DESC LIMIT 20`).all(like, like, like, req.user.id);

    res.json({ results: rows.map(r => ({
      id: r.id,
      jccNumber: r.jcc_number || `JCC${String(r.id).padStart(4, '0')}`,
      supplier: r.supplier,
      invoiceNumber: r.invoice_number,
      basicAmount: r.basic_amount,
      status: r.status,
      createdAt: r.created_at,
    })) });
  } catch (error) {
    console.error('Error in global search:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── Duplicate invoice check ─────────────────────────────────────────────────
// Proactive (non-blocking) lookup the form calls as the user types, to warn early.
router.get('/check-duplicate', authenticateToken, (req, res) => {
  try {
    const matches = findDuplicateVouchers({ supplier: req.query.supplier, invoiceNumber: req.query.invoiceNumber });
    const amount = parseFloat(req.query.amount);
    res.json({
      duplicates: matches.map(m => ({
        id: m.id,
        jccNumber: m.jcc_number || `JCC${String(m.id).padStart(4, '0')}`,
        supplier: m.supplier,
        invoiceNumber: m.invoice_number,
        amount: m.basic_amount,
        status: m.status,
        createdAt: m.created_at,
        sameAmount: !Number.isNaN(amount) && Math.abs((parseFloat(m.basic_amount) || 0) - amount) < 0.01,
      })),
    });
  } catch (error) {
    console.error('Error checking duplicate:', error);
    res.status(500).json({ error: 'Duplicate check failed' });
  }
});

// ─── Approver delegation (out-of-office) ─────────────────────────────────────
// Create a delegation (current user delegates their approvals to someone else)
router.post('/delegations', authenticateToken, authorizeRoles('manager', 'final_approver', 'admin'), (req, res) => {
  try {
    const { delegateName, fromDate, toDate, reason } = req.body || {};
    const delegate = findUserByName(delegateName);
    if (!delegate) {
      return res.status(400).json({ error: 'Please choose a valid person to delegate to' });
    }
    if (delegate.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delegate to yourself' });
    }
    const from = String(fromDate || '').trim();
    const to = String(toDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Valid From and To dates are required' });
    }
    if (from > to) {
      return res.status(400).json({ error: 'From date cannot be after To date' });
    }
    const result = db.prepare(`
      INSERT INTO approval_delegations (delegator_id, delegator_name, delegate_id, delegate_name, from_date, to_date, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, req.user.name, delegate.id, delegate.name, from, to, String(reason || '').trim());
    const newId = Number(result.lastInsertRowid) || db.prepare('SELECT last_insert_rowid() AS id').get()?.id;

    // Let the delegate know in-app
    db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
      .run(delegate.id, 'Approvals delegated to you', `${req.user.name} has delegated their approvals to you from ${from} to ${to}.`, 'info');

    res.json({ id: newId, message: `Approvals delegated to ${delegate.name} (${from} → ${to})` });
  } catch (error) {
    console.error('Error creating delegation:', error);
    res.status(500).json({ error: 'Failed to create delegation' });
  }
});

// List delegations relevant to the current user (ones they created + ones to them)
router.get('/delegations', authenticateToken, (req, res) => {
  try {
    const asDelegator = db.prepare(`SELECT * FROM approval_delegations WHERE delegator_id = ? ORDER BY from_date DESC`).all(req.user.id);
    const asDelegate = db.prepare(`SELECT * FROM approval_delegations WHERE delegate_id = ? ORDER BY from_date DESC`).all(req.user.id);
    const withActive = (rows) => rows.map(r => ({ ...r, active: r.from_date <= isoToday() && r.to_date >= isoToday() }));
    res.json({ asDelegator: withActive(asDelegator), asDelegate: withActive(asDelegate) });
  } catch (error) {
    console.error('Error listing delegations:', error);
    res.status(500).json({ error: 'Failed to list delegations' });
  }
});

// Cancel a delegation (only the delegator can)
router.delete('/delegations/:id', authenticateToken, (req, res) => {
  try {
    const row = db.prepare('SELECT id FROM approval_delegations WHERE id = ? AND delegator_id = ?').get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Delegation not found' });
    db.prepare('DELETE FROM approval_delegations WHERE id = ?').run(req.params.id);
    res.json({ message: 'Delegation cancelled' });
  } catch (error) {
    console.error('Error deleting delegation:', error);
    res.status(500).json({ error: 'Failed to cancel delegation' });
  }
});

// ─── One-click email approval (public, token-gated) ──────────────────────────
const htmlPage = (title, bodyHtml, accent = '#0066CC') => `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title></head>
<body style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#F1F5F9; margin:0; padding:40px 16px;">
  <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:14px; padding:28px; box-shadow:0 10px 30px rgba(0,0,0,0.08); border-top:5px solid ${accent};">
    ${bodyHtml}
  </div>
</body></html>`;

// Validate the token and return { payload, voucher, error }
const resolveApprovalToken = (token) => {
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return { error: 'This approval link is invalid or has expired. Please approve from the portal.' };
  }
  if (!payload || payload.purpose !== 'jcc-approve') {
    return { error: 'This link is not a valid approval link.' };
  }
  const voucher = db.prepare('SELECT * FROM voucher_requests WHERE id = ?').get(payload.voucherId);
  if (!voucher) return { error: 'The claim for this link no longer exists.' };
  return { payload, voucher };
};

// Confirm the token targets an actionable state for the intended approver
const checkApprovable = (payload, voucher) => {
  // Nonce must match the voucher's current nonce — an old link becomes invalid
  // once the claim has re-entered approval (resubmit / respond-info bumps it).
  if (Number(payload.nonce || 0) !== (Number(voucher.approval_nonce) || 0)) {
    return 'This approval link has expired because the claim was updated. Please approve from the portal.';
  }
  if (payload.level === 1) {
    if (voucher.status !== 'pending_approval_1' || voucher.approver1_status !== 'pending') return 'This claim is no longer awaiting Level 1 approval.';
    const approver = findUserByName(voucher.approver1_name);
    if (!approver || approver.id !== payload.approverId) return 'This link is not associated with the current Level 1 approver.';
  } else if (payload.level === 2) {
    if (voucher.status !== 'pending_approval_2' || voucher.approver2_status !== 'pending' || voucher.approver1_status !== 'approved') return 'This claim is not awaiting your Final Approval.';
    const approver = findUserByName(voucher.approver2_name);
    if (!approver || approver.id !== payload.approverId) return 'This link is not associated with the current Final Approver.';
  } else {
    return 'Unknown approval level.';
  }
  return null;
};

// GET — show a confirmation page (does NOT approve; protects against link scanners)
// Details for the in-app approval screen reached from an email link. The signed
// token is the credential here — the approver may not be logged in, which is the
// entire point of one-click approval from a mail client.
router.get('/approval-link/:token', (req, res) => {
  const { token } = req.params;
  const { payload, voucher, error } = resolveApprovalToken(token);
  if (error) return res.status(400).json({ ok: false, reason: 'invalid', error });

  const jccId = voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`;
  const notActionable = checkApprovable(payload, voucher);
  const approver = db.prepare('SELECT name FROM users WHERE id = ?').get(payload.approverId);

  return res.json({
    ok: !notActionable,
    reason: notActionable ? 'not_actionable' : null,
    error: notActionable || null,
    jccId,
    level: payload.level,
    levelLabel: payload.level === 1 ? 'Level 1 (Manager) Approval' : 'Final Approval',
    approverName: approver?.name || null,
    voucher: {
      id: voucher.id,
      supplier: voucher.supplier,
      invoiceNumber: voucher.invoice_number,
      invoiceDate: voucher.invoice_date,
      claimedBy: voucher.claimed_by,
      department: voucher.department,
      poNumber: voucher.po_number,
      basicAmount: voucher.basic_amount,
      grossAmount: voucher.gross_amount,
      natureOfExpenses: voucher.nature_of_expenses,
      description: voucher.description,
      status: voucher.status,
      claimedDate: voucher.claimed_date,
    },
  });
});

router.get('/approve-via-link/:token', (req, res) => {
  const { token } = req.params;
  const { payload, voucher, error } = resolveApprovalToken(token);
  if (error) return res.status(400).send(htmlPage('Approval Link', `<h2 style="margin-top:0;color:#B91C1C;">Cannot open this link</h2><p style="color:#334155;">${error}</p>`, '#B91C1C'));

  const notActionable = checkApprovable(payload, voucher);
  const jccId = voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`;
  if (notActionable) {
    return res.status(200).send(htmlPage('Approval Link', `<h2 style="margin-top:0;color:#B45309;">Nothing to approve</h2><p style="color:#334155;">${notActionable}</p><p style="color:#64748B;font-size:13px;">${jccId}</p>`, '#B45309'));
  }

  const levelLabel = payload.level === 1 ? 'Level 1 (Manager) Approval' : 'Final Approval';
  const body = `
    <h2 style="margin-top:0;color:#0F172A;">Confirm ${levelLabel}</h2>
    <p style="color:#334155;">You are about to approve <strong>${jccId}</strong>.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#334155;margin:12px 0;">
      <tr><td style="padding:4px 0;color:#64748B;">Supplier</td><td style="text-align:right;font-weight:600;">${voucher.supplier || '-'}</td></tr>
      <tr><td style="padding:4px 0;color:#64748B;">Invoice No.</td><td style="text-align:right;font-weight:600;">${voucher.invoice_number || '-'}</td></tr>
      <tr><td style="padding:4px 0;color:#64748B;">Amount</td><td style="text-align:right;font-weight:600;">₹${Number(voucher.basic_amount || 0).toLocaleString('en-IN')}</td></tr>
    </table>
    <form method="POST" action="/api/jcc/approve-via-link/${token}" style="margin-top:16px;">
      <button type="submit" style="width:100%;background:#059669;color:#fff;border:none;padding:13px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">✓ Approve ${jccId}</button>
    </form>
    <p style="color:#94A3B8;font-size:12px;margin-top:14px;">If you did not intend to approve this, simply close this page.</p>`;
  return res.status(200).send(htmlPage(`Approve ${jccId}`, body, '#059669'));
});

// POST — perform the approval
router.post('/approve-via-link/:token', (req, res) => {
  const { token } = req.params;
  // Old emails POST a plain <form> and need HTML back; the in-app screen asks for
  // JSON. One handler, two renderings — so links already in inboxes keep working.
  const wantsJson = (req.get('accept') || '').includes('application/json');
  const { payload, voucher, error } = resolveApprovalToken(token);
  if (error) {
    return wantsJson
      ? res.status(400).json({ ok: false, reason: 'invalid', error })
      : res.status(400).send(htmlPage('Approval', `<h2 style="margin-top:0;color:#B91C1C;">Link error</h2><p style="color:#334155;">${error}</p>`, '#B91C1C'));
  }

  const notActionable = checkApprovable(payload, voucher);
  const jccId = voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`;
  if (notActionable) {
    return wantsJson
      ? res.status(409).json({ ok: false, reason: 'not_actionable', error: notActionable, jccId })
      : res.status(200).send(htmlPage('Approval', `<h2 style="margin-top:0;color:#B45309;">Already handled</h2><p style="color:#334155;">${notActionable}</p>`, '#B45309'));
  }

  try {
    const approverUser = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(payload.approverId);
    const creator = db.prepare('SELECT id, name, email, ps_number FROM users WHERE id = ?').get(voucher.user_id);

    if (payload.level === 1) {
      db.prepare(`UPDATE voucher_requests SET approver1_status='approved', approver1_remark=?, approver1_date=datetime('now'), approver2_status='pending', current_approval_level=2, status='pending_approval_2' WHERE id=?`)
        .run('Approved via email link', voucher.id);
      // Notify the final approver (in-app + email w/ their own one-click link)
      if (voucher.approver2_name) {
        const nextApprover = findUserByName(voucher.approver2_name);
        if (nextApprover) {
          db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
            .run(nextApprover.id, 'Action Required: JCC Final Approval', `JCC ${jccId} has passed Level 1 and needs your final approval.`, 'warning');
          try {
            const voucherData = {
              voucherId: voucher.id, voucherRequestId: jccId, supplier: voucher.supplier, invoiceNumber: voucher.invoice_number,
              invoiceDate: voucher.invoice_date, department: voucher.department, basicAmount: voucher.basic_amount, grossAmount: voucher.gross_amount,
              poNumber: voucher.po_number, claimedBy: voucher.claimed_by, approver1Name: voucher.approver1_name, approver2Name: voucher.approver2_name,
              approveLink: approvalLink(voucher.id, 2, nextApprover.id),
            };
            notifyNextApprover(voucherData, creator, nextApprover).catch(err => console.error('[Email] next approver (via-link):', err));
          } catch (e) { console.error('[via-link] next-approver email failed:', e); }
        }
      }
      if (creator) {
        db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
          .run(creator.id, 'JCC Approved at Level 1', `Your JCC ${jccId} was approved by ${approverUser?.name || 'the manager'} (Level 1) and is pending Final Approval.`, 'info');
      }
    } else {
      db.prepare(`UPDATE voucher_requests SET approver2_status='approved', approver2_remark=?, approver2_date=datetime('now'), current_approval_level=NULL, status='approved', payment_status='pending_payment' WHERE id=?`)
        .run('Approved via email link', voucher.id);
      try {
        insertPaymentLog({ voucherId: voucher.id, oldStatus: voucher.payment_status || 'awaiting_approval', newStatus: 'pending_payment', referenceNo: null, amount: voucher.basic_amount, remarks: 'Approved via email link (Level 2)', actionSource: 'approval_via_link_level_2', user: approverUser || { id: payload.approverId } });
      } catch (e) { console.error('[via-link] payment log failed:', e); }
      if (creator) {
        db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`)
          .run(creator.id, 'JCC Fully Approved', `Your JCC ${jccId} has been fully approved.`, 'success');
      }
    }

    const outcome = payload.level === 1
      ? 'approved at Level 1 and sent for Final Approval'
      : 'fully approved';
    if (wantsJson) {
      return res.json({ ok: true, jccId, level: payload.level, outcome, message: `${jccId} has been ${outcome}.` });
    }
    const successBody = `<h2 style="margin-top:0;color:#059669;">✓ Approved</h2>
      <p style="color:#334155;"><strong>${jccId}</strong> has been ${outcome}.</p>
      <p style="color:#64748B;font-size:13px;">You can close this page.</p>`;
    return res.status(200).send(htmlPage(`Approved ${jccId}`, successBody, '#059669'));
  } catch (err) {
    console.error('Error approving via link:', err);
    return wantsJson
      ? res.status(500).json({ ok: false, reason: 'server_error', error: 'Could not approve right now. Please try from the portal.' })
      : res.status(500).send(htmlPage('Approval', `<h2 style="margin-top:0;color:#B91C1C;">Something went wrong</h2><p style="color:#334155;">Could not approve right now. Please try from the portal.</p>`, '#B91C1C'));
  }
});

export default router;
