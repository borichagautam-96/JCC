import express from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { authenticateToken } from '../middleware/auth.js';
import { summarise, paiseToRupees, amountInWords, milliToRate, lineAmountPaise } from '../utils/costEngine.js';
import { itemsForDocument, itemsForRework, priceItems } from '../utils/costPrinting.js';

const router = express.Router();

const isCoordinator = (req) => {
  if (req.user.role === 'admin') return true;
  const row = db.prepare('SELECT is_printer_coordinator FROM users WHERE id = ?').get(req.user.id);
  return !!(row && row.is_printer_coordinator);
};

// ── Rate resolution against the card in force ────────────────────────────────
// A job is priced by the card in force ON THE DAY IT COMPLETED, which for monthly
// cards is usually not the newest one. 'superseded' means "no longer the latest",
// not "invalid" — the August card must keep pricing August work for ever — so a
// superseded card still answers for dates inside its own window.
const approvedCard = (asOf) => db.prepare(
  `SELECT * FROM rate_versions
    WHERE status IN ('approved', 'superseded') AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY location_id IS NULL, effective_from DESC LIMIT 1`
).get(asOf, asOf);

// Most specific match wins; a NULL dimension on a rate line means "applies to any".
const makeResolver = (versionId) => {
  const stmt = db.prepare(
    `SELECT l.*, s.pricing_kind FROM rate_lines l
       JOIN service_items s ON s.code = l.service_code
      WHERE l.version_id = ? AND l.service_code = ?
        AND (l.paper_size  IS ? OR l.paper_size  IS NULL)
        AND (l.paper_gsm   IS ? OR l.paper_gsm   IS NULL)
        AND (l.colour_mode IS ? OR l.colour_mode IS NULL)
        AND (l.variant     IS ? OR l.variant     IS NULL)
      ORDER BY (l.paper_size IS NOT NULL) + (l.paper_gsm IS NOT NULL)
             + (l.colour_mode IS NOT NULL) + (l.variant IS NOT NULL) DESC
      LIMIT 1`
  );
  return (serviceCode, dims = {}) => {
    const row = stmt.get(versionId, serviceCode,
      dims.size || null, dims.gsm || null, dims.colour || null, dims.variant || null);
    return row ? { ...row, version_id: versionId } : null;
  };
};

// ── Accrual: turn a job's production into priced cost lines ──────────────────
const accrueForJob = (req, job) => {
  const asOf = (job.completed_at || new Date().toISOString()).slice(0, 10);
  const card = approvedCard(asOf);
  if (!card) {
    return { error: `No approved rate card is in force on ${asOf}. Approve a card before costing.` };
  }

  const resolve = makeResolver(card.id);
  const docs = db.prepare('SELECT * FROM print_job_documents WHERE job_id = ?').all(job.id);
  const reworks = db.prepare(
    `SELECT * FROM print_job_reworks WHERE job_id = ? AND status = 'completed' ORDER BY version_no`
  ).all(job.id);

  const items = [];
  for (const d of docs) items.push(...itemsForDocument(d).map((i) => ({ ...i, documentId: d.id })));
  for (const r of reworks) {
    const target = r.document_id ? docs.find((d) => d.id === r.document_id) : docs[0];
    items.push(...itemsForRework(r, target).map((i) => ({ ...i, documentId: target?.id || null })));
  }

  const { lines, unconfigured } = priceItems(items, resolve);
  return { card, lines, unconfigured, itemCount: items.length };
};

const nextAnnexureNo = () => {
  const year = new Date().getFullYear();
  const name = `PCA-${year}`;
  db.prepare('INSERT INTO doc_sequences (name, next_value) VALUES (?, 1) ON CONFLICT(name) DO NOTHING').run(name);
  const row = db.prepare('SELECT next_value FROM doc_sequences WHERE name = ?').get(name);
  db.prepare('UPDATE doc_sequences SET next_value = next_value + 1 WHERE name = ?').run(name);
  return `${name}-${String(row.next_value).padStart(4, '0')}`;
};

const NOT_CONFIGURED = 'Rate Not Configured';

const shapeLine = (l) => {
  const unpriced = l.rate_status === 'not_configured';
  return {
    ...l,
    rate_display: unpriced ? NOT_CONFIGURED : milliToRate(l.rate_milli),
    amount_display: unpriced ? '—' : paiseToRupees(l.amount_paise),
    unpriced,
  };
};

const shapeTotals = (a) => ({
  printing: paiseToRupees(a.printing_paise),
  binding: paiseToRupees(a.binding_paise),
  finishing: paiseToRupees(a.finishing_paise),
  misc: paiseToRupees(a.misc_paise),
  rework: paiseToRupees(a.rework_paise),
  basic: paiseToRupees(a.basic_paise),
  grand_total: paiseToRupees(a.grand_total_paise),
  in_words: amountInWords(a.grand_total_paise),
});

