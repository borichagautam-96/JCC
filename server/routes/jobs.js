import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { issueAnnexureForJob } from './annexures.js';
import {
  notifyPrintJobSubmitted,
  notifyPrintJobAccepted,
  notifyPrintJobReturned,
  notifyPrintJobRejected,
  notifyPrintJobAssigned,
  notifyPrintJobReady,
  notifyPrintJobCompleted,
  notifyPrintJobAwaitingReceipt,
  notifyPrintJobReceiptConfirmed,
  notifyPrintProofReleased,
  notifyPrintReworkAssigned,
  notifyPrintReworkCompleted,
  notifyPrintReworkRequested,
} from '../utils/emailService.js';
import { parsePageList, describePageList } from '../utils/pageRanges.js';
import { diffSubmissions, summariseDiff, rollUps, HEADER_FIELDS } from '../utils/jobDiff.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Roles allowed to raise a printing request (same set that creates JCCs).
const REQUESTOR_ROLES = ['initiator', 'user', 'admin'];
// Editable states — the requestor may add/remove documents and resubmit only here.
const EDITABLE_STATES = ['draft', 'returned', 'recalled'];

// States the requestor may pull a job back from: submitted for verification, or
// accepted into the queue. Once an operator is assigned the paper is moving, and
// a silent document swap would leave them printing a file that no longer matches
// the instructions they were given.
const RECALLABLE_STATES = ['submitted', 'accepted'];

// ── PDF storage for job documents ───────────────────────────────────────────
const uploadDir = path.join(__dirname, '../../uploads/print-jobs');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'job-' + uniqueSuffix + path.extname(file.originalname));
  },
});
// No size cap on printing uploads, by request. Production drawings and full manuals
// routinely run past any figure that looks generous on paper. The PDF-only filter
// stays, and nginx's client_max_body_size has been lifted to match — capping either
// layer alone just moves where the upload fails.
//
// Worth knowing: nothing now bounds a single upload except free disk. There is no
// disk-space guard in this application.
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const isPdf = /pdf/.test(path.extname(file.originalname).toLowerCase()) && /pdf/.test(file.mimetype);
    if (isPdf) return cb(null, true);
    cb(new Error('Only PDF files are allowed'));
  },
});

// ── Number generators (id-independent, gap-safe sequential) ──────────────────
// REQxxxx assigned at creation (Phase 1); JOBxxxx assigned at submission (Phase 3).
const nextSequential = (column, prefix) => {
  const row = db
    .prepare(
      `SELECT ${column} AS v FROM print_jobs WHERE ${column} GLOB '${prefix}[0-9]*' ORDER BY CAST(substr(${column}, ${prefix.length + 1}) AS INTEGER) DESC LIMIT 1`
    )
    .get();
  const last = row?.v ? parseInt(String(row.v).slice(prefix.length), 10) : 0;
  return `${prefix}${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`;
};

// RWKxxxx — same gap-safe scheme, but the sequence lives in print_job_reworks.
const nextReworkId = () => {
  const row = db
    .prepare(
      `SELECT rework_id AS v FROM print_job_reworks WHERE rework_id GLOB 'RWK[0-9]*'
       ORDER BY CAST(substr(rework_id, 4) AS INTEGER) DESC LIMIT 1`
    )
    .get();
  const last = row?.v ? parseInt(String(row.v).slice(3), 10) : 0;
  return `RWK${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`;
};

// ── Access control ───────────────────────────────────────────────────────────
// A job's data/files are visible to its creator, oversight roles, and the
// assigned operator. Blocks IDOR (guessing another requestor's job id).
const canViewJob = (req, job) => {
  if (!job) return false;
  if (['admin', 'manager', 'final_approver'].includes(req.user.role)) return true;
  if (isCoordinator(req)) return true; // flag-based printing coordinator
  if (job.created_by === req.user.id) return true;
  if (job.assigned_operator_id && job.assigned_operator_id === req.user.id) return true;
  // A printer operator may review a queued job (accepted + unassigned) they can pick up.
  if (job.status === 'accepted' && !job.assigned_operator_id && isOperatorUser(req.user.id)) return true;
  return false;
};

// Only the owner (or admin) may edit/submit/delete, and only in an editable state.
const canEditJob = (req, job) =>
  !!job && (job.created_by === req.user.id || req.user.role === 'admin');

const toBit = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const cleanStr = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

// Printing coordinators = users with the module flag (independent of JCC role).
const coordinatorContacts = () => {
  try {
    return db.prepare('SELECT id, name, email FROM users WHERE is_printer_coordinator = 1 AND deleted_at IS NULL').all();
  } catch (e) {
    console.error('[jobs] coordinator lookup failed:', e);
    return [];
  }
};

// In-app notification to all printing coordinators.
const notifyCoordinators = (title, message) => {
  try {
    const insert = db.prepare('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)');
    for (const c of coordinatorContacts()) insert.run(c.id, title, message, 'info');
  } catch (e) {
    console.error('[jobs] coordinator notify failed:', e);
  }
};

const getUserContact = (id) => {
  if (!id) return {};
  try {
    return db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(id) || {};
  } catch (_) {
    return {};
  }
};

// Build the normalized object the email templates expect. `job` is a DB row.
const buildEmailJob = (job, extra = {}) => {
  const docCount = extra.documentCount != null
    ? extra.documentCount
    : (db.prepare('SELECT COUNT(*) AS c FROM print_job_documents WHERE job_id = ?').get(job.id)?.c ?? 0);
  const requestor = getUserContact(job.created_by);
  const operator = job.assigned_operator_id ? getUserContact(job.assigned_operator_id) : {};
  return {
    jobNumber: job.job_number || job.request_id,
    requestId: job.request_id,
    projectName: job.project_name,
    debitCode: job.debit_code,
    documentCount: docCount,
    requestorName: requestor.name,
    operatorName: operator.name,
    ...extra,
  };
};

// Emails are best-effort: never let a mail failure break the workflow.
const fireEmail = (promise) => { try { Promise.resolve(promise).catch(() => {}); } catch (_) { /* ignore */ } };

