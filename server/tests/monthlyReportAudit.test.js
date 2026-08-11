// Monthly printing report — audit trail, unmapped-item safety, and the July/August
// acceptance test.
//
// Two properties matter most here and both are asserted against the database rather
// than against the code's intentions:
//
//   * Generating a report is READ-ONLY. The audit row is the only write. The test for
//     this fingerprints every business table before and after an export and fails if
//     anything else moved — it does not trust a reading of the route.
//   * An item the rate template cannot price is never given an invented rate. It is
//     reported, and it stays out of the total.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import db from '../database.js';
import annexuresRouter from '../routes/annexures.js';
import { JWT_SECRET } from '../middleware/auth.js';
import { buildMonthlyReport } from '../services/monthlyPrintingReport.js';
import { classifyPaperRows, generateMonthlyWorkbook, SHEET } from '../services/monthlyPrintingExcel.js';
import { ACTIONS, ENTITY_TYPE, reportIdentifier, istStamp } from '../services/monthlyReportAudit.js';

const app = express();
app.use(express.json());
app.use('/api', annexuresRouter);

const tokenFor = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
const uniq = () => `au-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const makeUser = (suffix, { role = 'user', managerId = null, coordinator = false } = {}) => {
  const ref = `${uniq()}-${suffix}`;
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, manager_id,
                        is_printer_coordinator, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', ?, ?, ?, 1, datetime('now'))`
  ).run(ref, `Test ${suffix}`, `${ref}@example.test`, role, managerId, coordinator ? 1 : 0);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role };
};

/** A costed job. `lines` lets a test place several services on one annexure. */
const makeJob = (requestor, manager, {
  approvedAt, status = 'approved', jobStatus = 'completed',
  lines = [{ gsm: '80', colour: 'BW', size: 'A4', qty: 100 }],
  printing = 100000, binding = 20000, finishing = 5000,
  project = 'Alpha', pages = 10, dept = 'Engineering', debit = '3559',
} = {}) => {
  const ref = uniq();
  const jobId = Number(db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by, completed_at,
                             manager_id_at_submit, manager_name_at_submit, manager_ps_at_submit,
                             project_name, department_name, debit_code, number_of_pages, dt_number)
     VALUES (?, ?, ?, ?, datetime('now'), ?, ?, '999', ?, ?, ?, ?, ?)`
  ).run(`REQ-${ref}`, `JOB-${ref}`, jobStatus, requestor.id,
        manager?.id ?? null, manager?.name ?? null, project, dept, debit, pages,
        `DT-${ref}`).lastInsertRowid);

  const annexureId = Number(db.prepare(
    `INSERT INTO cost_annexures (annexure_no, job_id, version, status, approved_at,
                                 printing_paise, binding_paise, finishing_paise,
                                 basic_paise, grand_total_paise, line_count)
     VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?)`
  ).run(`PCA-${ref}`, jobId, approvedAt ?? null, printing, binding, finishing,
        printing + binding + finishing, printing + binding + finishing,
        lines.length).lastInsertRowid);

  for (const l of lines) {
    db.prepare(
      `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
                                   rate_milli, amount_paise, rate_status,
                                   paper_size, paper_gsm, colour_mode, annexure_id)
       VALUES (?, ?, ?, 'printing', ?, 'page', 1150, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, l.code ?? 'PRINT', l.label ?? 'Printing', l.qty, l.amount ?? 0,
          l.rateStatus ?? 'priced', l.size, l.gsm ?? null, l.colour ?? null, annexureId);
  }
  if (binding) {
    db.prepare(
      `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
                                   rate_milli, amount_paise, rate_status, annexure_id)
       VALUES (?, 'BIND', 'Spiral binding', 'binding', 1, 'job', 0, ?, 'priced', ?)`
    ).run(jobId, binding, annexureId);
  }
  if (finishing) {
    db.prepare(
      `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
                                   rate_milli, amount_paise, rate_status, annexure_id)
       VALUES (?, 'LAM', 'Lamination', 'finishing', 1, 'job', 0, ?, 'priced', ?)`
    ).run(jobId, finishing, annexureId);
  }
  if (status !== 'draft') {
    db.prepare('UPDATE cost_annexures SET status = ? WHERE id = ?').run(status, annexureId);
  }
  return { jobId, annexureId, jobNumber: `JOB-${ref}`, annexureNo: `PCA-${ref}` };
};

