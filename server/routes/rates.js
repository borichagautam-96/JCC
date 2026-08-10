import express from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../database.js';
import { authenticateToken } from '../middleware/auth.js';
import { importRateWorkbook, PRINT_BLOCKS } from '../utils/rateImport.js';

const router = express.Router();

// Uploaded workbooks are parsed and then deleted — the rate lines are the record, not
// the file. Kept off the public upload dir since these are never served back.
const rateUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `rate-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xlsm|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only an Excel workbook (.xlsx) can be imported'), ok);
  },
});

// Rate master, read-only for now. Maintenance and the pricing engine come later; the
// first useful thing is simply being able to see the card and — more importantly —
// see what it cannot price.

// Printing capability is a module flag, independent of the JCC role. Rates are
// finance-adjacent, so this is coordinator/admin territory rather than every
// requestor. A dedicated can_maintain_rates flag is the proper follow-up once
// editing exists.
// Deliberately no role-based bypass: the rate master is seen only by whoever holds
// the printer coordinator or operator flag, admin included only if they hold one of
// those flags too — being a JCC admin on its own is not enough.
const canViewRates = (req) => {
  const row = db.prepare('SELECT is_printer_coordinator, is_printer_operator FROM users WHERE id = ?')
    .get(req.user.id);
  // Operators read the card too — they correct cost lines against it, so they need to
  // see what a size/colour actually costs. Changing the card is a separate right below.
  return !!(row && (row.is_printer_coordinator || row.is_printer_operator));
};

// Importing, editing and approving a rate card is finance control, and stays with
// coordinators and admins even though operators can read it.
const canMaintainRates = (req) => {
  const row = db.prepare('SELECT is_printer_coordinator FROM users WHERE id = ?').get(req.user.id);
  return !!(row && row.is_printer_coordinator);
};

// Approving a card is a separate right from maintaining one, and deliberately not the
// coordinator flag: whoever imports or edits the figures must not be the person who
// puts them in force. No role bypass — 'admin' is routinely layered onto coordinator
// accounts here, so allowing it would hand the card straight back to its preparer.
const canApproveRates = (req) => {
  const row = db.prepare('SELECT is_rate_approver FROM users WHERE id = ?').get(req.user.id);
  return !!(row && row.is_rate_approver);
};

// Every touch on a draft is recorded, so approval can exclude everyone who shaped it.
const recordRateActivity = (versionId, userId, action, detail = null) => {
  db.prepare('INSERT INTO rate_card_activity (version_id, user_id, action, detail) VALUES (?,?,?,?)')
    .run(versionId, userId, action, detail);
};

const preparersOf = (versionId) => db.prepare(
  `SELECT DISTINCT a.user_id, u.name
     FROM rate_card_activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.version_id = ?`
).all(versionId);

const rupees = (milli) => (milli / 1000).toFixed(3);

/**
 * Rebuild the effective-date timeline for one scope after any approval.
 *
 * Monthly cards make ordering unavoidable: several cards are live over time and each
 * must keep its own window, because a job completed in August has to price at August's
 * rates for ever — not at whatever is newest. So each card runs until the day before
 * the next one starts, and `superseded` means "no longer the latest", NOT "invalid".
 * Rate lookups therefore accept a superseded card whose window covers the job's date.
 *
 * Recomputing the whole chain (rather than patching one row) keeps this correct no
 * matter what order cards are approved in — back-dating August after September is a
 * normal thing to do and must not corrupt either.
 */
export const rebuildTimeline = (database, locationId) => {
  const cards = database.prepare(
    `SELECT id, effective_from FROM rate_versions
      WHERE status IN ('approved', 'superseded') AND COALESCE(location_id,0) = COALESCE(?,0)
      ORDER BY effective_from, id`
  ).all(locationId);

  const today = new Date().toISOString().slice(0, 10);
  const setRow = database.prepare('UPDATE rate_versions SET effective_to = ?, status = ? WHERE id = ?');

  cards.forEach((card, i) => {
    const next = cards[i + 1];
    // Last card in the chain stays open-ended.
    const effectiveTo = next
      ? new Date(new Date(`${next.effective_from}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10)
      : null;
    // 'superseded' only once the card's period has actually ENDED. A card whose window
    // is still to come is approved-and-scheduled, not superseded.
    const finished = effectiveTo !== null && effectiveTo < today;
    setRow.run(effectiveTo, finished ? 'superseded' : 'approved', card.id);
  });

  // Nothing covers today (every card is future-dated): keep the earliest as approved
  // so the module is not left with no in-force card at all.
  const inForce = database.prepare(
    `SELECT COUNT(*) AS c FROM rate_versions
      WHERE status = 'approved' AND COALESCE(location_id,0) = COALESCE(?,0)`
  ).get(locationId).c;
  if (!inForce && cards.length) {
    database.prepare("UPDATE rate_versions SET status = 'approved' WHERE id = ?").run(cards[0].id);
  }
};