// ── Preview a job's cost without writing anything ──
router.get('/jobs/:id/cost', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    // The assigned operator reads this too — they are the one correcting it.
    if (!canEditCosting(req)) {
      return res.status(403).json({ error: 'Only the assigned printer operator or a coordinator can view costing' });
    }

    const stored = db.prepare('SELECT * FROM job_cost_lines WHERE job_id = ? AND annexure_id IS ? ORDER BY id')
      .all(job.id, lineScopeId(job.id));
    if (stored.length) {
      const totals = summarise(stored.map((l) => ({
        costGroup: l.cost_group, amountPaise: l.amount_paise, isRework: !!l.rework_id,
      })));
      return res.json({ source: 'accrued', lines: stored.map(shapeLine), totals, totals_display: {
        ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, paiseToRupees(v)])),
        in_words: amountInWords(totals.grandTotal),
      }, unconfigured: [] });
    }

    const result = accrueForJob(req, job);
    if (result.error) return res.status(409).json({ error: result.error });
    const totals = summarise(result.lines);
    res.json({
      source: 'preview',
      card: result.card.code,
      lines: result.lines.map((l) => ({
        service_code: l.serviceCode, label: l.label, cost_group: l.costGroup,
        quantity: l.quantity, uom: l.uom, rate_milli: l.rateMilli,
        rate_display: l.rateStatus === 'not_configured' ? NOT_CONFIGURED : milliToRate(l.rateMilli),
        amount_paise: l.amountPaise,
        amount_display: l.rateStatus === 'not_configured' ? '—' : paiseToRupees(l.amountPaise),
        detail: l.detail, unpriced: l.rateStatus === 'not_configured', missing: l.missing || null,
        is_rework: l.isRework, min_charge_applied: l.minChargeApplied,
      })),
      totals,
      totals_display: {
        ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, paiseToRupees(v)])),
        in_words: amountInWords(totals.grandTotal),
      },
      unconfigured: result.unconfigured,
    });
  } catch (error) {
    console.error('Error costing job:', error);
    res.status(500).json({ error: 'Failed to cost this job' });
  }
});

// ── Correcting a job's costing to what was actually printed ──────────────────
//
// The requestor's spec is an estimate. Printing a manual, the operator decides how
// many pages actually run A3 vs A4, colour vs mono — so the people who can correct a
// cost line are the operator who ran the job and the coordinator, not the requestor.
// Any printer operator may correct any job's costing, not just one assigned to them:
// the print room works as a team, jobs get handed over mid-run, and whoever knows what
// actually came off the machine has to be able to record it.
const canEditCosting = (req) => {
  if (req.user.role === 'admin') return true;
  const u = db.prepare('SELECT is_printer_coordinator, is_printer_operator FROM users WHERE id = ?')
    .get(req.user.id) || {};
  return !!(u.is_printer_coordinator || u.is_printer_operator);
};

// Reading the cost annexures follows the same rule — an operator who can correct a
// line must be able to find it in the first place.
const canViewCosting = canEditCosting;

// Editing stops the moment the annexure is approved — at that point it is signed-off
// evidence. A draft annexure is fair game and its totals are recomputed after.
const openAnnexure = (jobId) => db.prepare(
  `SELECT * FROM cost_annexures WHERE job_id = ? AND status != 'superseded'`
).get(jobId);

// Which job_cost_lines rows are "live" right now for this job: the currently open
// annexure's own lines, or — if nothing has been issued yet — the pre-issue working
// set, which is tagged with annexure_id IS NULL. Every read and edit must go through
// this scope; querying by job_id alone would mix a superseded version's frozen lines
// in with whatever is being corrected today.
const lineScopeId = (jobId) => openAnnexure(jobId)?.id ?? null;

const guardEditable = (req, res, job) => {
  if (!canEditCosting(req)) {
    res.status(403).json({ error: 'Only the assigned printer operator or a coordinator can adjust costing' });
    return false;
  }
  const a = openAnnexure(job.id);
  if (a && a.status === 'approved') {
    res.status(409).json({ error: `${a.annexure_no} is approved and locked. Reissue it to make changes.` });
    return false;
  }
  return true;
};