const cleanup = (jobIds, userIds) => {
  jobIds.forEach((id) => {
    db.prepare("UPDATE cost_annexures SET status='superseded' WHERE job_id = ?").run(id);
    db.prepare('DELETE FROM job_cost_lines WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM annexure_approvals WHERE annexure_id IN (SELECT id FROM cost_annexures WHERE job_id = ?)').run(id);
    db.prepare('DELETE FROM cost_annexures WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id);
  });
  userIds.forEach((id) => {
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_activity_logs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
};

const JULY = '2026-07-15 06:00:00';
const AUGUST = '2026-08-15 06:00:00';
const UNMAPPABLE = { gsm: '130', colour: 'COLOUR', size: '12X18', qty: 40, amount: 0,
                     label: 'Paper / board stock', code: 'BOARD' };

const reportFor = (monthKey, extra = {}) =>
  buildMonthlyReport({ monthKey, scope: { managerId: null }, ...extra });

const auditRowsFor = (userId) => db.prepare(
  'SELECT * FROM audit_logs WHERE user_id = ? ORDER BY id DESC'
).all(userId);

// ── 1. Audit content ────────────────────────────────────────────────────────────

test('A1: an export writes one audit row naming the report, month and user', async () => {
  const coord = makeUser('c1', { coordinator: true });
  const mgr = makeUser('m1', { role: 'manager' });
  const usr = makeUser('u1', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    const res = await request(app)
      .get('/api/annexures/monthly-report/export')
      .query({ month: '2026-07', member: usr.id })
      .set('Authorization', `Bearer ${tokenFor(coord)}`)
      .buffer(true).parse(binaryParser);
    assert.equal(res.status, 200);

    const rows = auditRowsFor(coord.id).filter((r) => r.action === ACTIONS.EXPORTED);
    assert.equal(rows.length, 1, 'exactly one export row');
    const row = rows[0];
    assert.equal(row.action, 'MONTHLY_PRINTING_REPORT_EXPORTED');
    assert.equal(row.entity_type, ENTITY_TYPE);
    assert.equal(row.user_id, coord.id);                       // K: who
    assert.equal(row.user_name, coord.name);
    assert.ok(row.created_at, 'L: timestamp');
    assert.match(row.details, /MONTHLY PRINTING ANNEXURE REPORT/);
    assert.match(row.details, /Month: July 2026/);              // C: month
    assert.match(row.details, /Jobs: 1/);                        // I: job count
    assert.match(row.details, /Grand Total: ₹/);                 // J: total
    assert.match(row.details, /File: Printing_Annexure_July_2026/); // M: filename
    assert.match(row.details, /Report ID: MPR-2026-07-/);
    assert.match(row.details, /Generated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} IST/);
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

test('A2: every filter is recorded, by name and not only by id', async () => {
  const coord = makeUser('c2', { coordinator: true });
  const mgr = makeUser('m2', { role: 'manager' });
  const usr = makeUser('u2', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, project: 'Solaris', dept: 'Engineering', debit: '3559' });
  try {
    const res = await request(app)
      .get('/api/annexures/monthly-report/export')
      .query({ month: '2026-07', manager: mgr.id, member: usr.id,
               department: 'Engineering', debit_code: '3559', project: 'Solaris' })
      .set('Authorization', `Bearer ${tokenFor(coord)}`)
      .buffer(true).parse(binaryParser);
    assert.equal(res.status, 200);

    const details = auditRowsFor(coord.id).find((r) => r.action === ACTIONS.EXPORTED).details;
    assert.match(details, new RegExp(`Manager = ${mgr.name}`));   // D
    assert.match(details, new RegExp(`Team Member = ${usr.name}`)); // E
    assert.match(details, /Department = Engineering/);            // F
    assert.match(details, /Debit Code = 3559/);                   // G
    assert.match(details, /Project = Solaris/);                   // H
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

test('A3: an unfiltered export says so rather than leaving the field blank', async () => {
  const coord = makeUser('c3', { coordinator: true });
  const mgr = makeUser('m3', { role: 'manager' });
  const usr = makeUser('u3', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    await request(app).get('/api/annexures/monthly-report/export')
      .query({ month: '2026-07' })
      .set('Authorization', `Bearer ${tokenFor(coord)}`)
      .buffer(true).parse(binaryParser);
    const details = auditRowsFor(coord.id).find((r) => r.action === ACTIONS.EXPORTED).details;
    assert.match(details, /Filters: None \(all in scope\)/);
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

test('A4: a preview is audited too, and separately from an export', async () => {
  const coord = makeUser('c4', { coordinator: true });
  const mgr = makeUser('m4', { role: 'manager' });
  const usr = makeUser('u4', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    await request(app).get('/api/annexures/monthly-report')
      .query({ month: '2026-07', member: usr.id })
      .set('Authorization', `Bearer ${tokenFor(coord)}`);

    const previews = auditRowsFor(coord.id).filter((r) => r.action === ACTIONS.PREVIEWED);
    assert.equal(previews.length, 1);
    assert.equal(previews[0].action, 'MONTHLY_PRINTING_REPORT_PREVIEWED');
    assert.match(previews[0].details, /Month: July 2026/);
    // A preview produces no file, so it must not claim one.
    assert.ok(!/File:/.test(previews[0].details), 'a preview has no filename');
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

test('A4b: a repeated identical preview is recorded once, but exports never collapse', async () => {
  const coord = makeUser('c4b', { coordinator: true });
  const mgr = makeUser('m4b', { role: 'manager' });
  const usr = makeUser('u4b', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  const token = tokenFor(coord);
  try {
    // The same view three times over — a refresh, a double-click, React's development
    // double-render. One viewing, one row.
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/api/annexures/monthly-report')
        .query({ month: '2026-07', member: usr.id }).set('Authorization', `Bearer ${token}`);
    }
    assert.equal(auditRowsFor(coord.id).filter((r) => r.action === ACTIONS.PREVIEWED).length, 1,
      'repeat views of the same report collapse into one entry');

    // A different month is a different report and must be recorded separately.
    await request(app).get('/api/annexures/monthly-report')
      .query({ month: '2026-08', member: usr.id }).set('Authorization', `Bearer ${token}`);
    // (August holds nothing for this member, so nothing is disclosed and nothing logged.)

    // Every export is its own event: each produced a file that left the building.
    for (let i = 0; i < 2; i += 1) {
      await request(app).get('/api/annexures/monthly-report/export')
        .query({ month: '2026-07', member: usr.id }).set('Authorization', `Bearer ${token}`)
        .buffer(true).parse(binaryParser);
    }
    assert.equal(auditRowsFor(coord.id).filter((r) => r.action === ACTIONS.EXPORTED).length, 2,
      'two downloads are two audit entries');
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

test('A5: an empty month is not audited as a disclosure', async () => {
  const coord = makeUser('c5', { coordinator: true });
  try {
    await request(app).get('/api/annexures/monthly-report')
      .query({ month: '2019-02' })
      .set('Authorization', `Bearer ${tokenFor(coord)}`);
    assert.equal(auditRowsFor(coord.id).length, 0, 'nothing was disclosed, nothing recorded');
  } finally { cleanup([], [coord.id]); }
});

test('A6: the report identifier is deterministic and filter-sensitive', () => {
  const a = reportIdentifier({ monthKey: '2026-07', filters: { manager: 25 } });
  const b = reportIdentifier({ monthKey: '2026-07', filters: { manager: 25 } });
  const c = reportIdentifier({ monthKey: '2026-07', filters: { manager: 26 } });
  const d = reportIdentifier({ monthKey: '2026-08', filters: { manager: 25 } });
  assert.equal(a, b, 'same request → same id, so two exports can be compared');
  assert.notEqual(a, c, 'a different filter is a different extract');
  assert.notEqual(a, d, 'a different month is a different extract');
  assert.match(a, /^MPR-2026-07-[0-9a-f]{10}$/);
});

test('A7: the audit timestamp is rendered in IST', () => {
  // 2026-07-31 18:30 UTC is 2026-08-01 00:00 IST — the case that catches a naive
  // implementation that just formats the UTC value.
  assert.equal(istStamp(new Date('2026-07-31T18:30:00Z')), '2026-08-01 00:00:00 IST');
  assert.equal(istStamp(new Date('2026-07-15T06:00:00Z')), '2026-07-15 11:30:00 IST');
});

// ── 2. Read-only: the audit row is the ONLY write ───────────────────────────────

test('A8: generating a report changes no business data whatsoever', async () => {
  const coord = makeUser('c8', { coordinator: true });
  const mgr = makeUser('m8', { role: 'manager' });
  const usr = makeUser('u8', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    // Fingerprint every table the export could plausibly touch — status, approval date,
    // amounts, manager stamping, costing and the rate master.
    //
    // Scoped to THIS test's rows. The suites run in parallel against one database, so a
    // whole-table snapshot also captures another file's fixtures being created and torn
    // down, and fails for reasons that have nothing to do with the export.
    const SCOPED = {
      print_jobs: `SELECT * FROM print_jobs WHERE id = ${j.jobId}`,
      cost_annexures: `SELECT * FROM cost_annexures WHERE job_id = ${j.jobId}`,
      job_cost_lines: `SELECT * FROM job_cost_lines WHERE job_id = ${j.jobId} ORDER BY id`,
      annexure_approvals: `SELECT * FROM annexure_approvals WHERE annexure_id = ${j.annexureId}`,
      users: `SELECT * FROM users WHERE id IN (${usr.id}, ${mgr.id}, ${coord.id}) ORDER BY id`,
      // The rate master is global and must not be touched by anyone during an export.
      rate_versions: 'SELECT * FROM rate_versions ORDER BY id',
      rate_lines: 'SELECT COUNT(*) n, SUM(rate_milli) s FROM rate_lines',
      service_items: 'SELECT COUNT(*) n FROM service_items',
    };
    const snapshot = () => Object.fromEntries(Object.entries(SCOPED)
      .map(([t, sql]) => [t, JSON.stringify(db.prepare(sql).all())]));

    const before = snapshot();
    const auditBefore = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE user_id = ?').get(coord.id).c;

    await request(app).get('/api/annexures/monthly-report')
      .query({ month: '2026-07', member: usr.id })
      .set('Authorization', `Bearer ${tokenFor(coord)}`);
    const res = await request(app).get('/api/annexures/monthly-report/export')
      .query({ month: '2026-07', member: usr.id })
      .set('Authorization', `Bearer ${tokenFor(coord)}`)
      .buffer(true).parse(binaryParser);
    assert.equal(res.status, 200);

    const after = snapshot();
    for (const t of Object.keys(SCOPED)) {
      assert.equal(after[t], before[t], `${t} was modified — the export must be read-only`);
    }
    // And the audit rows really were written, so the comparison above is meaningful.
    const auditAfter = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE user_id = ?').get(coord.id).c;
    assert.equal(auditAfter - auditBefore, 2, 'one preview row and one export row');
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

test('A9: an approved annexure keeps its status, date and amounts after export', async () => {
  const coord = makeUser('c9', { coordinator: true });
  const mgr = makeUser('m9', { role: 'manager' });
  const usr = makeUser('u9', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    const read = () => db.prepare(
      `SELECT a.status, a.approved_at, a.grand_total_paise, a.printing_paise,
              j.status AS job_status, j.manager_id_at_submit, j.created_by
         FROM cost_annexures a JOIN print_jobs j ON j.id = a.job_id WHERE a.id = ?`
    ).get(j.annexureId);

    const before = read();
    await request(app).get('/api/annexures/monthly-report/export')
      .query({ month: '2026-07', member: usr.id })
      .set('Authorization', `Bearer ${tokenFor(coord)}`)
      .buffer(true).parse(binaryParser);

    assert.deepEqual(read(), before,
      'status, approval date, amounts, manager and requestor must all be untouched');
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

// ── 3. Unmapped items are never invented ────────────────────────────────────────

test('A10: 130 GSM / COLOUR / 12X18 is reported unmapped, never guessed', async () => {
  const mgr = makeUser('m10', { role: 'manager' });
  const usr = makeUser('u10', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, lines: [UNMAPPABLE] });
  try {
    const report = reportFor('2026-07', { filters: { member: usr.id } });
    const { mapped, unmapped } = await classifyPaperRows(report.paper_rows);

    assert.equal(mapped.length, 0, 'the template has no row for it');
    assert.equal(unmapped.length, 1);
    assert.equal(unmapped[0].paper_gsm, '130');
    assert.equal(unmapped[0].paper_size, '12X18');
    assert.equal(unmapped[0].quantity, 40);
    assert.equal(unmapped[0].template_row, null, 'no row was invented for it');

    const { workbook, unmapped: fromWb } = await generateMonthlyWorkbook(report);
    const ws = workbook.getWorksheet(SHEET);
    // Not on the B&W row, not on another size, not anywhere.
    for (let r = 8; r <= 48; r += 1) {
      assert.ok(!ws.getCell(r, 5).value,
        `row ${r} was populated — an unmappable item must not borrow another paper's rate`);
    }
    assert.equal(fromWb.length, 1);
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('A11: an unmapped item does not inflate or deflate the priced quantities', async () => {
  const mgr = makeUser('m11', { role: 'manager' });
  const usr = makeUser('u11', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, lines: [
    { gsm: '80', colour: 'BW', size: 'A4', qty: 500, amount: 57500 },
    UNMAPPABLE,
  ] });
  try {
    const report = reportFor('2026-07', { filters: { member: usr.id } });
    const { workbook, unmapped } = await generateMonthlyWorkbook(report);
    const ws = workbook.getWorksheet(SHEET);

    assert.equal(ws.getCell('E9').value, 500, 'the priced line is unaffected');
    assert.equal(unmapped.length, 1, 'and the unpriced one is reported, not merged in');
    // It must not have been folded into any other populated row either.
    const populated = [];
    for (let r = 8; r <= 48; r += 1) if (ws.getCell(r, 5).value) populated.push(r);
    assert.deepEqual(populated, [9], 'exactly one row carries a quantity');
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('A12: the workbook carries an Unmapped Items sheet with no amount', async () => {
  const mgr = makeUser('m12', { role: 'manager' });
  const usr = makeUser('u12', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, lines: [
    { gsm: '80', colour: 'BW', size: 'A4', qty: 500, amount: 57500 }, UNMAPPABLE,
  ] });
  try {
    const { workbook } = await generateMonthlyWorkbook(reportFor('2026-07', { filters: { member: usr.id } }));
    const buffer = await workbook.xlsx.writeBuffer();
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(buffer);

    const sheet = reread.getWorksheet('Unmapped Items');
    assert.ok(sheet, 'the sheet exists');
    const row = sheet.getRow(2);
    assert.equal(row.getCell(2).value, '130');
    assert.equal(row.getCell(4).value, '12X18');
    assert.equal(row.getCell(5).value, 40, 'the quantity is stated');
    assert.equal(row.getCell(6).value, 'RATE NOT CONFIGURED');
    assert.equal(row.getCell(7).value, 'NOT INCLUDED IN TOTAL');
    assert.equal(row.getCell(8).value, 'UNMAPPED');
    // No number anywhere that could be read as a price.
    assert.equal(typeof row.getCell(6).value, 'string');
    assert.equal(typeof row.getCell(7).value, 'string');

    const text = [];
    sheet.eachRow((r) => text.push(String(r.getCell(1).value ?? '')));
    assert.ok(text.some((t) => /NOT included in the Grand Total/i.test(t)),
      'the sheet says plainly that these are excluded');

    // And the annexure sheet itself warns, so the exclusion is visible without
    // opening another tab.
    const warn = String(reread.getWorksheet(SHEET).getCell('K6').value ?? '');
    assert.match(warn, /unpriced item/i);
    assert.match(warn, /Unmapped Items/);
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('A13: no Unmapped Items sheet appears when everything maps', async () => {
  const mgr = makeUser('m13', { role: 'manager' });
  const usr = makeUser('u13', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY,
    lines: [{ gsm: '80', colour: 'BW', size: 'A4', qty: 100, amount: 11500 }] });
  try {
    const { workbook, unmapped } = await generateMonthlyWorkbook(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(unmapped.length, 0);
    assert.equal(workbook.getWorksheet('Unmapped Items'), undefined,
      'no warning sheet when there is nothing to warn about');
    assert.ok(!workbook.getWorksheet(SHEET).getCell('K6').value, 'and no header warning');
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('A14: the preview flags unmapped items and the API reports the reason', async () => {
  const coord = makeUser('c14', { coordinator: true });
  const mgr = makeUser('m14', { role: 'manager' });
  const usr = makeUser('u14', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, lines: [
    { gsm: '80', colour: 'BW', size: 'A4', qty: 500, amount: 57500 }, UNMAPPABLE,
  ] });
  try {
    const res = await request(app).get('/api/annexures/monthly-report')
      .query({ month: '2026-07', member: usr.id })
      .set('Authorization', `Bearer ${tokenFor(coord)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_unmapped, true);
    assert.equal(res.body.unmapped_rows.length, 1);
    assert.equal(res.body.unmapped_rows[0].reason, 'RATE NOT CONFIGURED');
    assert.equal(res.body.unmapped_rows[0].paper_size, '12X18');

    // The audit row records the exclusion, so a total that looks short is explainable.
    const details = auditRowsFor(coord.id).find((r) => r.action === ACTIONS.PREVIEWED).details;
    assert.match(details, /Unmapped \(rate not configured, EXCLUDED from total\)/);
    assert.match(details, /12X18/);
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

test('A15: the export announces the exclusion in a response header', async () => {
  const coord = makeUser('c15', { coordinator: true });
  const mgr = makeUser('m15', { role: 'manager' });
  const usr = makeUser('u15', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, lines: [
    { gsm: '80', colour: 'BW', size: 'A4', qty: 500, amount: 57500 }, UNMAPPABLE,
  ] });
  try {
    const res = await request(app).get('/api/annexures/monthly-report/export')
      .query({ month: '2026-07', member: usr.id })
      .set('Authorization', `Bearer ${tokenFor(coord)}`)
      .buffer(true).parse(binaryParser);
    assert.equal(res.status, 200);
    assert.match(res.headers['x-unmapped-paper-rows'], /130 GSM/);
    assert.match(res.headers['x-unmapped-paper-rows'], /12X18/);
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

// ── 4. Acceptance: July and August 2026 ─────────────────────────────────────────

test('ACCEPTANCE July/August 2026: isolation, hierarchy, quantities and reconciliation', async () => {
  const coord = makeUser('acc-coord', { coordinator: true });
  const gautam = makeUser('acc-gautam', { role: 'manager' });
  const other = makeUser('acc-other', { role: 'manager' });
  const rahul = makeUser('acc-rahul', { managerId: gautam.id });
  const priya = makeUser('acc-priya', { managerId: gautam.id });
  const outsider = makeUser('acc-outsider', { managerId: other.id });

  const july = [
    makeJob(rahul, gautam, { approvedAt: '2026-07-03 09:00:00', project: 'Metro Line 3',
      lines: [{ gsm: '80', colour: 'BW', size: 'A4', qty: 1200, amount: 138000 }],
      printing: 138000, binding: 15000, finishing: 0, pages: 30 }),
    makeJob(rahul, gautam, { approvedAt: '2026-07-14 11:20:00', project: 'Metro Line 3',
      lines: [{ gsm: '80', colour: 'BW', size: 'A4', qty: 800, amount: 92000 }],
      printing: 92000, binding: 0, finishing: 4000, pages: 20 }),
    makeJob(priya, gautam, { approvedAt: '2026-07-09 08:30:00', project: 'Harbour Bridge',
      lines: [{ gsm: '100', colour: 'COLOUR', size: 'A3', qty: 150, amount: 86250 }],
      printing: 86250, binding: 0, finishing: 0, pages: 15 }),
    // 23:00 IST on 31 July — the boundary case.
    makeJob(priya, gautam, { approvedAt: '2026-07-31 17:30:00', project: 'Harbour Bridge',
      lines: [{ gsm: '80', colour: 'BW', size: 'A5', qty: 180, amount: 10260 },
              { gsm: '80', colour: 'BW', size: 'B5', qty: 120, amount: 6840 }],
      printing: 17100, binding: 0, finishing: 0, pages: 10 }),
  ];
  const august = [
    makeJob(rahul, gautam, { approvedAt: '2026-08-04 07:00:00', project: 'Metro Line 3',
      lines: [{ gsm: '80', colour: 'BW', size: 'A4', qty: 500, amount: 57500 }],
      printing: 57500, binding: 0, finishing: 0, pages: 12 }),
    makeJob(priya, gautam, { approvedAt: '2026-08-18 10:00:00', project: 'Harbour Bridge',
      lines: [{ gsm: '300', colour: 'COLOUR', size: 'A4', qty: 60, amount: 41400 }],
      printing: 41400, binding: 8000, finishing: 0, pages: 8 }),
  ];
  // Must never appear in either month.
  const excluded = [
    makeJob(rahul, gautam, { approvedAt: JULY, status: 'draft' }),
    makeJob(rahul, gautam, { approvedAt: JULY, status: 'rejected' }),
    makeJob(rahul, gautam, { approvedAt: JULY, status: 'superseded' }),
    makeJob(rahul, gautam, { approvedAt: JULY, jobStatus: 'cancelled' }),
    makeJob(rahul, gautam, { approvedAt: null }),
    makeJob(outsider, other, { approvedAt: JULY }),   // another manager's team
  ];

  try {
    const j = reportFor('2026-07', { filters: { manager: gautam.id } });
    const a = reportFor('2026-08', { filters: { manager: gautam.id } });

    // ── month isolation ──
    const numbers = (r) => r.managers.flatMap((m) => m.members.flatMap((x) => x.jobs.map((y) => y.job_number)));
    const jn = numbers(j);
    const an = numbers(a);
    assert.equal(jn.length, 4, 'July: four approved jobs');
    assert.equal(an.length, 2, 'August: two approved jobs');
    july.forEach((x) => assert.ok(jn.includes(x.jobNumber), `${x.jobNumber} in July`));
    august.forEach((x) => assert.ok(an.includes(x.jobNumber), `${x.jobNumber} in August`));
    assert.deepEqual(jn.filter((x) => an.includes(x)), [], 'no job in both months');

    // ── exclusions ──
    excluded.forEach((x) => {
      assert.ok(!jn.includes(x.jobNumber), `${x.jobNumber} must be excluded from July`);
      assert.ok(!an.includes(x.jobNumber), `${x.jobNumber} must be excluded from August`);
    });

    // ── manager → member → job hierarchy ──
    assert.equal(j.managers.length, 1, 'one manager');
    assert.equal(j.managers[0].manager_name, gautam.name);
    const members = j.managers[0].members.map((m) => m.requestor_name).sort();
    assert.deepEqual(members, [priya.name, rahul.name].sort(), 'both team members present');
    const rahulJobs = j.managers[0].members.find((m) => m.requestor_name === rahul.name).jobs;
    assert.equal(rahulJobs.length, 2, 'Rahul’s two July jobs sit under Rahul');

    // ── historical manager stamping is untouched ──
    for (const x of [...july, ...august]) {
      const stamped = db.prepare('SELECT manager_id_at_submit, manager_name_at_submit FROM print_jobs WHERE id = ?').get(x.jobId);
      assert.equal(stamped.manager_id_at_submit, gautam.id, 'the stamp survives reporting');
      assert.equal(stamped.manager_name_at_submit, gautam.name);
    }

    // ── totals reconcile: printing + binding + finishing == grand total ──
    for (const [label, r] of [['July', j], ['August', a]]) {
      const t = r.totals;
      assert.equal(t.printing_paise + t.binding_paise + t.finishing_paise
        + t.misc_paise + t.rework_paise, t.grand_total_paise,
        `${label}: the parts must sum to the grand total`);
      // And the rollups must sum to the same figure.
      const fromManagers = r.managers.reduce((n, m) => n + m.totals.grand_total_paise, 0);
      const fromMembers = r.managers.flatMap((m) => m.members)
        .reduce((n, m) => n + m.totals.grand_total_paise, 0);
      assert.equal(fromManagers, t.grand_total_paise, `${label}: manager rollup reconciles`);
      assert.equal(fromMembers, t.grand_total_paise, `${label}: member rollup reconciles`);
    }
    assert.equal(j.totals.grand_total_paise, 138000 + 15000 + 92000 + 4000 + 86250 + 17100);
    assert.equal(a.totals.grand_total_paise, 57500 + 41400 + 8000);
    assert.equal(j.totals.pages, 75, 'July pages');
    assert.equal(a.totals.pages, 20, 'August pages');

    // ── Excel matches the preview, cell by cell ──
    const jw = await generateMonthlyWorkbook(j);
    const aw = await generateMonthlyWorkbook(a);
    const jws = jw.workbook.getWorksheet(SHEET);
    const aws = aw.workbook.getWorksheet(SHEET);

    assert.equal(jws.getCell('E9').value, 2000, 'July: 1200 + 800 on 80/BW/A4');
    assert.equal(jws.getCell('E25').value, 150, 'July: 100/Colour/A3');
    assert.equal(jws.getCell('E8').value, 300, 'July: A5 + B5 on the combined row');
    assert.equal(aws.getCell('E9').value, 500, 'August: 80/BW/A4');
    assert.equal(aws.getCell('E35').value, 60, 'August: 300/Colour/A4');
    assert.ok(!aws.getCell('E25').value, 'August must not carry July’s colour work');
    assert.ok(!jws.getCell('E35').value, 'July must not carry August’s 300 gsm work');

    // Every preview quantity appears in the sheet and nothing extra.
    for (const [label, report, ws] of [['July', j, jws], ['August', a, aws]]) {
      const inSheet = [];
      for (let r = 8; r <= 48; r += 1) {
        const v = ws.getCell(r, 5).value;
        if (v) inSheet.push(Number(v));
      }
      const previewTotal = report.paper_rows.reduce((n, p) => n + Number(p.quantity || 0), 0);
      assert.equal(inSheet.reduce((x, y) => x + y, 0), previewTotal,
        `${label}: the sheet and the preview carry the same quantities`);
    }

    // Detailed Jobs lists exactly the month's jobs, and the summary reconciles.
    const listed = (wb) => {
      const out = [];
      wb.getWorksheet('Detailed Jobs').eachRow((row, i) => { if (i > 1) out.push(String(row.getCell(1).value)); });
      return out;
    };
    assert.deepEqual(listed(jw.workbook).sort(), july.map((x) => x.jobNumber).sort());
    assert.deepEqual(listed(aw.workbook).sort(), august.map((x) => x.jobNumber).sort());

    const grandOf = (wb) => {
      const ws = wb.getWorksheet('Manager Summary');
      return Number(ws.getRow(ws.rowCount).getCell(8).value);
    };
    assert.equal(grandOf(jw.workbook), j.totals.grand_total_paise / 100, 'July Excel total == preview');
    assert.equal(grandOf(aw.workbook), a.totals.grand_total_paise / 100, 'August Excel total == preview');
  } finally {
    cleanup([...july, ...august, ...excluded].map((x) => x.jobId),
      [rahul.id, priya.id, outsider.id, gautam.id, other.id, coord.id]);
  }
});

// ── 5. RBAC on the audited routes ───────────────────────────────────────────────

test('A16: the audit records the real user, not a spoofed filter', async () => {
  const mine = makeUser('a16a', { role: 'manager' });
  const theirs = makeUser('a16b', { role: 'manager' });
  const myMember = makeUser('a16c', { managerId: mine.id });
  const theirMember = makeUser('a16d', { managerId: theirs.id });
  const jobs = [makeJob(myMember, mine, { approvedAt: JULY }),
                makeJob(theirMember, theirs, { approvedAt: JULY })];
  try {
    const res = await request(app).get('/api/annexures/monthly-report/export')
      .query({ month: '2026-07', manager: theirs.id })
      .set('Authorization', `Bearer ${tokenFor(mine)}`)
      .buffer(true).parse(binaryParser);

    if (res.status === 200) {
      const row = auditRowsFor(mine.id).find((r) => r.action === ACTIONS.EXPORTED);
      assert.ok(row, 'the export was recorded against the signed-in manager');
      assert.equal(row.user_id, mine.id);
      assert.match(row.details, /Jobs: 1/, 'only their own team was disclosed');
      // Nothing may be recorded against the manager whose id was in the query.
      assert.equal(auditRowsFor(theirs.id).length, 0);
    } else {
      assert.ok([403, 404].includes(res.status), `unexpected ${res.status}`);
    }
  } finally {
    cleanup(jobs.map((x) => x.jobId), [myMember.id, theirMember.id, mine.id, theirs.id]);
  }
});