const writeAudit = (req, action, jobId, details) => {
  try {
    db.prepare(
      `INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details, ip_address)
       VALUES (?, ?, ?, 'print_job', ?, ?, ?)`
    ).run(req.user.id, req.user.name, action, jobId, details || null, req.ip || null);
  } catch (e) {
    console.error('[jobs] audit failed:', e);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — create a draft request (Form 1). Returns the auto Request ID.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticateToken, authorizeRoles(...REQUESTOR_ROLES), (req, res) => {
  try {
    const b = req.body || {};
    if (!cleanStr(b.debit_code)) {
      return res.status(400).json({ error: 'Debit Code is required' });
    }

    // Job location defaults to the requester's home site; overridable via the form.
    let locationId = userLocationId(req.user.id);
    if (b.location_id != null && b.location_id !== '') {
      const parsed = parseInt(b.location_id, 10);
      if (Number.isFinite(parsed) && db.prepare('SELECT id FROM locations WHERE id = ?').get(parsed)) {
        locationId = parsed;
      }
    }

    const requestId = nextSequential('request_id', 'REQ');
    const psNumber = db.prepare('SELECT ps_number FROM users WHERE id = ?').get(req.user.id)?.ps_number || null;
    const result = db
      .prepare(
        `INSERT INTO print_jobs (
           request_id, employee_name, employee_id, department_name, department_code,
           debit_code, project_name, dt_number, shipset_batch, classification,
           number_of_pages, lead_name, edc, recipient_name, recipient_contact,
           recipient_address, vl_review, drp_remarks, pre_printing_checklist,
           purpose, printing_form_available, remarks, location_id, status, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
      )
      .run(
        requestId,
        // Identity is server-enforced from the logged-in user (read-only in the UI).
        req.user.name || null,
        psNumber,
        cleanStr(b.department_name),
        cleanStr(b.department_code),
        cleanStr(b.debit_code),
        cleanStr(b.project_name),
        cleanStr(b.dt_number),
        cleanStr(b.shipset_batch),
        cleanStr(b.classification),
        b.number_of_pages ? parseInt(b.number_of_pages, 10) : null,
        cleanStr(b.lead_name),
        cleanStr(b.edc),
        cleanStr(b.recipient_name),
        cleanStr(b.recipient_contact),
        cleanStr(b.recipient_address),
        cleanStr(b.vl_review),
        cleanStr(b.drp_remarks),
        cleanStr(b.pre_printing_checklist),
        cleanStr(b.purpose),
        cleanStr(b.printing_form_available),
        cleanStr(b.remarks),
        locationId,
        req.user.id
      );

    writeAudit(req, 'CREATE_PRINT_REQUEST', result.lastInsertRowid, `Request ${requestId} created`);
    res.json({ id: result.lastInsertRowid, request_id: requestId, message: `Request ${requestId} created` });
  } catch (error) {
    console.error('Error creating print request:', error);
    res.status(500).json({ error: 'Failed to create print request' });
  }
});

// Clone: create a fresh DRAFT copying a past request's Form-1 details (not the
// documents/PDFs — those are re-added). "Repeat last request" for the owner.
router.post('/:id/clone', authenticateToken, authorizeRoles(...REQUESTOR_ROLES), (req, res) => {
  try {
    const src = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!src) return res.status(404).json({ error: 'Source request not found' });
    if (src.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only clone your own request' });
    }
    const requestId = nextSequential('request_id', 'REQ');
    const psNumber = db.prepare('SELECT ps_number FROM users WHERE id = ?').get(req.user.id)?.ps_number || null;
    const result = db.prepare(
      `INSERT INTO print_jobs (
         request_id, employee_name, employee_id, department_name, department_code,
         debit_code, project_name, dt_number, shipset_batch, classification,
         number_of_pages, lead_name, edc, recipient_name, recipient_contact,
         recipient_address, vl_review, drp_remarks, pre_printing_checklist,
         purpose, printing_form_available, remarks, location_id, status, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
    ).run(
      requestId, req.user.name || null, psNumber,
      src.department_name, src.department_code, src.debit_code, src.project_name, src.dt_number,
      src.shipset_batch, src.classification, src.number_of_pages, src.lead_name, src.edc,
      src.recipient_name, src.recipient_contact, src.recipient_address, src.vl_review,
      src.drp_remarks, src.pre_printing_checklist, src.purpose, src.printing_form_available,
      src.remarks, src.location_id, req.user.id
    );
    writeAudit(req, 'CLONE_PRINT_REQUEST', result.lastInsertRowid, `Cloned from ${src.job_number || src.request_id}`);
    res.json({ id: result.lastInsertRowid, request_id: requestId, message: `Cloned into ${requestId}` });
  } catch (error) {
    console.error('Error cloning request:', error);
    res.status(500).json({ error: 'Failed to clone request' });
  }
});

// Toggle rush/priority (coordinator) — rush jobs jump the queue.
router.post('/:id/priority', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const rush = req.body?.rush ? 1 : 0;
    db.prepare("UPDATE print_jobs SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(rush, job.id);
    writeAudit(req, rush ? 'MARK_RUSH' : 'CLEAR_RUSH', job.id, `${jobLabel(job)} marked ${rush ? 'RUSH' : 'normal'}`);
    if (rush) notifyUser(job.assigned_operator_id, 'Rush Job', `${jobLabel(job)} was marked RUSH.`, 'warning');
    res.json({ message: `${jobLabel(job)} is now ${rush ? 'RUSH' : 'normal'} priority.`, priority: rush });
  } catch (error) {
    console.error('Error setting priority:', error);
    res.status(500).json({ error: 'Failed to set priority' });
  }
});

// Update Form 1 fields on a draft/returned request.
router.put('/:id', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Request not found' });
    if (!canEditJob(req, job)) return res.status(403).json({ error: 'You can only edit your own request' });
    if (!EDITABLE_STATES.includes(job.status)) {
      return res.status(400).json({ error: `A ${job.status} request can no longer be edited` });
    }
    const b = req.body || {};
    if (!cleanStr(b.debit_code)) return res.status(400).json({ error: 'Debit Code is required' });

    // Resolve an optional location change (validated); keep existing if not provided.
    let locationId = job.location_id;
    if (b.location_id != null && b.location_id !== '') {
      const parsed = parseInt(b.location_id, 10);
      if (Number.isFinite(parsed) && db.prepare('SELECT id FROM locations WHERE id = ?').get(parsed)) {
        locationId = parsed;
      }
    }

    db.prepare(
      `UPDATE print_jobs SET
         department_name = ?, department_code = ?, debit_code = ?, project_name = ?,
         dt_number = ?, shipset_batch = ?, classification = ?, number_of_pages = ?,
         lead_name = ?, edc = ?, recipient_name = ?, recipient_contact = ?,
         recipient_address = ?, vl_review = ?, drp_remarks = ?, pre_printing_checklist = ?,
         purpose = ?, printing_form_available = ?, remarks = ?, location_id = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      cleanStr(b.department_name),
      cleanStr(b.department_code),
      cleanStr(b.debit_code),
      cleanStr(b.project_name),
      cleanStr(b.dt_number),
      cleanStr(b.shipset_batch),
      cleanStr(b.classification),
      b.number_of_pages ? parseInt(b.number_of_pages, 10) : null,
      cleanStr(b.lead_name),
      cleanStr(b.edc),
      cleanStr(b.recipient_name),
      cleanStr(b.recipient_contact),
      cleanStr(b.recipient_address),
      cleanStr(b.vl_review),
      cleanStr(b.drp_remarks),
      cleanStr(b.pre_printing_checklist),
      cleanStr(b.purpose),
      cleanStr(b.printing_form_available),
      cleanStr(b.remarks),
      locationId,
      job.id
    );
    res.json({ message: 'Request updated' });
  } catch (error) {
    console.error('Error updating print request:', error);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — documents (a job has many). PDF upload is mandatory per document.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/documents', authenticateToken, upload.single('pdf'), (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Request not found' });
    }
    if (!canEditJob(req, job)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'You can only modify your own request' });
    }
    if (!EDITABLE_STATES.includes(job.status)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: `Documents cannot be changed on a ${job.status} request` });
    }
    const b = req.body || {};
    if (!cleanStr(b.document_name)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Document name is required' });
    }
    if (!req.file) return res.status(400).json({ error: 'PDF upload is required' });
    const quantity = parseInt(b.quantity, 10);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Quantity must be greater than zero' });
    }

    const result = db
      .prepare(
        `INSERT INTO print_job_documents (
           job_id, document_name, quantity, pdf_path, num_pages, print_side, paper_size,
           paper_gsm, color_mode, cover_page, soft_lamination, separators, separator_thickness,
           hole_punch, binding_type, binding_variant, extra_services, file_colour,
           remarks, pdf_sha256
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        job.id,
        cleanStr(b.document_name),
        quantity,
        req.file.filename,
        b.num_pages ? parseInt(b.num_pages, 10) : null,
        cleanStr(b.print_side),
        cleanStr(b.paper_size),
        cleanStr(b.paper_gsm),
        cleanStr(b.color_mode),
        cleanStr(b.cover_page),
        toBit(b.soft_lamination),
        toBit(b.separators),
        cleanStr(b.separator_thickness),
        toBit(b.hole_punch),
        cleanStr(b.binding_type),
        cleanStr(b.binding_variant),
        // Sent as a JSON string by the form; store only if it parses to a list.
        (() => {
          const raw = cleanStr(b.extra_services);
          if (!raw) return null;
          try { return Array.isArray(JSON.parse(raw)) ? raw : null; } catch { return null; }
        })(),
        cleanStr(b.file_colour),
        cleanStr(b.remarks),
        sha256OfFile(path.join(uploadDir, req.file.filename))
      );

    db.prepare("UPDATE print_jobs SET updated_at = datetime('now') WHERE id = ?").run(job.id);
    res.json({ id: result.lastInsertRowid, message: 'Document added' });
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => {});
    console.error('Error adding document:', error);
    res.status(500).json({ error: 'Failed to add document' });
  }
});

// Delete a document (and its PDF file).
// Swap a document's PDF while keeping the row, its name and its specs.
//
// This is what a correction cycle actually needs. Without it the only way to fix a
// wrong file was Delete + Add, which appends a second document — so a recalled job
// came back to the coordinator carrying both the old and the corrected file.
//
// The superseded file is left on disk: submission snapshots record each document's
// path, so an earlier submission stays retrievable.
router.put('/:id/documents/:docId/file', authenticateToken, upload.single('pdf'), async (req, res) => {
  const cleanupUpload = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) { cleanupUpload(); return res.status(404).json({ error: 'Request not found' }); }
    if (!canEditJob(req, job)) { cleanupUpload(); return res.status(403).json({ error: 'You can only edit your own request' }); }
    if (!EDITABLE_STATES.includes(job.status)) {
      cleanupUpload();
      return res.status(400).json({ error: `A ${job.status} request can no longer be edited` });
    }
    const doc = db.prepare('SELECT * FROM print_job_documents WHERE id = ? AND job_id = ?').get(req.params.docId, job.id);
    if (!doc) { cleanupUpload(); return res.status(404).json({ error: 'Document not found' }); }
    if (!req.file) return res.status(400).json({ error: 'Attach the replacement PDF' });

    const absPath = path.join(uploadDir, req.file.filename);
    const numPages = await readPdfPageCount(absPath);
    const hash = sha256OfFile(absPath);

    if (hash && doc.pdf_sha256 && hash === doc.pdf_sha256) {
      cleanupUpload();
      return res.status(400).json({ error: 'That is the same file that is already attached.' });
    }

    db.prepare(
      `UPDATE print_job_documents
          SET pdf_path = ?, pdf_sha256 = ?, num_pages = COALESCE(?, num_pages)
        WHERE id = ?`
    ).run(req.file.filename, hash, numPages, doc.id);
    db.prepare("UPDATE print_jobs SET updated_at = datetime('now') WHERE id = ?").run(job.id);

    writeAudit(req, 'REPLACE_DOCUMENT_PDF', job.id,
      `PDF replaced on "${doc.document_name}"${numPages ? ` (${numPages} pages)` : ''}`);

    res.json({
      id: doc.id,
      num_pages: numPages ?? doc.num_pages,
      message: `PDF replaced on "${doc.document_name}".`,
    });
  } catch (error) {
    cleanupUpload();
    console.error('Error replacing document PDF:', error);
    res.status(500).json({ error: 'Failed to replace the PDF' });
  }
});