// Cost lines are written when the annexure is issued. Correcting before that must
// still work, so the accrual is materialised on first edit.
const ensureAccrued = (req, job) => {
  const aid = lineScopeId(job.id);
  const existing = db.prepare('SELECT COUNT(*) AS c FROM job_cost_lines WHERE job_id = ? AND annexure_id IS ?')
    .get(job.id, aid).c;
  if (existing) return null;
  const result = accrueForJob(req, job);
  if (result.error) return result.error;
  const insert = db.prepare(
    `INSERT INTO job_cost_lines (job_id, document_id, rework_id, service_code, label, cost_group,
       quantity, uom, rate_version_id, rate_milli, amount_paise, min_charge_applied, detail,
       accrued_by, rate_status, paper_size, paper_gsm, colour_mode, variant, annexure_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  db.transaction(() => {
    for (const l of result.lines) {
      const d = l.dimensions || {};
      insert.run(job.id, l.documentId || null, l.reworkId || null, l.serviceCode, l.label,
        l.costGroup, l.quantity, l.uom, l.rateVersionId, l.rateMilli ?? 0, l.amountPaise,
        l.minChargeApplied ? 1 : 0, l.detail, req.user.id, l.rateStatus || 'priced',
        d.size || null, d.gsm || null, d.colour || null, d.variant || null, aid);
    }
  })();
  return null;
};

// Re-price one stored line against the card that governs this job's date.
const repriceLine = (job, line) => {
  const asOf = (job.completed_at || new Date().toISOString()).slice(0, 10);
  const card = approvedCard(asOf);
  if (!card) return { error: `No rate card is in force on ${asOf}.` };
  const resolve = makeResolver(card.id);
  const rate = resolve(line.service_code, {
    size: line.paper_size, gsm: line.paper_gsm, colour: line.colour_mode, variant: line.variant,
  });
  const qty = Number(line.quantity) || 0;
  if (!rate) {
    // Corrected onto a spec the card cannot price: shown as unpriced rather than
    // silently charged at the old rate.
    return { rate_milli: 0, amount_paise: 0, rate_status: 'not_configured', rate_version_id: card.id };
  }
  return {
    rate_milli: rate.rate_milli,
    amount_paise: lineAmountPaise(qty, rate.rate_milli),
    rate_status: 'priced',
    rate_version_id: card.id,
  };
};

// Totals live on the annexure row; any line change has to restate them.
const recomputeAnnexure = (jobId) => {
  const a = openAnnexure(jobId);
  if (!a || a.status === 'approved') return;
  // Scoped to THIS annexure's own lines — a prior, superseded version's rows carry a
  // different annexure_id and must never be folded into this total.
  const lines = db.prepare('SELECT * FROM job_cost_lines WHERE annexure_id = ?').all(a.id);
  const t = summarise(lines.map((l) => ({
    costGroup: l.cost_group, amountPaise: l.amount_paise,
    isRework: !!l.rework_id, rateStatus: l.rate_status,
  })));
  db.prepare(
    `UPDATE cost_annexures SET printing_paise=?, binding_paise=?, finishing_paise=?, misc_paise=?,
       rework_paise=?, basic_paise=?, grand_total_paise=?, line_count=? WHERE id=?`
  ).run(t.printing, t.binding, t.finishing, t.misc, t.rework, t.basic, t.grandTotal, lines.length, a.id);
};

const costingResponse = (jobId) => {
  const lines = db.prepare('SELECT * FROM job_cost_lines WHERE job_id = ? AND annexure_id IS ? ORDER BY id')
    .all(jobId, lineScopeId(jobId));
  const totals = summarise(lines.map((l) => ({
    costGroup: l.cost_group, amountPaise: l.amount_paise,
    isRework: !!l.rework_id, rateStatus: l.rate_status,
  })));
  return {
    lines: lines.map(shapeLine),
    totals,
    totals_display: {
      ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, paiseToRupees(v)])),
      in_words: amountInWords(totals.grandTotal),
    },
  };
};

// Materialise the derived costing into editable rows.
// Until this runs, a job's cost is a live preview with no row identity, so nothing can
// be corrected. Opening the editor calls this once; it is a no-op if rows already exist.
router.post('/jobs/:id/cost/accrue', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!guardEditable(req, res, job)) return;

    const err = ensureAccrued(req, job);
    if (err) return res.status(409).json({ error: err });
    res.json(costingResponse(job.id));
  } catch (error) {
    console.error('Error accruing cost lines:', error);
    res.status(500).json({ error: 'Failed to prepare the costing' });
  }
});

// Correct what was actually printed on one line.
router.patch('/jobs/:id/cost/lines/:lineId', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!guardEditable(req, res, job)) return;

    const err = ensureAccrued(req, job);
    if (err) return res.status(409).json({ error: err });

    const line = db.prepare('SELECT * FROM job_cost_lines WHERE id = ? AND job_id = ? AND annexure_id IS ?')
      .get(req.params.lineId, job.id, lineScopeId(job.id));
    if (!line) return res.status(404).json({ error: 'Cost line not found on this job' });

    const body = req.body || {};
    const next = {
      ...line,
      quantity: body.quantity !== undefined ? Number(body.quantity) : line.quantity,
      paper_size: body.paper_size !== undefined ? (body.paper_size || null) : line.paper_size,
      paper_gsm: body.paper_gsm !== undefined ? (body.paper_gsm || null) : line.paper_gsm,
      colour_mode: body.colour_mode !== undefined ? (body.colour_mode || null) : line.colour_mode,
    };
    if (!Number.isFinite(next.quantity) || next.quantity < 0) {
      return res.status(400).json({ error: 'Quantity must be zero or more' });
    }

    const priced = repriceLine(job, next);
    if (priced.error) return res.status(409).json({ error: priced.error });

    const reason = String(body.reason || '').trim() || 'Adjusted to actual print';
    db.prepare(
      `UPDATE job_cost_lines
          SET quantity=?, paper_size=?, paper_gsm=?, colour_mode=?, rate_milli=?, amount_paise=?,
              rate_status=?, rate_version_id=?, is_manual=1, manual_reason=?, accrued_by=?,
              accrued_at=datetime('now')
        WHERE id=?`
    ).run(next.quantity, next.paper_size, next.paper_gsm, next.colour_mode,
      priced.rate_milli, priced.amount_paise, priced.rate_status, priced.rate_version_id,
      reason, req.user.id, line.id);

    recomputeAnnexure(job.id);
    res.json({ message: `${line.label} updated to what was printed.`, ...costingResponse(job.id) });
  } catch (error) {
    console.error('Error editing cost line:', error);
    res.status(500).json({ error: 'Failed to update the cost line' });
  }
});

// Add work the original spec did not describe — e.g. 40 of the pages ran A3 colour.
router.post('/jobs/:id/cost/lines', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!guardEditable(req, res, job)) return;

    const err = ensureAccrued(req, job);
    if (err) return res.status(409).json({ error: err });

    const body = req.body || {};
    const serviceCode = String(body.service_code || '').trim().toUpperCase();
    if (!serviceCode) return res.status(400).json({ error: 'Pick a service for the new line' });
    const service = db.prepare('SELECT * FROM service_items WHERE code = ?').get(serviceCode);
    if (!service) return res.status(400).json({ error: `Unknown service ${serviceCode}` });

    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'Quantity must be more than zero' });
    }

    const draft = {
      service_code: serviceCode, quantity,
      paper_size: body.paper_size || null, paper_gsm: body.paper_gsm || null,
      colour_mode: body.colour_mode || null, variant: body.variant || null,
    };
    const priced = repriceLine(job, draft);
    if (priced.error) return res.status(409).json({ error: priced.error });

    const info = db.prepare(
      `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
         rate_version_id, rate_milli, amount_paise, min_charge_applied, detail, accrued_by,
         rate_status, paper_size, paper_gsm, colour_mode, variant, is_manual, manual_reason,
         annexure_id)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,1,?,?)`
    ).run(job.id, serviceCode, service.label, service.cost_group, quantity, service.uom,
      priced.rate_version_id, priced.rate_milli, priced.amount_paise,
      [draft.paper_size, draft.paper_gsm, draft.colour_mode].filter(Boolean).join(' · ') || null,
      req.user.id, priced.rate_status, draft.paper_size, draft.paper_gsm, draft.colour_mode,
      draft.variant, String(body.reason || '').trim() || 'Added from actual print', lineScopeId(job.id));

    recomputeAnnexure(job.id);
    res.status(201).json({ id: Number(info.lastInsertRowid), message: `${service.label} added.`, ...costingResponse(job.id) });
  } catch (error) {
    console.error('Error adding cost line:', error);
    res.status(500).json({ error: 'Failed to add the cost line' });
  }
});

// Remove a line for work that was not actually done.
router.delete('/jobs/:id/cost/lines/:lineId', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!guardEditable(req, res, job)) return;

    const line = db.prepare('SELECT * FROM job_cost_lines WHERE id = ? AND job_id = ? AND annexure_id IS ?')
      .get(req.params.lineId, job.id, lineScopeId(job.id));
    if (!line) return res.status(404).json({ error: 'Cost line not found on this job' });

    db.prepare('DELETE FROM job_cost_lines WHERE id = ?').run(line.id);
    recomputeAnnexure(job.id);
    res.json({ message: `${line.label} removed.`, ...costingResponse(job.id) });
  } catch (error) {
    console.error('Error removing cost line:', error);
    res.status(500).json({ error: 'Failed to remove the cost line' });
  }
});

// ── Issue the annexure: freeze the lines and number the document ──
router.post('/jobs/:id/annexure', authenticateToken, (req, res) => {
  try {
    if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinators only' });
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'completed') {
      return res.status(400).json({ error: `Only a completed job can be costed (${jobLabel(job)} is ${job.status})` });
    }
    const open = db.prepare(
      `SELECT annexure_no FROM cost_annexures WHERE job_id = ? AND status != 'superseded'`
    ).get(job.id);
    if (open) return res.status(409).json({ error: `${open.annexure_no} already exists for this job.` });

    // Corrections the operator made to what was actually printed are already stored as
    // cost lines, tagged with annexure_id IS NULL because nothing has been issued for
    // this job yet (the `open` check above already ruled out an existing annexure).
    // Re-deriving from the documents here would silently throw those corrections away,
    // so stored lines win and are carried onto the annexure untouched.
    const corrected = db.prepare('SELECT * FROM job_cost_lines WHERE job_id = ? AND annexure_id IS NULL ORDER BY id').all(job.id);

    let result;
    if (corrected.length) {
      const cardId = corrected.find((l) => l.rate_version_id)?.rate_version_id;
      const card = cardId ? db.prepare('SELECT * FROM rate_versions WHERE id = ?').get(cardId) : null;
      if (!card) return res.status(409).json({ error: 'The rate card behind these cost lines is missing.' });
      result = { card, lines: null, corrected };
    } else {
      result = accrueForJob(req, job);
      if (result.error) return res.status(409).json({ error: result.error });
      // Unpriced items no longer block. They are carried onto the annexure as
      // "Rate Not Configured" so the work is visible and the job can proceed; finance
      // adds the rate later and reissues if the money matters.
      if (!result.lines.length) {
        return res.status(409).json({ error: `${jobLabel(job)} has nothing chargeable to cost.` });
      }
    }

    const totals = corrected.length
      ? summarise(corrected.map((l) => ({
          costGroup: l.cost_group, amountPaise: l.amount_paise,
          isRework: !!l.rework_id, rateStatus: l.rate_status,
        })))
      : summarise(result.lines);
    const annexureNo = nextAnnexureNo();

    const insertLine = db.prepare(
      `INSERT INTO job_cost_lines (job_id, document_id, rework_id, service_code, label, cost_group,
         quantity, uom, rate_version_id, rate_milli, amount_paise, min_charge_applied, detail, accrued_by,
         rate_status, paper_size, paper_gsm, colour_mode, variant, annexure_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insertAnnexure = db.prepare(
      `INSERT INTO cost_annexures (annexure_no, job_id, version, status, rate_version_id,
         printing_paise, binding_paise, finishing_paise, misc_paise, rework_paise,
         basic_paise, grand_total_paise, line_count, issued_by)
       VALUES (?,?,?, 'draft', ?,?,?,?,?,?,?,?,?,?)`
    );

    const lineCount = corrected.length || result.lines.length;

    const write = db.transaction(() => {
      // The annexure row is created FIRST so its lines can be stamped with the id that
      // scopes them — a line with no owning annexure is only ever the pre-issue working
      // set, never a version that has actually been issued.
      const info = insertAnnexure.run(annexureNo, job.id, 1, result.card.id,
        totals.printing, totals.binding, totals.finishing, totals.misc, totals.rework,
        totals.basic, totals.grandTotal, lineCount, req.user.id);
      const annexureId = Number(info.lastInsertRowid);

      if (corrected.length) {
        // Already in place from pre-issue correction — claim them for this version
        // rather than re-deriving, which would discard exactly the correction that
        // made them worth keeping.
        db.prepare('UPDATE job_cost_lines SET annexure_id = ? WHERE job_id = ? AND annexure_id IS NULL')
          .run(annexureId, job.id);
      } else {
        for (const l of result.lines) {
          const d = l.dimensions || {};
          insertLine.run(job.id, l.documentId || null, l.reworkId || null, l.serviceCode, l.label,
            l.costGroup, l.quantity, l.uom, l.rateVersionId, l.rateMilli ?? 0, l.amountPaise,
            l.minChargeApplied ? 1 : 0, l.detail, req.user.id, l.rateStatus || 'priced',
            d.size || null, d.gsm || null, d.colour || null, d.variant || null, annexureId);
        }
      }

      // users carries no designation/department columns; role is the closest thing we
      // have, and the department belongs to the job being costed rather than the actor.
      const u = db.prepare('SELECT ps_number, role FROM users WHERE id = ?').get(req.user.id) || {};
      db.prepare(
        `INSERT INTO annexure_approvals (annexure_id, role, user_id, employee_id, designation, department, ip_address)
         VALUES (?, 'prepared', ?, ?, ?, ?, ?)`
      ).run(annexureId, req.user.id, u.ps_number || null, u.role || null,
            job.department_name || null, req.ip || null);
      return annexureId;
    });
    write();

    res.status(201).json({
      annexure_no: annexureNo,
      status: 'draft',
      card: result.card.code,
      line_count: lineCount,
      corrected: corrected.length > 0,
      unconfigured: result.unconfigured || [],
      totals,
      grand_total_display: paiseToRupees(totals.grandTotal),
      message: `${annexureNo} issued as draft — ${paiseToRupees(totals.grandTotal)}`
             + (totals.unconfigured ? `, ${totals.unconfigured} item(s) awaiting a rate.` : '.'),
    });
  } catch (error) {
    console.error('Error issuing annexure:', error);
    res.status(500).json({ error: 'Failed to issue the annexure' });
  }
});