// ── What the job form is allowed to offer ────────────────────────────────────
// The rate master decides which paper sizes, weights, bindings and finishing
// options exist — not a hardcoded list in the UI. Offering a combination the card
// cannot price produces a job nobody can cost, so the form asks here first.
//
// Every requestor needs this to render the form, so it is deliberately NOT behind
// canViewRates: it exposes which options exist, never what they cost.
router.get('/print-options', authenticateToken, (req, res) => {
  try {
    const card = db
      .prepare(
        `SELECT * FROM rate_versions WHERE status = 'approved'
           AND effective_from <= date('now')
           AND (effective_to IS NULL OR effective_to >= date('now'))
         ORDER BY effective_from DESC LIMIT 1`
      )
      .get();
    // No card in force: return nothing rather than a guess. The form falls back to
    // its full list so work is never blocked by an unconfigured rate master.
    if (!card) return res.json({ card: null, combinations: [], bindings: [], finishing: [] });

    const lines = db.prepare('SELECT * FROM rate_lines WHERE version_id = ?').all(card.id);

    // Size/GSM/colour are only meaningful together — the sheet prices 300 GSM for A4
    // and A3 in colour only, so the form must not offer 300 GSM on A5 or in B&W.
    const combinations = lines
      .filter((l) => l.service_code === 'PRINT' && l.paper_size && l.paper_gsm)
      .map((l) => ({ size: l.paper_size, gsm: l.paper_gsm, colour: l.colour_mode }));

    const has = (code) => lines.some((l) => l.service_code === code);
    // A binding priced on something other than paper size (a box file is charged by
    // spine thickness) carries its choices here, so the form can ask for the one
    // detail that makes the line resolvable.
    const variantsFor = (code) => [
      ...new Set(lines.filter((l) => l.service_code === code && l.variant).map((l) => l.variant)),
    ];
    const bindings = Object.entries(BINDING_FORM_LABELS)
      .filter(([code]) => has(code))
      .map(([code, label]) => ({ code, label, variants: variantsFor(code) }));
    const finishing = Object.entries(FINISHING_FORM_FIELDS)
      .filter(([, f]) => has(f.serviceCode))
      .map(([field, f]) => ({ field, label: f.label }));

    // Everything else the card prices — pouch lamination, cardboard, scanning, board
    // stock, boxes, packing. These have no dedicated field, so the form offers them as
    // optional add-ons. Each publishes its own dimension combinations rather than the
    // form guessing: board stock is 12X18 in four weights, a box is "5 PLAY".
    const dedicated = new Set(['PRINT', ...Object.keys(BINDING_FORM_LABELS),
      ...Object.values(FINISHING_FORM_FIELDS).map((f) => f.serviceCode)]);
    const optionLabel = (l) => [l.paper_size, l.paper_gsm && `${l.paper_gsm} GSM`, l.colour_mode, l.variant]
      .filter(Boolean).join(' · ') || 'Standard';
    const services = db
      .prepare('SELECT * FROM service_items WHERE active = 1')
      .all()
      .filter((s) => !dedicated.has(s.code) && lines.some((l) => l.service_code === s.code))
      .map((s) => ({
        code: s.code,
        label: s.label,
        uom: s.uom,
        // Carried through to the document so the annexure groups the line the way the
        // service is classified, rather than dumping every extra into misc.
        costGroup: s.cost_group,
        options: lines
          .filter((l) => l.service_code === s.code)
          .map((l) => ({
            size: l.paper_size, gsm: l.paper_gsm, colour: l.colour_mode,
            variant: l.variant, label: optionLabel(l),
          })),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    res.json({
      card: { code: card.code, label: card.label, effective_from: card.effective_from },
      combinations,
      bindings,
      finishing,
      services,
    });
  } catch (error) {
    console.error('Error building print options:', error);
    res.status(500).json({ error: 'Failed to load printing options' });
  }
});

// Form label ↔ service code. The form submits the label, so this is the same mapping
// the costing adapter uses, read in the opposite direction.
// Ordered light → heavy. Sheet names differ from what a requestor would recognise:
// "center pin" is a staple, "english bianding" is perfect/glue, "hard bianding" is a
// hard case. The labels here are the readable form; the codes are what the sheet maps to.
const BINDING_FORM_LABELS = {
  BIND_STAPLE: 'Staple',
  BIND_SPIRAL: 'Spiral',
  BIND_WIRO: 'Wiro',
  BIND_SCREW: 'Screw',
  BIND_TAPE: 'Tape',
  BIND_PERFECT: 'Perfect / Glue',
  BIND_REBIND: 'Re-binding',
  BIND_HARDCASE: 'Hard Case',
  BIND_REXINE: 'Hard Rexine',
  BOX_FILE: 'Box File',
  EMBOSSING: 'Digital Embossing',
};

const FINISHING_FORM_FIELDS = {
  soft_lamination: { serviceCode: 'LAMINATE_SOFT', label: 'Soft Lamination' },
  separators: { serviceCode: 'SEPARATOR', label: 'Separators' },
  hole_punch: { serviceCode: 'HOLE_PUNCH', label: 'Hole Punch' },
  cover_page: { serviceCode: 'COLOUR_CARD', label: 'Cover Page' },
};

// ── Cards ──
router.get('/versions', authenticateToken, (req, res) => {
  try {
    if (!canViewRates(req)) return res.status(403).json({ error: 'Not authorized to view rate cards' });
    const rows = db.prepare(
      `SELECT v.*, l.name AS location_name, u.name AS approved_by_name,
              (SELECT COUNT(*) FROM rate_lines rl WHERE rl.version_id = v.id) AS line_count,
              (SELECT COUNT(*) FROM rate_lines rl WHERE rl.version_id = v.id AND rl.needs_review = 1) AS review_count
         FROM rate_versions v
         LEFT JOIN locations l ON l.id = v.location_id
         LEFT JOIN users u ON u.id = v.approved_by
        ORDER BY v.effective_from DESC, v.code`
    ).all();
    res.json(rows);
  } catch (error) {
    console.error('Error fetching rate versions:', error);
    res.status(500).json({ error: 'Failed to fetch rate cards' });
  }
});

// ── One card's lines, grouped for display ──
router.get('/versions/:code/lines', authenticateToken, (req, res) => {
  try {
    if (!canViewRates(req)) return res.status(403).json({ error: 'Not authorized to view rate cards' });
    const version = db.prepare('SELECT * FROM rate_versions WHERE code = ?').get(req.params.code);
    if (!version) return res.status(404).json({ error: 'Rate card not found' });

    const lines = db.prepare(
      `SELECT l.*, s.label AS service_label, s.uom, s.cost_group, s.pricing_kind
         FROM rate_lines l
         JOIN service_items s ON s.code = l.service_code
        WHERE l.version_id = ?
        -- paper_gsm is TEXT, so a plain sort puts 100 before 80. Cast it, and order
        -- sizes largest-first (A1 before A5) rather than alphabetically.
        ORDER BY s.cost_group, s.label,
                 CAST(NULLIF(l.paper_gsm, '') AS INTEGER),
                 CASE l.paper_size WHEN 'A1' THEN 1 WHEN 'A2' THEN 2 WHEN 'A3' THEN 3
                                   WHEN 'A4' THEN 4 WHEN 'A5' THEN 5 WHEN 'B5' THEN 6
                                   ELSE 7 END,
                 l.paper_size, l.colour_mode, l.variant`
    ).all(version.id);

    // The UI needs to say WHY approval is unavailable — "you prepared this card" and
    // "you are not a rate approver" are different problems with different fixes, and a
    // disabled button that explains neither is what makes a control feel arbitrary.
    const preparers = preparersOf(version.id);
    const isApprover = canApproveRates(req);
    const isPreparer = preparers.some((p) => p.user_id === req.user.id);
    const otherApprovers = db.prepare(
      `SELECT COUNT(*) AS c FROM users
        WHERE is_rate_approver = 1 AND deleted_at IS NULL
          AND id NOT IN (SELECT user_id FROM rate_card_activity WHERE version_id = ?)`
    ).get(version.id).c;

    res.json({
      version,
      lines: lines.map((l) => ({ ...l, rate_display: rupees(l.rate_milli) })),
      prepared_by: preparers.map((p) => p.name).filter(Boolean),
      can_approve: isApprover && !isPreparer,
      approval_block: !isApprover ? 'not_an_approver' : isPreparer ? 'you_prepared_it' : null,
      eligible_approvers: otherApprovers,
    });
  } catch (error) {
    console.error('Error fetching rate lines:', error);
    res.status(500).json({ error: 'Failed to fetch rate card lines' });
  }
});

// ── Upload a rate workbook → a new draft card ────────────────────────────────
// The spreadsheet is the source of truth, so importing it fills every rate field
// automatically. It always lands as a DRAFT: nothing prices a job until someone
// reviews the parsed figures and approves the card.
router.post('/import', authenticateToken, rateUpload.single('workbook'), (req, res) => {
  const tmpPath = req.file?.path;
  try {
    if (!canMaintainRates(req)) return res.status(403).json({ error: 'Not authorized to maintain rate cards' });
    if (!req.file) return res.status(400).json({ error: 'Attach an Excel workbook to import' });

    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'A card code is required (e.g. RC-2027)' });

    const existing = db.prepare('SELECT status FROM rate_versions WHERE code = ?').get(code);
    if (existing && existing.status !== 'draft') {
      // Approved cards are immutable — annexures already reference their rates.
      return res.status(409).json({
        error: `${code} is ${existing.status} and cannot be overwritten. Import under a new code, or duplicate it as a draft first.`,
      });
    }

    const block = PRINT_BLOCKS[req.body?.block] ? req.body.block : 'annexure';
    const result = importRateWorkbook(db, tmpPath, {
      code,
      label: String(req.body?.label || '').trim() || `Rate card ${code}`,
      effectiveFrom: String(req.body?.effective_from || '').trim() || new Date().toISOString().slice(0, 10),
      sourceNote: req.file.originalname,
      block,
    });
    if (result.skipped) return res.status(409).json({ error: result.skipped });

    const imported = db.prepare('SELECT id FROM rate_versions WHERE code = ?').get(code);
    if (imported) recordRateActivity(imported.id, req.user.id, 'import', req.file.originalname);

    res.status(201).json({
      code,
      services: result.services,
      lines: result.lines,
      warnings: result.warnings || [],
      message: `${code} imported as a draft — ${result.lines} rate(s) from ${req.file.originalname}. `
             + 'Review the figures, then have a rate approver put the card in force.',
    });
  } catch (error) {
    console.error('Error importing rate workbook:', error);
    res.status(500).json({ error: error.message || 'Could not read that workbook' });
  } finally {
    if (tmpPath) fs.unlink(tmpPath, () => {});
  }
});

// ── Edit one rate on a draft card ────────────────────────────────────────────
// Only a draft can be edited. An approved card is the evidence behind annexures
// already issued, so changing it would silently restate work that is already
// signed off — duplicate it as a draft instead (below).
router.patch('/versions/:code/lines/:id', authenticateToken, (req, res) => {
  try {
    if (!canMaintainRates(req)) return res.status(403).json({ error: 'Not authorized to maintain rate cards' });
    const version = db.prepare('SELECT * FROM rate_versions WHERE code = ?').get(req.params.code);
    if (!version) return res.status(404).json({ error: 'Rate card not found' });
    if (version.status !== 'draft') {
      return res.status(409).json({
        error: `${version.code} is ${version.status} and cannot be edited. Duplicate it as a draft to change rates.`,
      });
    }

    const line = db.prepare('SELECT * FROM rate_lines WHERE id = ? AND version_id = ?')
      .get(req.params.id, version.id);
    if (!line) return res.status(404).json({ error: 'Rate line not found on this card' });

    const raw = String(req.body?.rate ?? '').trim();
    const rate = Number(raw);
    if (!raw || !Number.isFinite(rate) || rate < 0) {
      return res.status(400).json({ error: 'Enter a rate of zero or more' });
    }
    // Rupees carry three decimals on the card; store as integer thousandths.
    const rateMilli = Math.round(rate * 1000);

    db.prepare('UPDATE rate_lines SET rate_milli = ?, needs_review = 0 WHERE id = ?')
      .run(rateMilli, line.id);
    // Editing a rate makes you a preparer of this card, even if someone else imported
    // it — otherwise rewriting every figure and then approving would pass the check.
    recordRateActivity(version.id, req.user.id, 'edit', `${line.service_code} → ₹${rupees(rateMilli)}`);

    res.json({
      id: line.id,
      rate_milli: rateMilli,
      rate_display: rupees(rateMilli),
      message: `${line.service_code} updated to ₹${rupees(rateMilli)}.`,
    });
  } catch (error) {
    console.error('Error updating rate line:', error);
    res.status(500).json({ error: 'Failed to update rate' });
  }
});

// ── Duplicate a card as a new draft ──────────────────────────────────────────
// The supported way to revise an approved card: copy it, edit the copy, approve it.
// The original stays exactly as it was for every annexure that cites it.
router.post('/versions/:code/duplicate', authenticateToken, (req, res) => {
  try {
    if (!canMaintainRates(req)) return res.status(403).json({ error: 'Not authorized to maintain rate cards' });
    const source = db.prepare('SELECT * FROM rate_versions WHERE code = ?').get(req.params.code);
    if (!source) return res.status(404).json({ error: 'Rate card not found' });

    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'A code for the new card is required' });
    if (db.prepare('SELECT 1 FROM rate_versions WHERE code = ?').get(code)) {
      return res.status(409).json({ error: `${code} already exists` });
    }
    const effectiveFrom = String(req.body?.effective_from || '').trim() || new Date().toISOString().slice(0, 10);

    const newId = db.transaction(() => {
      const id = Number(db.prepare(
        `INSERT INTO rate_versions (code, label, status, effective_from, location_id, source_note)
         VALUES (?, ?, 'draft', ?, ?, ?)`
      ).run(code, String(req.body?.label || '').trim() || `${source.label} (revised)`,
        effectiveFrom, source.location_id, `Duplicated from ${source.code}`).lastInsertRowid);

      db.prepare(
        `INSERT INTO rate_lines (version_id, service_code, paper_size, paper_gsm, colour_mode,
                                 variant, rate_milli, min_charge_paise, needs_review, note)
         SELECT ?, service_code, paper_size, paper_gsm, colour_mode, variant, rate_milli,
                min_charge_paise, needs_review, note
           FROM rate_lines WHERE version_id = ?`
      ).run(id, source.id);
      recordRateActivity(id, req.user.id, 'duplicate', `Copied from ${source.code}`);
      return id;
    })();

    const count = db.prepare('SELECT COUNT(*) AS c FROM rate_lines WHERE version_id = ?').get(newId).c;
    res.status(201).json({ code, message: `${code} created as a draft with ${count} rate(s) copied from ${source.code}.` });
  } catch (error) {
    console.error('Error duplicating rate card:', error);
    res.status(500).json({ error: 'Failed to duplicate rate card' });
  }
});