router.delete('/:id/documents/:docId', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Request not found' });
    if (!canEditJob(req, job)) return res.status(403).json({ error: 'You can only modify your own request' });
    if (!EDITABLE_STATES.includes(job.status)) {
      return res.status(400).json({ error: `Documents cannot be changed on a ${job.status} request` });
    }
    const doc = db
      .prepare('SELECT * FROM print_job_documents WHERE id = ? AND job_id = ?')
      .get(req.params.docId, job.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    db.prepare('DELETE FROM print_job_documents WHERE id = ?').run(doc.id);
    if (doc.pdf_path) fs.unlink(path.join(uploadDir, doc.pdf_path), () => {});
    db.prepare("UPDATE print_jobs SET updated_at = datetime('now') WHERE id = ?").run(job.id);
    res.json({ message: 'Document deleted' });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// Download a document's PDF (access-checked).
router.get('/:id/documents/:docId/file', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Request not found' });
    if (!canViewJob(req, job)) return res.status(403).json({ error: 'Not authorized' });
    const doc = db
      .prepare('SELECT * FROM print_job_documents WHERE id = ? AND job_id = ?')
      .get(req.params.docId, job.id);
    if (!doc || !doc.pdf_path) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(uploadDir, doc.pdf_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — submit. Validates, assigns JOB number, notifies coordinators.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/submit', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Request not found' });
    if (!canEditJob(req, job)) return res.status(403).json({ error: 'You can only submit your own request' });
    if (!EDITABLE_STATES.includes(job.status)) {
      return res.status(400).json({ error: `A ${job.status} request cannot be submitted` });
    }
    if (!cleanStr(job.debit_code)) return res.status(400).json({ error: 'Debit Code is required' });

    const docs = db.prepare('SELECT * FROM print_job_documents WHERE job_id = ?').all(job.id);
    if (docs.length === 0) return res.status(400).json({ error: 'Add at least one document before submitting' });
    for (const d of docs) {
      if (!d.pdf_path) return res.status(400).json({ error: `Document "${d.document_name}" is missing its PDF` });
      if (!(d.quantity > 0)) return res.status(400).json({ error: `Document "${d.document_name}" needs quantity > 0` });
    }

    // Keep the same JOB number across return→resubmit; only assign the first time.
    const jobNumber = job.job_number || nextSequential('job_number', 'JOB');

    // Snapshot BEFORE the status changes — the state being submitted *from* is what
    // says whether this is a first submission, a resubmit after the requestor
    // recalled it, or a resubmit after the coordinator returned it.
    const snapshot = recordSubmission(req, { ...job, job_number: jobNumber }, docs);

    db.prepare(
      `UPDATE print_jobs SET
         job_number = ?, status = 'submitted',
         submitted_at = datetime('now'),
         return_reason = NULL,
         recall_reason = NULL,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(jobNumber, job.id);

    const changeNote = snapshot.seq > 1
      ? ` (submission ${snapshot.seq}${snapshot.changeCount === null ? '' : `, ${snapshot.changeCount} change${snapshot.changeCount === 1 ? '' : 's'}`})`
      : '';
    writeAudit(req, 'SUBMIT_PRINT_JOB', job.id, `${jobNumber} submitted for coordinator verification${changeNote}`);
    notifyCoordinators(
      'New Printing Job Submitted',
      `${jobNumber} from ${req.user.name} is awaiting your verification.`
    );
    fireEmail(notifyPrintJobSubmitted(buildEmailJob({ ...job, job_number: jobNumber }), coordinatorContacts().map((c) => c.email)));
    res.json({
      job_number: jobNumber,
      submission_seq: snapshot.seq,
      change_count: snapshot.changeCount,
      message: `${jobNumber} submitted for coordinator verification.`,
    });
  } catch (error) {
    console.error('Error submitting print job:', error);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 12 (requestor) — my jobs, with document count and live queue position.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/mine', authenticateToken, (req, res) => {
  try {
    const jobs = db
      .prepare(
        `SELECT j.*, l.name AS location_name,
                (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count,
                ca.annexure_no, ca.status AS annexure_status, ca.grand_total_paise AS annexure_total_paise
         FROM print_jobs j
         LEFT JOIN locations l ON j.location_id = l.id
         LEFT JOIN cost_annexures ca ON ca.job_id = j.id AND ca.status != 'superseded'
         WHERE j.created_by = ?
         ORDER BY j.created_at DESC`
      )
      .all(req.user.id);

    // FCFS queue position among accepted jobs (computed, never stored).
    const queue = db
      .prepare(
        `SELECT id, ROW_NUMBER() OVER (ORDER BY priority DESC, submitted_at ASC) AS qp
         FROM print_jobs WHERE status = 'accepted'`
      )
      .all();
    const qpMap = new Map(queue.map((q) => [q.id, q.qp]));
    for (const j of jobs) j.queue_position = qpMap.get(j.id) || null;

    res.json(jobs);
  } catch (error) {
    console.error('Error fetching my print jobs:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SLICE B & C — Coordinator, Queue, Assignment, Operator execution, Closure.
// Static GET routes below MUST stay above the '/:id' route so they aren't
// captured as an id.
// ═══════════════════════════════════════════════════════════════════════════

// Printing roles are module-scoped flags, INDEPENDENT of the global JCC role.
// Checked fresh from the DB so a flag change takes effect without re-login.
//
// The flag is the single source of truth. A JCC role — admin included — does NOT
// confer coordinator capability: `is_printer_coordinator` exists precisely to say
// who runs the print room, and letting `role === 'admin'` bypass it made the flag
// meaningless for exactly the accounts with the most reach. An admin who needs the
// coordinator workspace ticks their own flag in User Management; admins keep
// read-only oversight through canViewJob below, which is a separate concern.
const isCoordinator = (req) => {
  const row = db.prepare('SELECT is_printer_coordinator FROM users WHERE id = ?').get(req.user.id);
  return !!(row && row.is_printer_coordinator);
};
const isOperatorUser = (userId) => {
  const row = db.prepare('SELECT is_printer_operator FROM users WHERE id = ? AND deleted_at IS NULL').get(userId);
  return !!(row && row.is_printer_operator);
};

// A user's home location (site), or null.
const userLocationId = (userId) => {
  const row = db.prepare('SELECT location_id FROM users WHERE id = ?').get(userId);
  return row?.location_id || null;
};

// Product decision: printing coordinators (and admins) see ALL sites — nothing is
// hidden by location. Location still tags each job, drives operator assignment (the
// assign check keeps a site's work with that site's operators), and appears in
// reports. Returning null means the location filter below is a no-op.
const scopeLocation = () => null;
// SQL fragment (+ params) that limits jobs to the scope location. NULL-location
// jobs stay visible to everyone during rollout.
const locScopeSql = (col = 'j.location_id') => `(? IS NULL OR ${col} = ? OR ${col} IS NULL)`;
const notifyUser = (userId, title, message, type = 'info') => {
  if (!userId) return;
  try {
    db.prepare('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)').run(userId, title, message, type);
  } catch (e) {
    console.error('[jobs] notifyUser failed:', e);
  }
};
const jobLabel = (job) => job.job_number || job.request_id || `Job #${job.id}`;
// Operator actions are restricted to the assigned operator (or an admin).
const isAssignedOperator = (req, job) => !!job && (job.assigned_operator_id === req.user.id || req.user.role === 'admin');

// ── Phase 4: Coordinator verification queue ─────────────────────────────────
router.get('/pending', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const loc = scopeLocation(req);
    const jobs = db
      .prepare(
        `SELECT j.*, u.name AS requestor_name, l.name AS location_name,
                (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count,
                (SELECT MAX(seq) FROM print_job_submissions s WHERE s.job_id = j.id) AS submission_seq
         FROM print_jobs j
         JOIN users u ON j.created_by = u.id
         LEFT JOIN locations l ON j.location_id = l.id
         WHERE j.status = 'submitted' AND ${locScopeSql()}
         ORDER BY j.priority DESC, j.submitted_at ASC`
      )
      .all(loc, loc);
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching pending jobs:', error);
    res.status(500).json({ error: 'Failed to fetch pending jobs' });
  }
});

// ── Phase 5: FCFS queue of accepted jobs ────────────────────────────────────
router.get('/queue', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const loc = scopeLocation(req);
    const jobs = db
      .prepare(
        `SELECT j.*, u.name AS requestor_name, l.name AS location_name,
                ROW_NUMBER() OVER (ORDER BY j.priority DESC, j.submitted_at ASC) AS queue_position,
                (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count
         FROM print_jobs j
         JOIN users u ON j.created_by = u.id
         LEFT JOIN locations l ON j.location_id = l.id
         WHERE j.status = 'accepted' AND ${locScopeSql()}
         ORDER BY j.priority DESC, j.submitted_at ASC`
      )
      .all(loc, loc);
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching queue:', error);
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

// ── Phase 10: jobs awaiting collection/handover (coordinator closes them) ───
router.get('/ready', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const loc = scopeLocation(req);
    const jobs = db
      .prepare(
        `SELECT j.*, u.name AS requestor_name, op.name AS operator_name, l.name AS location_name,
                (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count
         FROM print_jobs j
         JOIN users u ON j.created_by = u.id
         LEFT JOIN users op ON j.assigned_operator_id = op.id
         LEFT JOIN locations l ON j.location_id = l.id
         WHERE j.status = 'ready_for_collection' AND ${locScopeSql()}
         ORDER BY j.ready_at ASC`
      )
      .all(loc, loc);
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching ready jobs:', error);
    res.status(500).json({ error: 'Failed to fetch ready jobs' });
  }
});

// ── Handed over, waiting on the requestor to confirm receipt (coordinator) ──
// Oldest first: the top of this list is what needs chasing.
router.get('/awaiting-receipt', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const loc = scopeLocation(req);
    const jobs = db
      .prepare(
        `SELECT j.*, u.name AS requestor_name, u.email AS requestor_email,
                op.name AS operator_name, l.name AS location_name,
                (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count
         FROM print_jobs j
         JOIN users u ON j.created_by = u.id
         LEFT JOIN users op ON j.assigned_operator_id = op.id
         LEFT JOIN locations l ON j.location_id = l.id
         WHERE j.status = 'awaiting_receipt' AND ${locScopeSql()}
         ORDER BY j.handed_over_at ASC`
      )
      .all(loc, loc);
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching jobs awaiting receipt:', error);
    res.status(500).json({ error: 'Failed to fetch jobs awaiting receipt' });
  }
});

// ── In-transit jobs awaiting delivery confirmation (coordinator) ────────────
router.get('/dispatched', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const jobs = db
      .prepare(
        `SELECT j.*, u.name AS requestor_name, l.name AS location_name,
                (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count
         FROM print_jobs j
         JOIN users u ON j.created_by = u.id
         LEFT JOIN locations l ON j.location_id = l.id
         WHERE j.status = 'dispatched'
         ORDER BY j.dispatched_at ASC`
      )
      .all();
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching dispatched jobs:', error);
    res.status(500).json({ error: 'Failed to fetch dispatched jobs' });
  }
});

// ── Phase 6: available printer operators (with live workload) ───────────────
router.get('/operators', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const loc = scopeLocation(req);
    const operators = db
      .prepare(
        `SELECT u.id, u.name, u.ps_number, u.location_id, l.name AS location_name,
                (SELECT COUNT(*) FROM print_jobs j WHERE j.assigned_operator_id = u.id
                   AND j.status IN ('assigned','printing','paused')) AS active_jobs
         FROM users u
         LEFT JOIN locations l ON u.location_id = l.id
         WHERE u.is_printer_operator = 1 AND ${locScopeSql('u.location_id')}
         ORDER BY u.name`
      )
      .all(loc, loc);
    res.json(operators);
  } catch (error) {
    console.error('Error fetching operators:', error);
    res.status(500).json({ error: 'Failed to fetch operators' });
  }
});