const jobLabel = (job) => job.job_number || job.request_id || `Job #${job.id}`;

// ── Register ──
router.get('/annexures', authenticateToken, (req, res) => {
  try {
    if (!canViewCosting(req)) return res.status(403).json({ error: 'Printing coordinators and operators only' });
    const rows = db.prepare(
      `SELECT a.*, j.job_number, j.request_id, j.project_name, j.department_name, j.debit_code,
              u.name AS requestor_name, iss.name AS issued_by_name, v.code AS rate_card,
              mgr.id AS manager_id, mgr.name AS manager_name, mgr.ps_number AS manager_ps
         FROM cost_annexures a
         JOIN print_jobs j ON j.id = a.job_id
         LEFT JOIN users u ON u.id = j.created_by
         LEFT JOIN users iss ON iss.id = a.issued_by
         LEFT JOIN rate_versions v ON v.id = a.rate_version_id
         LEFT JOIN users mgr ON mgr.id = u.manager_id
        -- Grouped by the requestor's manager first (unassigned last, alphabetically
        -- within each group), then by job so every version still sits together.
        ORDER BY (mgr.name IS NULL), mgr.name, COALESCE(j.job_number, j.request_id), a.version DESC`
    ).all();
    res.json(rows.map((r) => ({ ...r, totals_display: shapeTotals(r) })));
  } catch (error) {
    console.error('Error listing annexures:', error);
    res.status(500).json({ error: 'Failed to list annexures' });
  }
});