// ── Resolve a single rate ──
// Most specific match wins; NULL on a dimension means "applies to any".
router.get('/resolve', authenticateToken, (req, res) => {
  try {
    if (!canViewRates(req)) return res.status(403).json({ error: 'Not authorized' });
    const { service, size, gsm, colour, variant, on } = req.query;
    if (!service) return res.status(400).json({ error: 'service is required' });

    const asOf = on || new Date().toISOString().slice(0, 10);
    const version = db.prepare(
      `SELECT * FROM rate_versions
        WHERE status = 'approved' AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY location_id IS NULL, effective_from DESC LIMIT 1`
    ).get(asOf, asOf);

    if (!version) {
      return res.status(409).json({
        ok: false, reason: 'no_approved_card',
        error: `No approved rate card is in force on ${asOf}.`,
      });
    }

    const line = resolveLine(version.id, { service, size, gsm, colour, variant });
    if (!line) {
      return res.status(409).json({
        ok: false, reason: 'rate_not_found',
        error: `${version.code} has no rate for ${[service, size, gsm, colour, variant].filter(Boolean).join('/')}.`,
      });
    }
    res.json({ ok: true, version: version.code, rate_milli: line.rate_milli, rate_display: rupees(line.rate_milli), line });
  } catch (error) {
    console.error('Error resolving rate:', error);
    res.status(500).json({ error: 'Failed to resolve rate' });
  }
});