// ── Printing activity log (coordinator/admin) — every action across all jobs ──
// Filterable + paginated, mirroring the admin log viewer.
router.get('/logs', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const { search, action, fromDate, toDate } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = parseInt(req.query.offset, 10) || 0;

    const where = ["a.entity_type = 'print_job'"];
    const params = [];
    if (search) {
      where.push('(j.job_number LIKE ? OR j.request_id LIKE ? OR a.user_name LIKE ? OR a.details LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (action) { where.push('a.action = ?'); params.push(action); }
    if (fromDate) { where.push('a.created_at >= ?'); params.push(fromDate); }
    if (toDate) { where.push('a.created_at <= ?'); params.push(`${toDate} 23:59:59`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    // Paginate by JOB, so every event for one job stays bundled together.
    const totalJobs = db.prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT a.entity_id FROM audit_logs a LEFT JOIN print_jobs j ON a.entity_id = j.id
         ${whereSql} GROUP BY a.entity_id
       )`
    ).get(...params).c;

    const jobRows = db.prepare(
      `SELECT a.entity_id AS job_id, MAX(a.created_at) AS last_at, COUNT(*) AS event_count
       FROM audit_logs a LEFT JOIN print_jobs j ON a.entity_id = j.id
       ${whereSql}
       GROUP BY a.entity_id
       ORDER BY last_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    let groups = [];
    if (jobRows.length) {
      const jobIds = jobRows.map((r) => r.job_id);
      const placeholders = jobIds.map(() => '?').join(',');
      const events = db.prepare(
        `SELECT a.id, a.action, a.details, a.user_name, a.created_at,
                a.entity_id AS job_id, j.job_number, j.request_id
         FROM audit_logs a LEFT JOIN print_jobs j ON a.entity_id = j.id
         ${whereSql} AND a.entity_id IN (${placeholders})
         ORDER BY a.created_at ASC, a.id ASC`
      ).all(...params, ...jobIds);

      const byJob = new Map();
      for (const ev of events) {
        if (!byJob.has(ev.job_id)) {
          byJob.set(ev.job_id, { job_id: ev.job_id, job_number: ev.job_number, request_id: ev.request_id, events: [] });
        }
        byJob.get(ev.job_id).events.push(ev);
      }
      groups = jobRows.map((r) => byJob.get(r.job_id)).filter(Boolean);
    }

    // Distinct actions (for the filter dropdown).
    const actions = db.prepare(
      "SELECT DISTINCT action FROM audit_logs WHERE entity_type = 'print_job' ORDER BY action"
    ).all().map((r) => r.action);

    res.json({ groups, totalJobs, limit, offset, actions });
  } catch (error) {
    console.error('Error fetching printing logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ── Phase 7–9: operator's assigned jobs ─────────────────────────────────────
router.get('/assigned', authenticateToken, (req, res) => {
  try {
    const jobs = db
      .prepare(
        `SELECT j.*, u.name AS requestor_name, l.name AS location_name,
                (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count
         FROM print_jobs j
         JOIN users u ON j.created_by = u.id
         LEFT JOIN locations l ON j.location_id = l.id
         WHERE (j.assigned_operator_id = ? AND j.status IN ('assigned','printing','paused','printing_completed',
                                                             'ready_for_collection','rework_requested','rework_printing'))
            OR (j.status = 'accepted' AND j.assigned_operator_id IS NULL)
         ORDER BY (CASE WHEN j.assigned_operator_id = ? THEN 0 ELSE 1 END), j.priority DESC, j.submitted_at ASC`
      )
      .all(req.user.id, req.user.id);
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching assigned jobs:', error);
    res.status(500).json({ error: 'Failed to fetch assigned jobs' });
  }
});

// ── Phase 12: role-scoped stats ─────────────────────────────────────────────
router.get('/stats', authenticateToken, (req, res) => {
  try {
    const role = req.user.role;
    const countBy = (whereSql, params = []) =>
      db.prepare(`SELECT status, COUNT(*) AS c FROM print_jobs ${whereSql} GROUP BY status`).all(...params);
    if (isCoordinator(req)) {
      // Scope everything to the coordinator's site (admin = all sites).
      const loc = scopeLocation(req);
      const jobScope = `WHERE ${locScopeSql('location_id')}`;
      const operators = db
        .prepare(
          `SELECT u.id, u.name,
                  (SELECT COUNT(*) FROM print_jobs j WHERE j.assigned_operator_id = u.id AND j.status IN ('assigned','printing','paused')) AS active,
                  (SELECT COUNT(*) FROM print_jobs j WHERE j.assigned_operator_id = u.id AND j.status = 'completed') AS completed
           FROM users u WHERE u.is_printer_operator = 1 AND u.deleted_at IS NULL
             AND ${locScopeSql('u.location_id')} ORDER BY u.name`
        )
        .all(loc, loc);
      // Jobs per department (excludes drafts — not yet in the pipeline).
      const departmentStats = db
        .prepare(
          `SELECT COALESCE(NULLIF(TRIM(department_name), ''), 'Unspecified') AS department, COUNT(*) AS c
           FROM print_jobs WHERE status != 'draft' AND ${locScopeSql('location_id')}
           GROUP BY department ORDER BY c DESC`
        )
        .all(loc, loc);
      // Jobs per location (site breakdown — meaningful for admin's all-sites view).
      const locationStats = db
        .prepare(
          `SELECT COALESCE(l.name, 'Unspecified') AS location, COUNT(*) AS c
           FROM print_jobs j LEFT JOIN locations l ON j.location_id = l.id
           WHERE j.status != 'draft' AND ${locScopeSql('j.location_id')}
           GROUP BY location ORDER BY c DESC`
        )
        .all(loc, loc);
      // Turnaround averages in hours (julianday → days, ×24 → hours). Only rows
      // where both timestamps exist contribute.
      const turnaround = db
        .prepare(
          `SELECT
             ROUND(AVG(CASE WHEN accepted_at IS NOT NULL AND submitted_at IS NOT NULL THEN (julianday(accepted_at)-julianday(submitted_at))*24 END), 1) AS avg_verify_hrs,
             ROUND(AVG(CASE WHEN completed_at IS NOT NULL AND submitted_at IS NOT NULL THEN (julianday(completed_at)-julianday(submitted_at))*24 END), 1) AS avg_total_hrs,
             COUNT(CASE WHEN status='completed' THEN 1 END) AS completed_count
           FROM print_jobs WHERE ${locScopeSql('location_id')}`
        )
        .get(loc, loc);
      const total = db.prepare(`SELECT COUNT(*) AS c FROM print_jobs ${jobScope}`).get(loc, loc).c;
      return res.json({ role, scope: 'all', total, byStatus: countBy(jobScope, [loc, loc]), operators, departmentStats, locationStats, turnaround });
    }
    if (isOperatorUser(req.user.id)) {
      return res.json({ role, scope: 'operator', byStatus: countBy('WHERE assigned_operator_id = ?', [req.user.id]) });
    }
    return res.json({ role, scope: 'requestor', byStatus: countBy('WHERE created_by = ?', [req.user.id]) });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── Phase 4 actions: accept / return / reject ───────────────────────────────
router.post('/:id/accept', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'submitted') return res.status(400).json({ error: `Only a submitted job can be accepted (this one is ${job.status})` });
    db.prepare(
      `UPDATE print_jobs SET status='accepted', coordinator_id=?, coordinator_remarks=?, accepted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(req.user.id, cleanStr(req.body?.remarks), job.id);
    writeAudit(req, 'ACCEPT_PRINT_JOB', job.id, `${jobLabel(job)} accepted`);
    notifyUser(job.created_by, 'Printing Job Accepted', `${jobLabel(job)} was accepted and added to the print queue.`, 'success');
    fireEmail(notifyPrintJobAccepted(buildEmailJob(job), getUserContact(job.created_by).email));
    res.json({ message: `${jobLabel(job)} accepted and queued.` });
  } catch (error) {
    console.error('Error accepting job:', error);
    res.status(500).json({ error: 'Failed to accept job' });
  }
});

router.post('/:id/return', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const reason = cleanStr(req.body?.remarks);
    if (!reason) return res.status(400).json({ error: 'A remark is required when returning a job' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'submitted') return res.status(400).json({ error: `Only a submitted job can be returned (this one is ${job.status})` });
    db.prepare(
      `UPDATE print_jobs SET status='returned', coordinator_id=?, return_reason=?, returned_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(req.user.id, reason, job.id);
    writeAudit(req, 'RETURN_PRINT_JOB', job.id, `${jobLabel(job)} returned: ${reason}`);
    notifyUser(job.created_by, 'Printing Job Returned', `${jobLabel(job)} was returned for correction: ${reason}`, 'warning');
    fireEmail(notifyPrintJobReturned(buildEmailJob(job, { reason }), getUserContact(job.created_by).email));
    res.json({ message: `${jobLabel(job)} returned to the requestor.` });
  } catch (error) {
    console.error('Error returning job:', error);
    res.status(500).json({ error: 'Failed to return job' });
  }
});

router.post('/:id/reject', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const reason = cleanStr(req.body?.reason);
    if (!reason) return res.status(400).json({ error: 'A reason is required to reject a job' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'submitted') return res.status(400).json({ error: `Only a submitted job can be rejected (this one is ${job.status})` });
    db.prepare(
      `UPDATE print_jobs SET status='rejected', coordinator_id=?, reject_reason=?, rejected_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(req.user.id, reason, job.id);
    writeAudit(req, 'REJECT_PRINT_JOB', job.id, `${jobLabel(job)} rejected: ${reason}`);
    notifyUser(job.created_by, 'Printing Job Rejected', `${jobLabel(job)} was rejected: ${reason}`, 'error');
    fireEmail(notifyPrintJobRejected(buildEmailJob(job, { reason }), getUserContact(job.created_by).email));
    res.json({ message: `${jobLabel(job)} rejected.` });
  } catch (error) {
    console.error('Error rejecting job:', error);
    res.status(500).json({ error: 'Failed to reject job' });
  }
});

// ── Phase 6: assign to an operator ──────────────────────────────────────────
router.post('/:id/assign', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const operatorId = parseInt(req.body?.operatorId, 10);
    if (!Number.isFinite(operatorId)) return res.status(400).json({ error: 'operatorId is required' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'accepted') return res.status(400).json({ error: `Only an accepted job can be assigned (this one is ${job.status})` });
    const operator = db.prepare('SELECT id, name, is_printer_operator, location_id FROM users WHERE id = ?').get(operatorId);
    if (!operator || !operator.is_printer_operator) return res.status(400).json({ error: 'Selected user is not a printer operator' });
    // Keep work at the job's site: block cross-location assignment when both are set.
    if (job.location_id && operator.location_id && job.location_id !== operator.location_id) {
      return res.status(400).json({ error: 'That operator is at a different location than this job' });
    }
    db.prepare(
      `UPDATE print_jobs SET status='assigned', assigned_operator_id=?, assigned_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(operatorId, job.id);
    writeAudit(req, 'ASSIGN_PRINT_JOB', job.id, `${jobLabel(job)} assigned to ${operator.name}`);
    notifyUser(operatorId, 'Print Job Assigned', `${jobLabel(job)} has been assigned to you.`, 'info');
    notifyUser(job.created_by, 'Printing Job Assigned', `${jobLabel(job)} was assigned to an operator and will be printed soon.`, 'info');
    fireEmail(notifyPrintJobAssigned(buildEmailJob({ ...job, assigned_operator_id: operatorId }), getUserContact(operatorId).email));
    res.json({ message: `${jobLabel(job)} assigned to ${operator.name}.` });
  } catch (error) {
    console.error('Error assigning job:', error);
    res.status(500).json({ error: 'Failed to assign job' });
  }
});

// ── Phase 7: operator start / pause / resume ────────────────────────────────
const operatorTransition = (req, res, { from, to, tsCol, action, done }) => {
  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!isAssignedOperator(req, job)) return res.status(403).json({ error: 'Only the assigned operator can do this' });
  const fromStates = Array.isArray(from) ? from : [from];
  if (!fromStates.includes(job.status)) return res.status(400).json({ error: `Cannot ${action} a ${job.status} job` });
  const tsSet = tsCol ? `, ${tsCol}=COALESCE(${tsCol}, datetime('now'))` : '';
  db.prepare(`UPDATE print_jobs SET status=?${tsSet}, updated_at=datetime('now') WHERE id=?`).run(to, job.id);
  writeAudit(req, action, job.id, `${jobLabel(job)} → ${to}`);
  if (typeof done === 'function') done(job);
  return res.json({ message: `${jobLabel(job)} is now ${to.replace(/_/g, ' ')}.` });
};

router.post('/:id/start', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Pick up an unassigned queued job: self-assign to this operator, then start.
    if (job.status === 'accepted' && !job.assigned_operator_id) {
      if (!isOperatorUser(req.user.id) && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only a printer operator can pick up a job' });
      }
      db.prepare(
        `UPDATE print_jobs SET status='printing', assigned_operator_id=?,
           assigned_at=COALESCE(assigned_at, datetime('now')),
           printing_started_at=COALESCE(printing_started_at, datetime('now')),
           updated_at=datetime('now')
         WHERE id=?`
      ).run(req.user.id, job.id);
      writeAudit(req, 'START_PRINTING', job.id, `${jobLabel(job)} picked up & started`);
      notifyUser(job.created_by, 'Printing Started', `${jobLabel(job)} has started printing.`, 'info');
      return res.json({ message: `${jobLabel(job)} is now printing.` });
    }

    // Otherwise the normal path: the assigned operator starts an assigned job.
    return operatorTransition(req, res, { from: 'assigned', to: 'printing', tsCol: 'printing_started_at', action: 'START_PRINTING',
      done: (j) => notifyUser(j.created_by, 'Printing Started', `${jobLabel(j)} has started printing.`, 'info') });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to start printing' }); }
});
router.post('/:id/pause', authenticateToken, (req, res) => {
  try { return operatorTransition(req, res, { from: 'printing', to: 'paused', action: 'PAUSE_PRINTING' }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Failed to pause' }); }
});
router.post('/:id/resume', authenticateToken, (req, res) => {
  try { return operatorTransition(req, res, { from: 'paused', to: 'printing', action: 'RESUME_PRINTING' }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Failed to resume' }); }
});

// ── Phase 8: finishing checklist per document ───────────────────────────────
router.put('/:id/documents/:docId/finishing', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!isAssignedOperator(req, job)) return res.status(403).json({ error: 'Only the assigned operator can do this' });
    if (!['printing', 'paused'].includes(job.status)) return res.status(400).json({ error: `Finishing can only be updated while printing (job is ${job.status})` });
    const doc = db.prepare('SELECT * FROM print_job_documents WHERE id = ? AND job_id = ?').get(req.params.docId, job.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const done = req.body?.done ? 1 : 0;
    db.prepare('UPDATE print_job_documents SET finishing_done = ? WHERE id = ?').run(done, doc.id);
    res.json({ message: 'Finishing updated', finishing_done: done });
  } catch (error) {
    console.error('Error updating finishing:', error);
    res.status(500).json({ error: 'Failed to update finishing' });
  }
});

// ── Phase 8→9: complete printing, then mark ready for collection ────────────
router.post('/:id/complete-printing', authenticateToken, (req, res) => {
  try { return operatorTransition(req, res, { from: ['printing', 'paused'], to: 'printing_completed', tsCol: 'printing_completed_at', action: 'COMPLETE_PRINTING',
    done: (job) => notifyUser(job.created_by, 'Printing Completed', `${jobLabel(job)} finished printing and is being prepared.`, 'info') }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Failed to complete printing' }); }
});

router.post('/:id/ready', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!isAssignedOperator(req, job)) return res.status(403).json({ error: 'Only the assigned operator can do this' });
    if (job.status !== 'printing_completed') return res.status(400).json({ error: `Only a printed job can be marked ready (job is ${job.status})` });
    db.prepare(`UPDATE print_jobs SET status='ready_for_collection', ready_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(job.id);
    writeAudit(req, 'READY_FOR_COLLECTION', job.id, `${jobLabel(job)} ready for collection`);
    notifyUser(job.created_by, 'Ready for Collection', `${jobLabel(job)} is ready for collection.`, 'success');
    notifyCoordinators('Job Ready for Collection', `${jobLabel(job)} is ready for collection.`);
    fireEmail(notifyPrintJobReady(
      buildEmailJob(job),
      [getUserContact(job.created_by).email, ...coordinatorContacts().map((c) => c.email)]
    ));
    res.json({ message: `${jobLabel(job)} marked ready for collection.` });
  } catch (error) {
    console.error('Error marking ready:', error);
    res.status(500).json({ error: 'Failed to mark ready' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REWORK — proof review and revised-PDF versions
//
// The requestor reviews a printed proof offline and reports corrections out of
// band; the coordinator is the only role that writes any of it. Each round
// stores a complete revised PDF as a new version, never editing the original.
// ═══════════════════════════════════════════════════════════════════════════

// Total pages in an uploaded PDF, or null if it can't be read. Needed so page
// numbers can be validated against the document the operator will actually print.
// Page count of an uploaded PDF, or null if it genuinely cannot be read.
//
// pdf-parse v2 replaced the v1 callable default export with a PDFParse class, so the
// old `(await import('pdf-parse')).default(buffer)` resolved to undefined and threw on
// every call. The catch swallowed it and returned null, which reads as "unknown page
// count" — and every caller treats unknown as "skip validation". The result was that
// page-range checking silently did nothing at all.
const readPdfPageCount = async (absPath) => {
  let parser = null;
  try {
    const { PDFParse } = await import('pdf-parse');
    parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(absPath)) });
    const info = await parser.getInfo();
    // v2 reports the count as `total`; keep the v1 spellings as a fallback so a future
    // bump that restores them does not silently disable validation again.
    const total = info?.total ?? info?.numPages ?? info?.numpages;
    return Number.isInteger(total) && total > 0 ? total : null;
  } catch (e) {
    console.warn('[jobs] could not read PDF page count:', e.message);
    return null;
  } finally {
    // The parser holds the decoded document; without this the worker leaks per upload.
    try { await parser?.destroy?.(); } catch (_) { /* nothing useful to do */ }
  }
};

const sha256OfFile = (absPath) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch (_) {
    return null;
  }
};

const reworkLabel = (rw) => rw.rework_id || `Rework #${rw.id}`;

/**
 * Check a stored rework's page range against the PDF it will actually be printed from.
 *
 * The range is validated when the rework is raised, but that check is only as good as
 * the page count available at the time: if the PDF could not be read the count is NULL
 * and validation is skipped entirely. Reworks created while that was happening are
 * sitting in the database unchecked, so the count is recovered from the file here
 * rather than trusted to be present.
 *
 * Assignment is the right place for the re-check — it is the last point before the job
 * reaches the press, and a range that overruns the document is otherwise discovered by
 * the operator standing at the machine.
 */
const verifyReworkPages = async (rw) => {
  let numPages = Number.isInteger(rw.num_pages) && rw.num_pages > 0 ? rw.num_pages : null;

  if (numPages === null && rw.pdf_path) {
    numPages = await readPdfPageCount(path.join(uploadDir, rw.pdf_path));
    // Backfill so the next reader does not pay to parse it again.
    if (numPages !== null) {
      db.prepare('UPDATE print_job_reworks SET num_pages = ? WHERE id = ?').run(numPages, rw.id);
    }
  }

  // An unreadable PDF is not proof of a bad range. Say so and let it through rather
  // than blocking a legitimate rework on a parser limitation.
  if (numPages === null) {
    return { ok: true, numPages: null, warning: 'Page count could not be read from the PDF, so the page range was not verified.' };
  }

  const parsed = parsePageList(rw.modified_pages_norm || rw.modified_pages, { maxPage: numPages });
  if (!parsed.ok) return { ok: false, numPages, error: parsed.error };
  return { ok: true, numPages };
};

// A rework replaces printed output, so it only makes sense once something has been
// printed. Drafts and queued jobs are edited normally instead.
const REWORKABLE_STATUSES = ['printing_completed', 'proof_review', 'rework_requested', 'ready_for_collection'];

// Field rules shared by the coordinator's form and the requestor's request, so the
// two entry points can never drift apart on what counts as a valid rework.
const validateReworkFields = (b, numPages) => {
  const parsed = parsePageList(b.modified_pages, { maxPage: numPages });
  if (!parsed.ok) return { error: parsed.error };

  const additional = b.additional_pages === undefined || b.additional_pages === '' ? 0 : Number(b.additional_pages);
  if (!Number.isInteger(additional) || additional < 0 || additional > 500) {
    return { error: 'Additional pages must be a whole number between 0 and 500' };
  }
  const insertPosition = cleanStr(b.insert_position);
  if (additional > 0 && !insertPosition) {
    return { error: `Tell the operator where the ${additional} new page${additional === 1 ? '' : 's'} go` };
  }
  const description = cleanStr(b.change_description);
  if (description.length < 10) {
    return { error: 'Describe the change in at least a few words — the operator relies on this' };
  }
  return {
    rawPages: String(b.modified_pages).trim(),
    normalised: parsed.normalised,
    pages: parsed.pages,
    count: parsed.count,
    additional,
    insertPosition,
    description,
  };
};

// ── Jobs sitting in the proof/rework loop (coordinator's working list) ──
router.get('/proof-review', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const loc = scopeLocation(req);
    const jobs = db.prepare(
      `SELECT j.*, u.name AS requestor_name, op.name AS operator_name, l.name AS location_name,
              (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count,
              (SELECT r.rework_id FROM print_job_reworks r
                WHERE r.job_id = j.id AND r.status IN ('pending','in_progress')) AS open_rework_id,
              (SELECT r.id FROM print_job_reworks r
                WHERE r.job_id = j.id AND r.status IN ('pending','in_progress')) AS open_rework_row_id,
              (SELECT r.status FROM print_job_reworks r
                WHERE r.job_id = j.id AND r.status IN ('pending','in_progress')) AS open_rework_status,
              (SELECT r.assigned_operator_id FROM print_job_reworks r
                WHERE r.job_id = j.id AND r.status IN ('pending','in_progress')) AS open_rework_operator_id,
              -- Who the rework went to. Without this the queue could only say "queued",
              -- never to whom, which is why an assigned rework read as unfinished.
              (SELECT ro.name FROM print_job_reworks r
                 JOIN users ro ON ro.id = r.assigned_operator_id
                WHERE r.job_id = j.id AND r.status IN ('pending','in_progress')) AS open_rework_operator_name,
              (SELECT r.created_by FROM print_job_reworks r
                WHERE r.job_id = j.id AND r.status IN ('pending','in_progress')) AS open_rework_created_by
         FROM print_jobs j
         JOIN users u ON j.created_by = u.id
         LEFT JOIN users op ON j.assigned_operator_id = op.id
         LEFT JOIN locations l ON j.location_id = l.id
        WHERE j.status IN ('proof_review','rework_requested','rework_printing') AND ${locScopeSql()}
        ORDER BY j.proof_released_at ASC`
    ).all(loc, loc);
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching proof-review jobs:', error);
    res.status(500).json({ error: 'Failed to fetch proof review jobs' });
  }
});

// ── Release a printed proof to the requestor for offline review ──
router.post('/:id/release-proof', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['printing_completed', 'ready_for_collection'].includes(job.status)) {
      return res.status(400).json({ error: `Only a printed job can go out for proof review (this one is ${job.status})` });
    }
    db.prepare(
      `UPDATE print_jobs SET status='proof_review', proof_released_at=datetime('now'),
         updated_at=datetime('now') WHERE id=?`
    ).run(job.id);
    writeAudit(req, 'RELEASE_PROOF', job.id, `${jobLabel(job)} proof copy (V${job.current_version || 1}) released for review`);
    notifyUser(job.created_by, 'Proof copy ready for your review',
      `${jobLabel(job)} — review the printed copy and send any corrections to the printing coordinator.`, 'info');
    fireEmail(notifyPrintProofReleased(
      buildEmailJob(job, { versionNo: job.current_version || 1 }),
      getUserContact(job.created_by).email
    ));
    res.json({ message: `${jobLabel(job)} released for proof review.` });
  } catch (error) {
    console.error('Error releasing proof:', error);
    res.status(500).json({ error: 'Failed to release proof' });
  }
});

// ── Record the requestor's verdict on the proof ──
router.post('/:id/proof-verdict', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'proof_review') {
      return res.status(400).json({ error: `Only a job under proof review has a verdict (this one is ${job.status})` });
    }
    const approved = req.body?.approved === true || req.body?.approved === 'true';
    const notes = cleanStr(req.body?.notes);

    if (approved) {
      db.prepare(`UPDATE print_jobs SET status='ready_for_collection', ready_at=COALESCE(ready_at, datetime('now')),
                    updated_at=datetime('now') WHERE id=?`).run(job.id);
      writeAudit(req, 'PROOF_APPROVED', job.id, `${jobLabel(job)} proof approved — no corrections${notes ? ` — ${notes}` : ''}`);
      notifyUser(job.created_by, 'Proof approved', `${jobLabel(job)} is approved and ready for collection.`, 'success');
      return res.json({ status: 'ready_for_collection', message: `${jobLabel(job)} approved and ready for collection.` });
    }

    db.prepare(`UPDATE print_jobs SET status='rework_requested', updated_at=datetime('now') WHERE id=?`).run(job.id);
    writeAudit(req, 'REWORK_REQUESTED', job.id, `${jobLabel(job)} corrections reported by requestor${notes ? ` — ${notes}` : ''}`);
    notifyCoordinators('Corrections reported', `${jobLabel(job)} needs a rework — log the revised PDF.`);
    res.json({ status: 'rework_requested', message: `${jobLabel(job)} marked for rework. The requestor sends the revised PDF.` });
  } catch (error) {
    console.error('Error recording proof verdict:', error);
    res.status(500).json({ error: 'Failed to record verdict' });
  }
});

// A rework can only be raised by the person who submitted the job — see
// POST /:id/reworks/request below. The coordinator no longer creates reworks:
// they own scheduling (assign an operator) and cancelling, not authoring the
// correction, because only the requestor knows what changed in their document.


// ── Submission snapshots ────────────────────────────────────────────────────
// Called on every submit, before the status changes. Stores the request exactly as
// it stands, so a later resubmit can be compared against it and the verifier can be
// told what moved rather than re-reading the form.
const SUBMISSION_TRIGGERS = { recalled: 'after_recall', returned: 'after_return' };

const recordSubmission = (req, job, docs) => {
  try {
    const seq = (db.prepare('SELECT MAX(seq) AS s FROM print_job_submissions WHERE job_id = ?').get(job.id)?.s || 0) + 1;
    const triggerKind = SUBMISSION_TRIGGERS[job.status] || 'initial';
    const triggerReason = job.status === 'recalled' ? job.recall_reason
      : job.status === 'returned' ? job.return_reason
      : null;

    const header = {};
    for (const [field] of HEADER_FIELDS) header[field] = job[field] ?? null;

    const documents = docs.map((d) => ({
      document_name: d.document_name, quantity: d.quantity, num_pages: d.num_pages,
      print_side: d.print_side, paper_size: d.paper_size, paper_gsm: d.paper_gsm,
      color_mode: d.color_mode, cover_page: d.cover_page, soft_lamination: d.soft_lamination,
      separators: d.separators, separator_thickness: d.separator_thickness,
      hole_punch: d.hole_punch, binding_type: d.binding_type,
      binding_variant: d.binding_variant, extra_services: d.extra_services,
      file_colour: d.file_colour,
      remarks: d.remarks, pdf_sha256: d.pdf_sha256 || null, pdf_path: d.pdf_path || null,
    }));

    const totals = rollUps(documents);

    // Compare against the previous submission so the change count can go straight
    // into the audit line and the response.
    let changeCount = null;
    if (seq > 1) {
      const prev = db.prepare('SELECT header_json, documents_json FROM print_job_submissions WHERE job_id = ? ORDER BY seq DESC LIMIT 1').get(job.id);
      if (prev) {
        const diff = diffSubmissions(
          { header: JSON.parse(prev.header_json), documents: JSON.parse(prev.documents_json) },
          { header, documents },
        );
        changeCount = diff.changeCount;
      }
    }

    db.prepare(
      `INSERT INTO print_job_submissions
         (job_id, seq, submitted_by, trigger_kind, trigger_reason, header_json, documents_json, books, copies, pages)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(job.id, seq, req.user.id, triggerKind, triggerReason || null,
          JSON.stringify(header), JSON.stringify(documents), totals.books, totals.copies, totals.pages);

    return { seq, changeCount };
  } catch (e) {
    // A snapshot is a record, not a gate: never block a submission over it.
    console.error('[jobs] recordSubmission failed:', e.message);
    return { seq: 0, changeCount: null };
  }
};

// ── Submission history with the diff between consecutive submissions ──
router.get('/:id/submissions', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!canViewJob(req, job)) return res.status(403).json({ error: 'Not authorized' });

    const rows = db.prepare(
      `SELECT s.*, u.name AS submitted_by_name
         FROM print_job_submissions s
         JOIN users u ON u.id = s.submitted_by
        WHERE s.job_id = ?
        ORDER BY s.seq`
    ).all(job.id);

    const parsed = rows.map((r) => ({
      seq: r.seq,
      submittedBy: r.submitted_by_name,
      submittedAt: r.submitted_at,
      triggerKind: r.trigger_kind,
      triggerReason: r.trigger_reason,
      totals: { books: r.books, copies: r.copies, pages: r.pages },
      header: JSON.parse(r.header_json),
      documents: JSON.parse(r.documents_json),
    }));

    // Attach each submission's diff against the one before it.
    const submissions = parsed.map((cur, i) => ({
      ...cur,
      diff: i === 0 ? null : diffSubmissions(parsed[i - 1], cur),
      summary: i === 0 ? 'Initial submission' : summariseDiff(diffSubmissions(parsed[i - 1], cur)),
    }));

    res.json({ jobNumber: job.job_number, submissions });
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ error: 'Failed to fetch submission history' });
  }
});

// ── Compare any two submissions ──
router.get('/:id/submissions/:a/diff/:b', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!canViewJob(req, job)) return res.status(403).json({ error: 'Not authorized' });

    const get = (seq) => db.prepare('SELECT header_json, documents_json, seq FROM print_job_submissions WHERE job_id = ? AND seq = ?').get(job.id, seq);
    const from = get(Number(req.params.a));
    const to = get(Number(req.params.b));
    if (!from || !to) return res.status(404).json({ error: 'One of those submissions does not exist' });

    const shape = (r) => ({ header: JSON.parse(r.header_json), documents: JSON.parse(r.documents_json) });
    const diff = diffSubmissions(shape(from), shape(to));
    res.json({ from: from.seq, to: to.seq, diff, summary: summariseDiff(diff) });
  } catch (error) {
    console.error('Error diffing submissions:', error);
    res.status(500).json({ error: 'Failed to compare submissions' });
  }
});

// ── Requestor pulls their own job back to fix it, before anything is printed ──
// Keeps the same REQ/JOB number and every document; the job simply returns to an
// editable state and goes back through verification when resubmitted.
router.post('/:id/recall', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Request not found' });
    if (job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only recall your own request' });
    }
    if (!RECALLABLE_STATES.includes(job.status)) {
      const printed = ['printing_completed', 'proof_review', 'rework_requested', 'ready_for_collection', 'completed'].includes(job.status);
      return res.status(400).json({
        error: printed
          ? `${jobLabel(job)} has already been printed — use Request rework to send a corrected document instead.`
          : `${jobLabel(job)} is already with the operator and cannot be recalled. Ask the printing coordinator.`,
      });
    }
    if (job.assigned_operator_id) {
      return res.status(400).json({ error: `${jobLabel(job)} is already assigned to an operator. Ask the printing coordinator.` });
    }

    const reason = cleanStr(req.body?.reason);
    db.prepare(
      `UPDATE print_jobs SET status='recalled', recalled_at=datetime('now'), recall_reason=?,
         updated_at=datetime('now')
       WHERE id=?`
    ).run(reason || null, job.id);

    writeAudit(req, 'RECALL_PRINT_JOB', job.id,
      `${jobLabel(job)} recalled by ${req.user.name} for correction${reason ? ` — ${reason}` : ''}`);
    notifyCoordinators('Request recalled',
      `${jobLabel(job)} was pulled back by ${req.user.name} for correction. It will return once resubmitted.`);

    res.json({ message: `${jobLabel(job)} recalled. Edit it and submit again — it keeps the same number.` });
  } catch (error) {
    console.error('Error recalling job:', error);
    res.status(500).json({ error: 'Failed to recall the request' });
  }
});

// ── Requestor raises a rework from their own screen ──
// Same evidence as the coordinator's form minus the operator: the requestor knows
// what changed, not who is free at the press. The rework lands unassigned and the
// coordinator assigns it, so nothing reaches the press without being seen.
router.post('/:id/reworks/request', authenticateToken, upload.single('pdf'), async (req, res) => {
  const cleanupUpload = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) { cleanupUpload(); return res.status(404).json({ error: 'Job not found' }); }
    if (job.created_by !== req.user.id) {
      cleanupUpload();
      return res.status(403).json({ error: 'Only the person who raised this job can request a rework on it' });
    }
    // A rework replaces printed output, so there has to be printed output first.
    if (!REWORKABLE_STATUSES.includes(job.status)) {
      cleanupUpload();
      return res.status(400).json({ error: `${jobLabel(job)} has nothing printed to rework yet (it is ${job.status})` });
    }
    if (!req.file) return res.status(400).json({ error: 'Attach the complete revised PDF' });

    const open = db.prepare(
      `SELECT rework_id FROM print_job_reworks WHERE job_id = ? AND status IN ('pending','in_progress')`
    ).get(job.id);
    if (open) {
      cleanupUpload();
      return res.status(409).json({ error: `${open.rework_id} is already open on this job. Wait for it to finish.` });
    }

    const absPath = path.join(uploadDir, req.file.filename);
    const numPages = await readPdfPageCount(absPath);
    const check = validateReworkFields(req.body || {}, numPages);
    if (check.error) { cleanupUpload(); return res.status(400).json({ error: check.error }); }

    const versionNo = (db.prepare('SELECT MAX(version_no) AS v FROM print_job_reworks WHERE job_id = ?').get(job.id)?.v || 1) + 1;
    const reworkId = nextReworkId();

    db.prepare(
      `INSERT INTO print_job_reworks (
         rework_id, job_id, version_no, pdf_path, pdf_original_name, pdf_size_bytes,
         pdf_sha256, num_pages, modified_pages, modified_pages_norm, modified_page_count,
         additional_pages, insert_position, change_description,
         created_by, assigned_operator_id, status
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, NULL, 'pending')`
    ).run(
      reworkId, job.id, versionNo,
      req.file.filename, req.file.originalname, req.file.size,
      sha256OfFile(absPath), numPages,
      check.rawPages, check.normalised, check.count,
      check.additional, check.insertPosition || null, check.description,
      req.user.id
    );

    db.prepare(
      `UPDATE print_jobs SET status='rework_requested', current_version=?, rework_count=rework_count+1,
         last_rework_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`
    ).run(versionNo, job.id);

    const pageSummary = describePageList(check.normalised, check.count);
    writeAudit(req, 'REQUEST_REWORK', job.id,
      `${reworkId} requested as V${versionNo} by ${req.user.name} — ${pageSummary}` +
      `${check.additional ? `, +${check.additional} ${check.insertPosition}` : ''}`);

    notifyCoordinators('Rework requested',
      `${jobLabel(job)} — ${req.user.name} sent a revised PDF (V${versionNo}). Assign an operator.`);
    fireEmail(notifyPrintReworkRequested(
      buildEmailJob(job, {
        reworkId, versionNo, modifiedPages: check.normalised.replace(/,/g, ', '),
        additionalPages: check.additional, insertPosition: check.insertPosition,
        changeDescription: check.description,
      }),
      coordinatorContacts().map((c) => c.email)
    ));

    res.status(201).json({
      rework_id: reworkId,
      version_no: versionNo,
      modified_pages: { normalised: check.normalised, expanded: check.pages, count: check.count },
      message: `Rework ${reworkId} requested as V${versionNo}. The printing coordinator will assign it.`,
    });
  } catch (error) {
    cleanupUpload();
    console.error('Error requesting rework:', error);
    res.status(500).json({ error: 'Failed to request rework' });
  }
});

// ── Coordinator assigns (or re-assigns) an operator to a rework ──
router.post('/:id/reworks/:rid/assign', authenticateToken, async (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const rw = db.prepare('SELECT * FROM print_job_reworks WHERE id = ? AND job_id = ?').get(req.params.rid, job.id);
    if (!rw) return res.status(404).json({ error: 'Rework not found' });
    if (rw.status !== 'pending') {
      return res.status(400).json({ error: `Only an unstarted rework can be assigned (this one is ${rw.status})` });
    }
    const operatorId = req.body?.operator_id ? Number(req.body.operator_id) : null;
    if (!operatorId || !isOperatorUser(operatorId)) {
      return res.status(400).json({ error: 'Pick an active printer operator' });
    }

    // Last gate before the press: a range like 12-15 against a 10-page PDF is caught
    // here rather than by the operator at the machine.
    const pageCheck = await verifyReworkPages(rw);
    if (!pageCheck.error && pageCheck.ok === false) {
      return res.status(409).json({ error: 'The rework page range could not be verified.' });
    }
    if (pageCheck.error) {
      return res.status(409).json({
        error: `${reworkLabel(rw)} cannot be assigned — ${pageCheck.error} `
             + `It says "${rw.modified_pages_norm || rw.modified_pages}" but the revised PDF has `
             + `${pageCheck.numPages} page${pageCheck.numPages === 1 ? '' : 's'}. `
             + 'Ask for a corrected page range, or cancel and re-raise the rework.',
        code: 'PAGE_RANGE_INVALID',
        modified_pages: rw.modified_pages_norm || rw.modified_pages,
        pdf_pages: pageCheck.numPages,
      });
    }

    db.prepare(
      `UPDATE print_job_reworks SET assigned_operator_id=?, assigned_at=datetime('now') WHERE id=?`
    ).run(operatorId, rw.id);
    db.prepare(
      `UPDATE print_jobs SET assigned_operator_id=?, updated_at=datetime('now') WHERE id=?`
    ).run(operatorId, job.id);

    const operator = getUserContact(operatorId);
    writeAudit(req, 'ASSIGN_REWORK', job.id, `${reworkLabel(rw)} assigned to ${operator.name || 'operator'}`);
    notifyUser(operatorId, `Rework ${rw.rework_id} assigned to you`,
      `${jobLabel(job)} V${rw.version_no} — reprint ${describePageList(rw.modified_pages_norm, rw.modified_page_count)}.`, 'info');
    fireEmail(notifyPrintReworkAssigned(
      buildEmailJob(job, {
        reworkId: rw.rework_id, versionNo: rw.version_no,
        modifiedPages: (rw.modified_pages_norm || '').replace(/,/g, ', '),
        additionalPages: rw.additional_pages, insertPosition: rw.insert_position,
        changeDescription: rw.change_description, operatorName: operator.name,
      }),
      operator.email
    ));
    res.json({
      message: `${reworkLabel(rw)} assigned to ${operator.name || 'the operator'}.`
             + (pageCheck.warning ? ` Note: ${pageCheck.warning}` : ''),
      // Distinguished from `message` so the UI can flag an unverified assignment
      // rather than letting it read as a clean pass.
      warning: pageCheck.warning || null,
      pdf_pages: pageCheck.numPages,
    });
  } catch (error) {
    console.error('Error assigning rework:', error);
    res.status(500).json({ error: 'Failed to assign rework' });
  }
});

// ── All reworks for a job ──
router.get('/:id/reworks', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!canViewJob(req, job)) return res.status(403).json({ error: 'Not authorized' });
    const rows = db.prepare(
      `SELECT r.*, c.name AS created_by_name, o.name AS operator_name
         FROM print_job_reworks r
         JOIN users c ON c.id = r.created_by
         LEFT JOIN users o ON o.id = r.assigned_operator_id
        WHERE r.job_id = ?
        ORDER BY r.version_no DESC`
    ).all(job.id);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching reworks:', error);
    res.status(500).json({ error: 'Failed to fetch reworks' });
  }
});

// ── Unified version history: V1 (original submission) + every rework ──
router.get('/:id/versions', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!canViewJob(req, job)) return res.status(403).json({ error: 'Not authorized' });

    const requestor = getUserContact(job.created_by);
    const originals = db.prepare('SELECT id, document_name, num_pages FROM print_job_documents WHERE job_id = ?').all(job.id);
    const versions = [{
      version_no: 1,
      kind: 'Original submission',
      uploaded_by: requestor.name,
      uploaded_by_role: 'Requestor',
      uploaded_at: job.submitted_at || job.created_at,
      num_pages: originals.reduce((sum, d) => sum + (d.num_pages || 0), 0) || null,
      modified_pages: null,
      additional_pages: 0,
      document_id: originals[0]?.id ?? null,
      rework_id: null,
      status: 'completed',
    }];

    db.prepare(
      `SELECT r.*, c.name AS created_by_name FROM print_job_reworks r
         JOIN users c ON c.id = r.created_by
        WHERE r.job_id = ? AND r.status != 'cancelled'
        ORDER BY r.version_no`
    ).all(job.id).forEach((r) => {
      versions.push({
        version_no: r.version_no,
        kind: `Rework ${r.version_no - 1}`,
        uploaded_by: r.created_by_name,
        uploaded_by_role: 'Coordinator',
        uploaded_at: r.created_at,
        num_pages: r.num_pages,
        modified_pages: r.modified_pages_norm,
        additional_pages: r.additional_pages,
        insert_position: r.insert_position,
        change_description: r.change_description,
        document_id: null,
        rework_id: r.rework_id,
        rework_row_id: r.id,
        status: r.status,
      });
    });

    res.json(versions);
  } catch (error) {
    console.error('Error building version history:', error);
    res.status(500).json({ error: 'Failed to build version history' });
  }
});

// ── Download the PDF for one rework version ──
router.get('/:id/reworks/:rid/file', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!canViewJob(req, job)) return res.status(403).json({ error: 'Not authorized' });
    const rw = db.prepare('SELECT * FROM print_job_reworks WHERE id = ? AND job_id = ?').get(req.params.rid, job.id);
    if (!rw || !rw.pdf_path) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(uploadDir, rw.pdf_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error downloading rework PDF:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// ── Operator starts a rework ──
router.post('/:id/reworks/:rid/start', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const rw = db.prepare('SELECT * FROM print_job_reworks WHERE id = ? AND job_id = ?').get(req.params.rid, job.id);
    if (!rw) return res.status(404).json({ error: 'Rework not found' });
    if (rw.assigned_operator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned operator can do this' });
    }
    if (rw.status !== 'pending') return res.status(400).json({ error: `This rework is already ${rw.status}` });

    db.prepare(`UPDATE print_job_reworks SET status='in_progress', started_at=datetime('now') WHERE id=?`).run(rw.id);
    db.prepare(`UPDATE print_jobs SET status='rework_printing', updated_at=datetime('now') WHERE id=?`).run(job.id);
    writeAudit(req, 'START_REWORK', job.id, `${reworkLabel(rw)} started by ${req.user.name}`);
    res.json({ message: `${reworkLabel(rw)} started.` });
  } catch (error) {
    console.error('Error starting rework:', error);
    res.status(500).json({ error: 'Failed to start rework' });
  }
});

// ── Operator completes a rework → back to proof review ──
router.post('/:id/reworks/:rid/complete', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const rw = db.prepare('SELECT * FROM print_job_reworks WHERE id = ? AND job_id = ?').get(req.params.rid, job.id);
    if (!rw) return res.status(404).json({ error: 'Rework not found' });
    if (rw.assigned_operator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned operator can do this' });
    }
    if (rw.status !== 'in_progress') return res.status(400).json({ error: `Only a started rework can be completed (this one is ${rw.status})` });

    db.prepare(`UPDATE print_job_reworks SET status='completed', completed_at=datetime('now') WHERE id=?`).run(rw.id);
    db.prepare(`UPDATE print_jobs SET status='printing_completed', printing_completed_at=datetime('now'),
                  updated_at=datetime('now') WHERE id=?`).run(job.id);
    writeAudit(req, 'COMPLETE_REWORK', job.id, `${reworkLabel(rw)} completed by ${req.user.name}`);
    notifyCoordinators('Rework finished', `${reworkLabel(rw)} on ${jobLabel(job)} is printed — release the new proof.`);
    fireEmail(notifyPrintReworkCompleted(
      buildEmailJob(job, { reworkId: rw.rework_id, versionNo: rw.version_no, operatorName: req.user.name }),
      coordinatorContacts().map((c) => c.email)
    ));
    res.json({ message: `${reworkLabel(rw)} completed.` });
  } catch (error) {
    console.error('Error completing rework:', error);
    res.status(500).json({ error: 'Failed to complete rework' });
  }
});

// ── Cancel a rework that has not started ──
router.post('/:id/reworks/:rid/cancel', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const rw = db.prepare('SELECT * FROM print_job_reworks WHERE id = ? AND job_id = ?').get(req.params.rid, job.id);
    if (!rw) return res.status(404).json({ error: 'Rework not found' });
    if (rw.status !== 'pending') return res.status(400).json({ error: `Only an unstarted rework can be cancelled (this one is ${rw.status})` });
    const reason = cleanStr(req.body?.reason);
    if (!reason) return res.status(400).json({ error: 'Give a reason so the history explains itself' });

    // The version number stays burnt — reusing it would make two different PDFs
    // share a version in the audit trail.
    db.prepare(`UPDATE print_job_reworks SET status='cancelled', cancel_reason=? WHERE id=?`).run(reason, rw.id);
    db.prepare(`UPDATE print_jobs SET status='rework_requested', updated_at=datetime('now') WHERE id=?`).run(job.id);
    writeAudit(req, 'CANCEL_REWORK', job.id, `${reworkLabel(rw)} cancelled — ${reason}`);
    res.json({ message: `${reworkLabel(rw)} cancelled.` });
  } catch (error) {
    console.error('Error cancelling rework:', error);
    res.status(500).json({ error: 'Failed to cancel rework' });
  }
});

// ── This operator's open reworks across all jobs ──
router.get('/reworks/assigned', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT r.*, j.job_number, j.request_id, j.project_name, c.name AS created_by_name
         FROM print_job_reworks r
         JOIN print_jobs j ON j.id = r.job_id
         JOIN users c ON c.id = r.created_by
        WHERE r.assigned_operator_id = ? AND r.status IN ('pending','in_progress')
        ORDER BY r.created_at ASC`
    ).all(req.user.id);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching assigned reworks:', error);
    res.status(500).json({ error: 'Failed to fetch assigned reworks' });
  }
});