// ── Completed jobs with no annexure yet ──
// Declared before /annexures/:no so the literal path is not captured as a number.
router.get('/annexures/candidates', authenticateToken, (req, res) => {
  try {
    if (!canViewCosting(req)) return res.status(403).json({ error: 'Printing coordinators and operators only' });
    const rows = db.prepare(
      `SELECT j.id, j.job_number, j.request_id, j.project_name, j.department_name, j.debit_code,
              j.completed_at, u.name AS requestor_name,
              (SELECT COUNT(*) FROM print_job_documents d WHERE d.job_id = j.id) AS document_count,
              (SELECT COUNT(*) FROM print_job_reworks r WHERE r.job_id = j.id AND r.status = 'completed') AS rework_count
         FROM print_jobs j
         LEFT JOIN users u ON u.id = j.created_by
        WHERE j.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM cost_annexures a WHERE a.job_id = j.id AND a.status != 'superseded')
        ORDER BY j.completed_at DESC`
    ).all();
    res.json(rows);
  } catch (error) {
    console.error('Error listing costable jobs:', error);
    res.status(500).json({ error: 'Failed to list costable jobs' });
  }
});

// Shared by both the coordinator-facing lookup (by annexure_no) and the requestor's
// (by job id, below) — one place building the same {annexure, lines, approvals,
// documents} shape so the two views can never quietly drift apart.
const buildAnnexureDetail = (annexureNo) => {
  const a = db.prepare(
    `SELECT a.*, j.job_number, j.request_id, j.project_name, j.department_name, j.department_code,
            j.debit_code, j.dt_number, j.submitted_at, j.completed_at, j.created_by,
            u.name AS requestor_name, u.ps_number AS requestor_ps,
            v.code AS rate_card, l.name AS location_name
       FROM cost_annexures a
       JOIN print_jobs j ON j.id = a.job_id
       LEFT JOIN users u ON u.id = j.created_by
       LEFT JOIN rate_versions v ON v.id = a.rate_version_id
       LEFT JOIN locations l ON l.id = j.location_id
      WHERE a.annexure_no = ?`
  ).get(annexureNo);
  if (!a) return null;

  // Scoped to THIS annexure's own id, not just its job — a job can carry several
  // versions over time, and viewing a superseded one must show exactly what was
  // frozen at that version, not whatever the current draft has since been corrected to.
  const lines = db.prepare(
    'SELECT * FROM job_cost_lines WHERE annexure_id = ? ORDER BY cost_group, id'
  ).all(a.id).map(shapeLine);
  const approvals = db.prepare(
    `SELECT ap.*, u.name AS user_name FROM annexure_approvals ap
       JOIN users u ON u.id = ap.user_id
      WHERE ap.annexure_id = ? ORDER BY ap.acted_at`
  ).all(a.id);
  const documents = db.prepare(
    'SELECT document_name, quantity, num_pages, paper_size, paper_gsm, color_mode, print_side, binding_type FROM print_job_documents WHERE job_id = ?'
  ).all(a.job_id);

  return { annexure: a, totals_display: shapeTotals(a), lines, approvals, documents };
};