// Exact match first, then progressively relax the least significant dimensions.
const resolveLine = (versionId, { service, size, gsm, colour, variant }) => {
  const attempt = db.prepare(
    `SELECT * FROM rate_lines
      WHERE version_id = ? AND service_code = ?
        AND (paper_size  IS ? OR paper_size  IS NULL)
        AND (paper_gsm   IS ? OR paper_gsm   IS NULL)
        AND (colour_mode IS ? OR colour_mode IS NULL)
        AND (variant     IS ? OR variant     IS NULL)
      ORDER BY (paper_size IS NOT NULL) + (paper_gsm IS NOT NULL)
             + (colour_mode IS NOT NULL) + (variant IS NOT NULL) DESC
      LIMIT 1`
  );
  return attempt.get(versionId, service, size || null, gsm || null, colour || null, variant || null) || null;
};

// ── Approve a card. Until this happens the card prices nothing (BR-01). ──
router.post('/versions/:code/approve', authenticateToken, (req, res) => {
  try {
    if (!canApproveRates(req)) {
      return res.status(403).json({
        error: 'Only a designated rate approver can put a rate card in force. '
             + 'Importing and editing cards is a separate right.',
      });
    }
    const v = db.prepare('SELECT * FROM rate_versions WHERE code = ?').get(req.params.code);
    if (!v) return res.status(404).json({ error: 'Rate card not found' });
    if (v.status === 'approved') return res.status(400).json({ error: `${v.code} is already approved.` });

    // Segregation of duties. An approved card prices every job that follows it, so the
    // person who typed the figures cannot be the one who makes them chargeable.
    const preparers = preparersOf(v.id);
    if (preparers.some((p) => p.user_id === req.user.id)) {
      return res.status(403).json({
        error: `You imported or edited ${v.code}, so you cannot approve it. `
             + 'Another designated rate approver has to review and approve this card.',
        code: 'SEGREGATION_OF_DUTIES',
      });
    }

    const unresolved = db.prepare(
      'SELECT COUNT(*) AS c FROM rate_lines WHERE version_id = ? AND needs_review = 1'
    ).get(v.id).c;
    // Lines flagged as unreadable must be settled first — approving them would turn a
    // transcription guess into a chargeable rate.
    if (unresolved > 0 && !req.body?.acknowledge_unreviewed) {
      return res.status(409).json({
        error: `${v.code} has ${unresolved} line(s) still marked for review. Confirm or remove them first.`,
        needs_review: unresolved,
        hint: 'Re-send with acknowledge_unreviewed: true to approve anyway.',
      });
    }

    db.transaction(() => {
      db.prepare(
        `UPDATE rate_versions SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?`
      ).run(req.user.id, v.id);
      // Every card's window is then recomputed together, so approving out of order
      // (August after September) still leaves one continuous, non-overlapping chain.
      rebuildTimeline(db, v.location_id);
    })();

    // A card already approved from a later date still governs its own period, so the
    // one just approved does not necessarily price today's jobs. Say so plainly.
    const laterCards = db.prepare(
      `SELECT code, effective_from FROM rate_versions
        WHERE status = 'approved' AND COALESCE(location_id,0) = COALESCE(?,0)
          AND id != ? AND effective_from >= ?
        ORDER BY effective_from`
    ).all(v.location_id, v.id, v.effective_from);

    res.json({
      code: v.code,
      status: 'approved',
      overlaps: laterCards,
      message: laterCards.length
        ? `${v.code} approved, effective ${v.effective_from}. Note: ${laterCards.map((c) => `${c.code} (from ${c.effective_from})`).join(', ')} `
          + 'start later and still govern their own periods.'
        : `${v.code} approved and now in force.`,
    });
  } catch (error) {
    console.error('Error approving rate card:', error);
    res.status(500).json({ error: 'Failed to approve the rate card' });
  }
});

export default router;