// A completed job must have its cost annexure straight away — that is what makes the
// cost visible to the requestor, the operator and the coordinator at all. It used to
// wait for a coordinator to press "Issue annexure", so until someone remembered, a
// finished job showed no cost to anybody.
//
// Deliberately never throws: costing must not be able to fail a job's completion. If
// no rate card covers the completion date, the job still completes and a coordinator
// can issue it by hand once the card is in place.
const autoIssueAnnexure = (req, jobId) => {
  try {
    const fresh = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
    const result = issueAnnexureForJob(fresh, req.user.id, req.ip || null);
    if (result.error) {
      if (!result.existing) console.warn(`[jobs] auto-issue annexure for job ${jobId}: ${result.error}`);
      return null;
    }
    notifyUser(fresh.created_by, 'Printing cost ready for your approval',
      `${result.annexure_no} for ${jobLabel(fresh)} — ${result.grand_total_display}. `
      + 'Review and approve it from My Printing Jobs.', 'info');
    return result;
  } catch (e) {
    console.error(`[jobs] auto-issue annexure for job ${jobId} failed:`, e);
    return null;
  }
};

// ── Phase 10: coordinator hands over → awaits the requestor's confirmation ──
// The coordinator can only record that they *gave* the materials; whether they
// were received is the requestor's to state, so this stops at 'awaiting_receipt'
// and POST /:id/confirm-receipt below is what closes the job.
router.post('/:id/collect', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'ready_for_collection') return res.status(400).json({ error: `Only a ready job can be handed over (job is ${job.status})` });
    db.prepare(
      `UPDATE print_jobs SET status='awaiting_receipt', handed_over_by=?, handed_over_at=datetime('now'),
         updated_at=datetime('now')
       WHERE id=?`
    ).run(req.user.name, job.id);
    writeAudit(req, 'HANDOVER_PRINT_JOB', job.id, `${jobLabel(job)} handed over — awaiting requestor confirmation`);
    notifyUser(
      job.created_by,
      'Confirm you received your printing job',
      `${jobLabel(job)} has been handed over. Please confirm receipt in Job History.`,
      'info'
    );
    fireEmail(notifyPrintJobAwaitingReceipt(
      buildEmailJob(job, { handedOverBy: req.user.name }),
      getUserContact(job.created_by).email
    ));
    res.json({ message: `${jobLabel(job)} handed over — waiting for the requestor to confirm receipt.` });
  } catch (error) {
    console.error('Error handing over job:', error);
    res.status(500).json({ error: 'Failed to hand over job' });
  }
});