// ── One annexure, with its lines and approval trail ──
// Coordinators and operators read any annexure; a requestor may read their own —
// they need to see the figures in order to approve them.
router.get('/annexures/:no', authenticateToken, (req, res) => {
  try {
    const detail = buildAnnexureDetail(req.params.no);
    if (!detail) return res.status(404).json({ error: 'Annexure not found' });
    const isOwnJob = detail.annexure.created_by === req.user.id;
    if (!canViewCosting(req) && !isOwnJob) {
      return res.status(403).json({ error: 'Not authorized to view this annexure' });
    }
    res.json(detail);
  } catch (error) {
    console.error('Error fetching annexure:', error);
    res.status(500).json({ error: 'Failed to fetch the annexure' });
  }
});

// ── The current annexure for a job, looked up by job id ──────────────────────
// The requestor knows their job id (it's on their Job History list) but not the
// annexure number, so this is how their "review the cost" screen finds it.
router.get('/jobs/:id/annexure', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const isOwnJob = job.created_by === req.user.id;
    if (!canViewCosting(req) && !isOwnJob) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const open = openAnnexure(job.id);
    if (!open) return res.status(404).json({ error: 'No cost annexure has been issued for this job yet.' });
    res.json(buildAnnexureDetail(open.annexure_no));
  } catch (error) {
    console.error('Error fetching job annexure:', error);
    res.status(500).json({ error: 'Failed to fetch the cost annexure' });
  }
});

