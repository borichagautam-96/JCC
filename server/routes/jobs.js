import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import {
  notifyPrintJobSubmitted,
  notifyPrintJobAccepted,
  notifyPrintJobReturned,
  notifyPrintJobRejected,
  notifyPrintJobAssigned,
  notifyPrintJobReady,
  notifyPrintJobCompleted,
} from '../utils/emailService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Roles allowed to raise a printing request (same set that creates JCCs).
const REQUESTOR_ROLES = ['initiator', 'user', 'admin'];
// Editable states — the requestor may add/remove documents and resubmit only here.
const EDITABLE_STATES = ['draft', 'returned'];

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
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — print PDFs can be large
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
    return db.prepare('SELECT id, name, email FROM users WHERE is_printer_coordinator = 1').all();
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
           hole_punch, binding_type, file_colour, remarks
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        cleanStr(b.file_colour),
        cleanStr(b.remarks)
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
    db.prepare(
      `UPDATE print_jobs SET
         job_number = ?, status = 'submitted',
         submitted_at = datetime('now'),
         return_reason = NULL,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(jobNumber, job.id);

    writeAudit(req, 'SUBMIT_PRINT_JOB', job.id, `${jobNumber} submitted for coordinator verification`);
    notifyCoordinators(
      'New Printing Job Submitted',
      `${jobNumber} from ${req.user.name} is awaiting your verification.`
    );
    fireEmail(notifyPrintJobSubmitted(buildEmailJob({ ...job, job_number: jobNumber }), coordinatorContacts().map((c) => c.email)));
    res.json({ job_number: jobNumber, message: `${jobNumber} submitted for coordinator verification.` });
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
                (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count
         FROM print_jobs j
         LEFT JOIN locations l ON j.location_id = l.id
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
// Checked fresh from the DB so a flag change takes effect without re-login. Admin
// always has oversight.
const isCoordinator = (req) => {
  if (req.user.role === 'admin') return true;
  const row = db.prepare('SELECT is_printer_coordinator FROM users WHERE id = ?').get(req.user.id);
  return !!(row && row.is_printer_coordinator);
};
const isOperatorUser = (userId) => {
  const row = db.prepare('SELECT is_printer_operator FROM users WHERE id = ?').get(userId);
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
                (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count
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
         WHERE (j.assigned_operator_id = ? AND j.status IN ('assigned','printing','paused','printing_completed','ready_for_collection'))
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
           FROM users u WHERE u.is_printer_operator = 1 AND ${locScopeSql('u.location_id')} ORDER BY u.name`
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

// ── Phase 10: coordinator verifies handover → completed (read-only) ─────────
router.post('/:id/collect', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'ready_for_collection') return res.status(400).json({ error: `Only a ready job can be closed (job is ${job.status})` });
    db.prepare(`UPDATE print_jobs SET status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(job.id);
    writeAudit(req, 'COMPLETE_PRINT_JOB', job.id, `${jobLabel(job)} collected and closed`);
    notifyUser(job.created_by, 'Printing Job Completed', `${jobLabel(job)} has been collected and closed.`, 'success');
    fireEmail(notifyPrintJobCompleted(buildEmailJob(job), getUserContact(job.created_by).email));
    res.json({ message: `${jobLabel(job)} completed.` });
  } catch (error) {
    console.error('Error completing job:', error);
    res.status(500).json({ error: 'Failed to complete job' });
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
    res.json({ message: `${jobLabel(job)} marked delivered & completed.` });
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
    const location_name = job.location_id
      ? (db.prepare('SELECT name FROM locations WHERE id = ?').get(job.location_id)?.name || null)
      : null;
    res.json({ ...job, location_name, documents });
  } catch (error) {
    console.error('Error fetching print job:', error);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

export default router;