// ── The requestor confirms the materials actually reached them → completed ──
router.post('/:id/confirm-receipt', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    // Deliberately NOT open to coordinators or admins: the whole point is that
    // the person who received the materials is the one who says so.
    if (job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Only the requestor who raised this job can confirm receipt' });
    }
    if (job.status !== 'awaiting_receipt') {
      return res.status(400).json({ error: `Only a handed-over job can be confirmed (job is ${job.status})` });
    }
    const remarks = cleanStr(req.body?.remarks);
    db.prepare(
      `UPDATE print_jobs SET status='completed', received_by=?, received_by_user_id=?,
         received_at=datetime('now'), completed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`
    ).run(req.user.name, req.user.id, job.id);
    writeAudit(req, 'CONFIRM_PRINT_RECEIPT', job.id, `${jobLabel(job)} receipt confirmed by ${req.user.name}${remarks ? ` — ${remarks}` : ''}`);
    notifyCoordinators('Printing Receipt Confirmed', `${jobLabel(job)} — ${req.user.name} confirmed receipt.`);
    fireEmail(notifyPrintJobReceiptConfirmed(
      buildEmailJob(job, { receivedBy: req.user.name }),
      coordinatorContacts().map((c) => c.email)
    ));
    const annexure = autoIssueAnnexure(req, job.id);
    res.json({
      message: `Receipt confirmed for ${jobLabel(job)}. Thank you.`,
      annexure_no: annexure?.annexure_no || null,
    });
  } catch (error) {
    console.error('Error confirming receipt:', error);
    res.status(500).json({ error: 'Failed to confirm receipt' });
  }
});