// ── Approve. Freezes the figures and hashes them (BR-05). ──
router.post('/annexures/:no/approve', authenticateToken, (req, res) => {
  try {
    const a = db.prepare('SELECT * FROM cost_annexures WHERE annexure_no = ?').get(req.params.no);
    if (!a) return res.status(404).json({ error: 'Annexure not found' });
    const job = db.prepare('SELECT created_by, department_name FROM print_jobs WHERE id = ?').get(a.job_id) || {};

    // The requestor who raised the job verifies the amount, pages and services and
    // signs off — coordinators and operators prepare and correct the figures but do
    // not approve their own work. No role-based override: in this app 'admin' is
    // routinely layered onto coordinator/operator accounts (module capability is a
    // separate flag from JCC role), so bypassing on role alone would silently hand
    // approval back to the very people this boundary exists to exclude.
    if (job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Only the requestor who raised this job can approve its cost annexure.' });
    }
    if (a.status === 'approved') return res.status(400).json({ error: `${a.annexure_no} is already approved.` });
    if (a.status === 'superseded') {
      return res.status(400).json({ error: `${a.annexure_no} has been superseded — review the latest version instead.` });
    }

    // Scoped to this version's own lines — a job can have a prior superseded version
    // sharing the same job_id, and the hash must attest to exactly what THIS annexure
    // charges, not a mix of two versions' rows.
    const lines = db.prepare('SELECT * FROM job_cost_lines WHERE annexure_id = ? ORDER BY id').all(a.id);
    const payload = JSON.stringify({
      annexure_no: a.annexure_no, job_id: a.job_id, version: a.version,
      grand_total_paise: a.grand_total_paise,
      lines: lines.map((l) => [l.service_code, l.quantity, l.rate_milli, l.amount_paise]),
    });
    const hash = crypto.createHash('sha256').update(payload).digest('hex');

    const u = db.prepare('SELECT ps_number, role FROM users WHERE id = ?').get(req.user.id) || {};
    db.transaction(() => {
      db.prepare(`UPDATE cost_annexures SET status = 'approved', payload_sha256 = ? WHERE id = ?`).run(hash, a.id);
      db.prepare(
        `INSERT INTO annexure_approvals (annexure_id, role, user_id, employee_id, designation, department, remarks, ip_address)
         VALUES (?, 'approved', ?, ?, ?, ?, ?, ?)`
      ).run(a.id, req.user.id, u.ps_number || null, u.role || null, job.department_name || null,
            (req.body?.remarks || '').trim() || null, req.ip || null);
    })();

    res.json({
      annexure_no: a.annexure_no, status: 'approved', payload_sha256: hash,
      message: `${a.annexure_no} approved and locked.`,
    });
  } catch (error) {
    console.error('Error approving annexure:', error);
    res.status(500).json({ error: 'Failed to approve the annexure' });
  }
});