// ── Dispatch: courier a ready job instead of local handover ─────────────────
router.post('/:id/dispatch', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'ready_for_collection') return res.status(400).json({ error: `Only a ready job can be dispatched (job is ${job.status})` });
    const b = req.body || {};
    const courier = cleanStr(b.courier_name);
    if (!courier) return res.status(400).json({ error: 'Courier / carrier is required' });
    const docket = cleanStr(b.docket_no);
    const books = b.books ? parseInt(b.books, 10) : null;
    const packets = cleanStr(b.packets);
    const remarks = cleanStr(b.remarks);
    db.prepare(
      `UPDATE print_jobs SET status='dispatched', courier_name=?, docket_no=?, dispatch_books=?,
         dispatch_packets=?, dispatch_remarks=?, dispatched_by=?, dispatched_at=datetime('now'),
         updated_at=datetime('now')
       WHERE id=?`
    ).run(courier, docket, books, packets, remarks, req.user.name, job.id);
    const detail = `Dispatched via ${courier}${docket ? ` (docket ${docket})` : ''}${books ? `, ${books} book(s)` : ''}${packets ? `, ${packets} packet(s)` : ''}`;
    writeAudit(req, 'DISPATCH_PRINT_JOB', job.id, detail);
    notifyUser(job.created_by, 'Printing Job Dispatched', `${jobLabel(job)} — ${detail}`, 'info');
    notifyCoordinators('Job Dispatched', `${jobLabel(job)} ${detail}`);
    res.json({ message: `${jobLabel(job)} dispatched.` });
  } catch (error) {
    console.error('Error dispatching job:', error);
    res.status(500).json({ error: 'Failed to dispatch job' });
  }
});