// ── Reissue an approved annexure so it can be corrected ──────────────────────
//
// An approved annexure is signed-off evidence and is never edited in place. When the
// figures turn out to be wrong — the actual print differed from what was costed — the
// honest correction is a new version: the approved one is marked superseded and kept
// intact, and a fresh draft carrying the same lines becomes editable again.
//
// Operators as well as coordinators can do this, because the operator is usually the
// one who spots that the annexure does not match what came off the machine.
router.post('/annexures/:no/reissue', authenticateToken, (req, res) => {
  try {
    if (!canEditCosting(req)) {
      return res.status(403).json({ error: 'Printing coordinators and operators only' });
    }
    const a = db.prepare('SELECT * FROM cost_annexures WHERE annexure_no = ?').get(req.params.no);
    if (!a) return res.status(404).json({ error: 'Annexure not found' });
    if (a.status === 'superseded') {
      return res.status(409).json({ error: `${a.annexure_no} is already superseded.` });
    }
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: 'Say why this annexure is being reissued — it goes on the record.' });
    }

    const annexureNo = nextAnnexureNo();
    const newId = db.transaction(() => {
      db.prepare("UPDATE cost_annexures SET status = 'superseded' WHERE id = ?").run(a.id);
      const info = db.prepare(
        `INSERT INTO cost_annexures (annexure_no, job_id, version, supersedes_id, status, rate_version_id,
           printing_paise, binding_paise, finishing_paise, misc_paise, rework_paise,
           basic_paise, grand_total_paise, line_count, reissue_reason, issued_by)
         SELECT ?, job_id, version + 1, ?, 'draft', rate_version_id,
           printing_paise, binding_paise, finishing_paise, misc_paise, rework_paise,
           basic_paise, grand_total_paise, line_count, ?, ?
           FROM cost_annexures WHERE id = ?`
      ).run(annexureNo, a.id, reason, req.user.id, a.id);
      const id = Number(info.lastInsertRowid);

      // The new draft starts as an exact copy of the version it supersedes — including
      // any corrections already made — so nothing is lost and there is something to
      // edit immediately. New rows get their own ids and annexure_id, so correcting
      // them can never reach back and alter a.id's frozen figures.
      db.prepare(
        `INSERT INTO job_cost_lines (job_id, document_id, rework_id, service_code, label, cost_group,
           quantity, uom, rate_version_id, rate_milli, amount_paise, min_charge_applied, detail,
           accrued_by, accrued_at, rate_status, paper_size, paper_gsm, colour_mode, variant,
           is_manual, manual_reason, annexure_id)
         SELECT job_id, document_id, rework_id, service_code, label, cost_group,
           quantity, uom, rate_version_id, rate_milli, amount_paise, min_charge_applied, detail,
           accrued_by, accrued_at, rate_status, paper_size, paper_gsm, colour_mode, variant,
           is_manual, manual_reason, ?
           FROM job_cost_lines WHERE job_id = ? AND annexure_id IS ?`
      ).run(id, a.job_id, a.id);

      const u = db.prepare('SELECT ps_number, role FROM users WHERE id = ?').get(req.user.id) || {};
      const job = db.prepare('SELECT department_name FROM print_jobs WHERE id = ?').get(a.job_id) || {};
      db.prepare(
        `INSERT INTO annexure_approvals (annexure_id, role, user_id, employee_id, designation, department, remarks, ip_address)
         VALUES (?, 'prepared', ?, ?, ?, ?, ?, ?)`
      ).run(id, req.user.id, u.ps_number || null, u.role || null, job.department_name || null, reason, req.ip || null);
      return id;
    })();

    res.status(201).json({
      annexure_no: annexureNo,
      supersedes: a.annexure_no,
      version: a.version + 1,
      job_id: a.job_id,
      status: 'draft',
      message: `${annexureNo} created as a draft (v${a.version + 1}); ${a.annexure_no} is superseded and kept on record. `
             + 'The cost lines can now be corrected.',
    });
  } catch (error) {
    console.error('Error reissuing annexure:', error);
    res.status(500).json({ error: 'Failed to reissue the annexure' });
  }
});

export default router;