// ── Deliver: confirm a dispatched job was received → completed ──────────────
router.post('/:id/deliver', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'dispatched') return res.status(400).json({ error: `Only a dispatched job can be delivered (job is ${job.status})` });
    const receivedBy = cleanStr(req.body?.received_by);
    db.prepare(
      `UPDATE print_jobs SET status='completed', received_by=?, delivered_at=datetime('now'),
         completed_at=COALESCE(completed_at, datetime('now')), updated_at=datetime('now')
       WHERE id=?`
    ).run(receivedBy, job.id);
    const detail = `Delivered${receivedBy ? `, received by ${receivedBy}` : ''}`;
    writeAudit(req, 'DELIVER_PRINT_JOB', job.id, detail);
    notifyUser(job.created_by, 'Printing Job Delivered', `${jobLabel(job)} — ${detail}`, 'success');
    const annexure = autoIssueAnnexure(req, job.id);
    res.json({
      message: `${jobLabel(job)} marked delivered & completed.`,
      annexure_no: annexure?.annexure_no || null,
    });
  } catch (error) {
    console.error('Error delivering job:', error);
    res.status(500).json({ error: 'Failed to mark delivered' });
  }
});

// Activity log (timeline) for a job — chronological events from the audit trail,
// plus roll-up quantity totals (books/copies/pages). Access-checked.
router.get('/:id/log', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Request not found' });
    if (!canViewJob(req, job)) return res.status(403).json({ error: 'Not authorized' });
    const events = db
      .prepare(
        `SELECT action, details, user_name, created_at
         FROM audit_logs
         WHERE entity_type = 'print_job' AND entity_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(job.id);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS documents,
                COALESCE(SUM(quantity), 0) AS copies,
                COALESCE(SUM(COALESCE(num_pages, 0) * quantity), 0) AS pages
         FROM print_job_documents WHERE job_id = ?`
      )
      .get(job.id);
    res.json({ events, totals });
  } catch (error) {
    console.error('Error fetching job log:', error);
    res.status(500).json({ error: 'Failed to fetch job log' });
  }
});

// One job with its documents (access-checked).
router.get('/:id', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Request not found' });
    if (!canViewJob(req, job)) return res.status(403).json({ error: 'Not authorized' });
    const documents = db
      .prepare('SELECT * FROM print_job_documents WHERE job_id = ? ORDER BY id ASC')
      .all(job.id);

    // Which PDF is the current one for each document.
    //
    // print_job_documents.pdf_path is the ORIGINAL file and stays that way for
    // history. Once a rework exists, that file is superseded — serving it to an
    // operator means they print the version that was already rejected. Every caller
    // gets told the current version and where to fetch it, so nobody has to know the
    // rule.
    const latestRework = db.prepare(
      `SELECT id, document_id, version_no, rework_id, modified_pages_norm, additional_pages, insert_position
         FROM print_job_reworks
        WHERE job_id = ? AND status != 'cancelled'
        ORDER BY version_no DESC`
    ).all(job.id);

    const withCurrent = documents.map((d) => {
      // A rework naming this document wins; one with no document_id applies to a
      // single-document job.
      const rw = latestRework.find((r) => r.document_id === d.id)
        || (documents.length === 1 ? latestRework.find((r) => r.document_id == null) : null);
      return {
        ...d,
        current_version: rw ? rw.version_no : 1,
        current_rework_row_id: rw ? rw.id : null,
        current_rework_id: rw ? rw.rework_id : null,
        current_file_url: rw
          ? `/api/jobs/${job.id}/reworks/${rw.id}/file`
          : `/api/jobs/${job.id}/documents/${d.id}/file`,
        superseded: !!rw,
        rework_pages: rw ? rw.modified_pages_norm : null,
        rework_additional: rw ? rw.additional_pages : null,
        rework_insert_position: rw ? rw.insert_position : null,
      };
    });

    const location_name = job.location_id
      ? (db.prepare('SELECT name FROM locations WHERE id = ?').get(job.location_id)?.name || null)
      : null;
    res.json({ ...job, location_name, documents: withCurrent });
  } catch (error) {
    console.error('Error fetching print job:', error);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

export default router;
