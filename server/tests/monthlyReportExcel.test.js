// Monthly printing report → Excel.
//
// The template is the contract. These tests exist mainly to prove we EDIT it rather
// than rebuild it: the formulas that compute every Amount, the merges, the fills and
// the rate column must survive a generation untouched. If a future change starts
// writing amounts directly, or rebuilds the sheet, the assertions here fail rather
// than the file quietly becoming a static snapshot that stops reconciling.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import db from '../database.js';
import annexuresRouter from '../routes/annexures.js';
import { JWT_SECRET } from '../middleware/auth.js';
import { buildMonthlyReport } from '../services/monthlyPrintingReport.js';
import {
  generateMonthlyWorkbook, workbookFilename, buildRowIndex, rowFor,
  TEMPLATE, SHEET, COL, RATE_FIRST_ROW, RATE_LAST_ROW,
} from '../services/monthlyPrintingExcel.js';

const app = express();
app.use(express.json());
app.use('/api', annexuresRouter);

const tokenFor = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
const uniq = () => `xl-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

const makeUser = (suffix, { role = 'user', managerId = null, coordinator = false } = {}) => {
  const ref = `${uniq()}-${suffix}`;
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, manager_id,
                        is_printer_coordinator, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', ?, ?, ?, 1, datetime('now'))`
  ).run(ref, `Test ${suffix}`, `${ref}@example.test`, role, managerId, coordinator ? 1 : 0);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role };
};

const makeJob = (requestor, manager, {
  approvedAt, status = 'approved', jobStatus = 'completed',
  gsm = '80', colour = 'BW', size = 'A4', qty = 100,
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

  // Draft → lines → final status: the app's own order. An annexure created already
  // approved would trip the immutability triggers when its lines are inserted.
  const annexureId = Number(db.prepare(
    `INSERT INTO cost_annexures (annexure_no, job_id, version, status, approved_at,
                                 printing_paise, binding_paise, finishing_paise,
                                 basic_paise, grand_total_paise, line_count)
     VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, 1)`
  ).run(`PCA-${ref}`, jobId, approvedAt ?? null, printing, binding, finishing,
        printing + binding + finishing, printing + binding + finishing).lastInsertRowid);

  db.prepare(
    `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
                                 rate_milli, amount_paise, rate_status,
                                 paper_size, paper_gsm, colour_mode, annexure_id)
     VALUES (?, 'PRINT', 'Printing', 'printing', ?, 'page', 1150, ?, 'priced', ?, ?, ?, ?)`
  ).run(jobId, qty, printing, size, gsm, colour, annexureId);

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

const reportFor = (monthKey, extra = {}) =>
  buildMonthlyReport({ monthKey, scope: { managerId: null }, ...extra });

/** supertest treats an unknown content-type as text and corrupts the zip; collect raw bytes. */
const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** Generate, serialise and read back — proving what a user's Excel would actually open. */
const roundTrip = async (report) => {
  const { workbook, unmapped } = await generateMonthlyWorkbook(report);
  const buffer = await workbook.xlsx.writeBuffer();
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.load(buffer);
  return { wb: reread, ws: reread.getWorksheet(SHEET), unmapped, buffer };
};

const loadTemplate = async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  return wb;
};

// ── 1. The template itself ──────────────────────────────────────────────────────

test('1: the template loads and exposes the annexure sheet', async () => {
  const wb = await loadTemplate();
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(names.includes(SHEET), `expected ${SHEET} among ${names.join(', ')}`);
});

test('2: the row index is derived from the template, not hardcoded', async () => {
  const wb = await loadTemplate();
  const { index, rows } = buildRowIndex(wb.getWorksheet(SHEET));
  assert.equal(rows.length, RATE_LAST_ROW - RATE_FIRST_ROW + 1, 'every rate row parsed');
  // Spot-check against the template's own layout.
  assert.equal(index.get('80|BW|A5/B5'), 8);
  assert.equal(index.get('80|BW|A4'), 9);
  assert.equal(index.get('80|BW|A3'), 10);
  assert.equal(index.get('100|COLOUR|A4'), 24);
  assert.equal(index.get('130|COLOUR|A3'), 38);
});

test('3: A4 and A3 are separate rows — never folded into a combined row', async () => {
  const wb = await loadTemplate();
  const { index } = buildRowIndex(wb.getWorksheet(SHEET));
  assert.notEqual(index.get('80|BW|A4'), index.get('80|BW|A3'),
    'A4 and A3 must keep their own rows; folding them loses both quantities');
  assert.ok(!index.has('80|BW|A4/A3'), 'there is no A4/A3 row on this sheet');
  assert.ok(index.has('80|BW|A5/B5'), 'A5/B5 is the one genuinely combined row');
});

test('4: the paper/colour/size index covers plain stock only', async () => {
  const wb = await loadTemplate();
  const { index } = buildRowIndex(wb.getWorksheet(SHEET));
  assert.equal(index.get('80|BW|A4'), 9, 'plain 80 GSM row');
  // Speciality rows share a GSM and size with a plain row and are indistinguishable in
  // the paper columns, so they are deliberately absent from this index — they are found
  // by service label instead (see test 31). Indexing them here would make the plain
  // lookup ambiguous and put quantities on whichever row happened to be found first.
  const speciality = [28, 29, 30, 31, 39, 40, 41, 42, 43, 44, 45, 46, 47];
  const mapped = new Set(index.values());
  speciality.forEach((r) => assert.ok(!mapped.has(r),
    `row ${r} must not be reachable from the paper columns alone`));
});

// ── 2. Formula preservation — the core guarantee ────────────────────────────────

test('5: Amount formulas survive generation untouched', async () => {
  const mgr = makeUser('m5', { role: 'manager' });
  const usr = makeUser('u5', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 500 });
  try {
    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(ws.getCell('F9').formula, '$D9*E9', 'F keeps its own formula');
    assert.equal(ws.getCell('H9').formula, '$D9*G9');
    assert.equal(ws.getCell('J9').formula, '$D9*I9');
    assert.equal(ws.getCell('K9').formula, 'SUM(E9,G9,I9)');
    assert.equal(ws.getCell('L9').formula, '$D9*K9');
    // And at the far end of the block, not just the row we wrote to.
    assert.equal(ws.getCell('F48').formula, '$D48*E48');
    assert.equal(ws.getCell('L48').formula, '$D48*K48');
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('6: no calculated amount is ever written into F, H, J or L', async () => {
  const mgr = makeUser('m6', { role: 'manager' });
  const usr = makeUser('u6', { managerId: mgr.id });
  const jobs = [
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 300 }),
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '100', colour: 'COLOUR', size: 'A3', qty: 120 }),
  ];
  try {
    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    for (let r = RATE_FIRST_ROW; r <= RATE_LAST_ROW; r += 1) {
      for (const c of ['F', 'H', 'J', 'L']) {
        const cell = ws.getCell(`${c}${r}`);
        if (cell.value == null) continue;
        assert.ok(cell.formula,
          `${c}${r} holds a static value — the amount must stay a formula`);
      }
    }
  } finally { cleanup(jobs.map((j) => j.jobId), [usr.id, mgr.id]); }
});

test('7: rate cells in column D are never modified', async () => {
  const mgr = makeUser('m7', { role: 'manager' });
  const usr = makeUser('u7', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A5', qty: 900 });
  try {
    const before = await loadTemplate();
    const src = before.getWorksheet(SHEET);
    const rates = [];
    for (let r = RATE_FIRST_ROW; r <= RATE_LAST_ROW; r += 1) rates.push(src.getCell(r, COL.RATE).value);

    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    for (let r = RATE_FIRST_ROW; r <= RATE_LAST_ROW; r += 1) {
      assert.deepEqual(ws.getCell(r, COL.RATE).value, rates[r - RATE_FIRST_ROW],
        `rate D${r} changed — the workbook must never become a second rate master`);
    }
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('8: merges, fills, borders and column widths are preserved', async () => {
  const mgr = makeUser('m8', { role: 'manager' });
  const usr = makeUser('u8', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    const before = (await loadTemplate()).getWorksheet(SHEET);
    const mergeCount = Object.keys(before.model?.merges ?? {}).length || before.model.merges?.length || 0;
    const widthA = before.getColumn(1).width;
    const fillA8 = JSON.stringify(before.getCell('A8').fill);

    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    const after = Object.keys(ws.model?.merges ?? {}).length || ws.model.merges?.length || 0;
    assert.equal(after, mergeCount, 'merged ranges must survive');
    assert.equal(ws.getColumn(1).width, widthA, 'column widths must survive');
    assert.equal(JSON.stringify(ws.getCell('A8').fill), fillA8, 'cell fills must survive');
    assert.ok(ws.getCell('A8').border, 'borders must survive');
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('9: the saved file tells Excel to recalculate on open', async () => {
  const mgr = makeUser('m9', { role: 'manager' });
  const usr = makeUser('u9', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    const { workbook } = await generateMonthlyWorkbook(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(workbook.calcProperties.fullCalcOnLoad, true);

    // Asserted against the bytes, not the object: exceljs does not read calcPr back,
    // so a round-trip through its own reader would report undefined even when the flag
    // is present. What matters is what Excel opens — without it every Amount shows the
    // template's cached zero until someone edits a cell.
    const buffer = await workbook.xlsx.writeBuffer();
    const zip = await JSZip.loadAsync(buffer);
    const workbookXml = await zip.file('xl/workbook.xml').async('string');
    assert.match(workbookXml, /<calcPr[^>]*fullCalcOnLoad="1"/,
      'fullCalcOnLoad must be present in the saved workbook.xml');
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

// ── 3. Quantities ───────────────────────────────────────────────────────────────

test('10: the monthly quantity lands in column E on the matching row', async () => {
  const mgr = makeUser('m10', { role: 'manager' });
  const usr = makeUser('u10', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 640 });
  try {
    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(ws.getCell('E9').value, 640, '80/BW/A4 belongs on row 9');
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('11: only the first Qty block is used — G and I stay empty', async () => {
  const mgr = makeUser('m11', { role: 'manager' });
  const usr = makeUser('u11', { managerId: mgr.id });
  const jobs = [
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 100 }),
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'COLOUR', size: 'A3', qty: 55 }),
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '100', colour: 'BW', size: 'A4', qty: 20 }),
  ];
  try {
    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    for (let r = RATE_FIRST_ROW; r <= RATE_LAST_ROW; r += 1) {
      for (const c of ['G', 'I']) {
        const v = ws.getCell(`${c}${r}`).value;
        assert.ok(v == null || v === '' || v === 0,
          `${c}${r} was populated — the second and third Qty blocks are not ours to fill`);
      }
    }
  } finally { cleanup(jobs.map((j) => j.jobId), [usr.id, mgr.id]); }
});

test('12: many jobs on the same paper accumulate into one cell', async () => {
  const mgr = makeUser('m12', { role: 'manager' });
  const usr = makeUser('u12', { managerId: mgr.id });
  const jobs = [200, 350, 75].map((qty) =>
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty }));
  try {
    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(ws.getCell('E9').value, 625, 'quantities add, they do not overwrite');
  } finally { cleanup(jobs.map((j) => j.jobId), [usr.id, mgr.id]); }
});

test('13: A5 and B5 fold onto the single combined row', async () => {
  const mgr = makeUser('m13', { role: 'manager' });
  const usr = makeUser('u13', { managerId: mgr.id });
  const jobs = [
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A5', qty: 40 }),
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'B5', qty: 60 }),
  ];
  try {
    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(ws.getCell('E8').value, 100, 'A5 + B5 share row 8');
    assert.ok(ws.getCell('E9').value == null, 'and do not leak onto A4');
  } finally { cleanup(jobs.map((j) => j.jobId), [usr.id, mgr.id]); }
});

test('14: each paper/colour/size reaches its own distinct row', async () => {
  const mgr = makeUser('m14', { role: 'manager' });
  const usr = makeUser('u14', { managerId: mgr.id });
  const cases = [
    { gsm: '80', colour: 'BW', size: 'A4', qty: 11, cell: 'E9' },
    { gsm: '80', colour: 'BW', size: 'A3', qty: 22, cell: 'E10' },
    { gsm: '80', colour: 'COLOUR', size: 'A4', qty: 33, cell: 'E14' },
    { gsm: '100', colour: 'BW', size: 'A4', qty: 44, cell: 'E19' },
    { gsm: '100', colour: 'COLOUR', size: 'A3', qty: 55, cell: 'E25' },
    { gsm: '300', colour: 'COLOUR', size: 'A4', qty: 66, cell: 'E35' },
  ];
  const jobs = cases.map((c) => makeJob(usr, mgr, { approvedAt: JULY, ...c }));
  try {
    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    cases.forEach((c) => assert.equal(ws.getCell(c.cell).value, c.qty,
      `${c.gsm}/${c.colour}/${c.size} → ${c.cell}`));
  } finally { cleanup(jobs.map((j) => j.jobId), [usr.id, mgr.id]); }
});

test('15: a paper with no template row is reported, not silently dropped', async () => {
  const mgr = makeUser('m15', { role: 'manager' });
  const usr = makeUser('u15', { managerId: mgr.id });
  // 350 GSM exists in the rate master but has no row on this sheet.
  const j = makeJob(usr, mgr, { approvedAt: JULY, gsm: '350', colour: 'COLOUR', size: 'A4', qty: 70 });
  try {
    const { unmapped } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(unmapped.length, 1, 'the unmappable row is surfaced');
    assert.equal(unmapped[0].paper_gsm, '350');
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('16: quantities equal the preview’s — one aggregation, not two', async () => {
  const mgr = makeUser('m16', { role: 'manager' });
  const usr = makeUser('u16', { managerId: mgr.id });
  const jobs = [
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 210 }),
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '100', colour: 'COLOUR', size: 'A3', qty: 95 }),
    makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 15 }),
  ];
  try {
    const report = reportFor('2026-07', { filters: { member: usr.id } });
    const { ws } = await roundTrip(report);
    // Every figure on screen must be findable in the sheet, cell for cell.
    const wbTotal = [];
    for (let r = RATE_FIRST_ROW; r <= RATE_LAST_ROW; r += 1) {
      const v = ws.getCell(r, COL.QTY).value;
      if (v) wbTotal.push(Number(v));
    }
    const previewTotal = report.paper_rows.reduce((n, p) => n + Number(p.quantity || 0), 0);
    assert.equal(wbTotal.reduce((a, b) => a + b, 0), previewTotal,
      'the sheet and the preview must be the same aggregation');
  } finally { cleanup(jobs.map((j) => j.jobId), [usr.id, mgr.id]); }
});

// ── 3b. Speciality papers, told apart by service and not by the paper columns ───
//
// These caught a real misfiling: "Plain paper" A3/100 GSM and ordinary printing on
// A3/100 GSM are identical in the paper columns, and both were landing on the plain
// 100 GSM row — one quantity on a rate row belonging to neither.

test('31: speciality services reach their own rows, not the plain-stock row', async () => {
  const wb = await loadTemplate();
  const ws = wb.getWorksheet(SHEET);
  const { index, rows } = buildRowIndex(ws);
  const at = (label, gsm, colour, size) =>
    rowFor(index, rows, { label, paper_gsm: gsm, colour_mode: colour, paper_size: size });

  assert.equal(at('Printing', '100', 'BW', 'A3'), 20, 'plain 100 GSM B&W A3');
  assert.equal(at('Printing — colour machine', '100', 'BW', 'A3'), 29, 'the colour-machine row');
  assert.equal(at('Plain paper', '100', null, 'A3'), 42, 'PLAIN PAPER / 100 GSM');
  assert.equal(at('Plain paper', '80', null, 'A4'), 43, 'PLAN PAPER / 80 GSM');
  assert.equal(at('Scanning', null, null, 'A3'), 46);
  assert.equal(at('Pouch lamination', null, null, 'A4'), 39);
  assert.equal(at('Pouch flap', null, null, 'A4'), 40);

  // The three must be distinct — that is the whole point.
  const distinct = new Set([at('Printing', '100', 'BW', 'A3'),
    at('Printing — colour machine', '100', 'BW', 'A3'), at('Plain paper', '100', null, 'A3')]);
  assert.equal(distinct.size, 3, 'three services on A3/100 GSM must occupy three rows');
});

test('32: a line with no colour recorded is never assumed to be B&W', async () => {
  const wb = await loadTemplate();
  const { index, rows } = buildRowIndex(wb.getWorksheet(SHEET));
  // B&W and Colour are priced differently, so a guess silently misprices the month.
  assert.equal(rowFor(index, rows,
    { label: 'Printing', paper_gsm: '80', colour_mode: null, paper_size: 'A4' }), null);
  assert.equal(rowFor(index, rows,
    { label: 'Printing', paper_gsm: '80', colour_mode: 'BW', paper_size: 'A4' }), 9);
});

test('33: two services on the same paper stay separate through aggregation', async () => {
  const mgr = makeUser('m33', { role: 'manager' });
  const usr = makeUser('u33', { managerId: mgr.id });
  const ref = uniq();
  const jobId = Number(db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by, completed_at,
                             manager_id_at_submit, manager_name_at_submit, manager_ps_at_submit,
                             project_name, department_name, debit_code, number_of_pages)
     VALUES (?, ?, 'completed', ?, datetime('now'), ?, ?, '999', 'P', 'Eng', '3559', 10)`
  ).run(`REQ-${ref}`, `JOB-${ref}`, usr.id, mgr.id, mgr.name).lastInsertRowid);
  const annexureId = Number(db.prepare(
    `INSERT INTO cost_annexures (annexure_no, job_id, version, status, approved_at,
                                 printing_paise, binding_paise, finishing_paise,
                                 basic_paise, grand_total_paise, line_count)
     VALUES (?, ?, 1, 'draft', ?, 5000, 0, 0, 5000, 5000, 2)`
  ).run(`PCA-${ref}`, jobId, JULY).lastInsertRowid);
  const line = db.prepare(
    `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
                                 rate_milli, amount_paise, rate_status,
                                 paper_size, paper_gsm, colour_mode, annexure_id)
     VALUES (?, ?, ?, 'printing', ?, 'page', 1000, 2500, 'priced', 'A3', '100', ?, ?)`
  );
  line.run(jobId, 'PRINT', 'Printing', 70, 'BW', annexureId);
  line.run(jobId, 'PLAIN', 'Plain paper', 30, null, annexureId);
  db.prepare("UPDATE cost_annexures SET status='approved' WHERE id=?").run(annexureId);

  try {
    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(ws.getCell('E20').value, 70, 'ordinary printing on the plain 100 GSM row');
    assert.equal(ws.getCell('E42').value, 30, 'plain paper on its own row');
  } finally { cleanup([jobId], [usr.id, mgr.id]); }
});

// ── 4. Extra sheets ─────────────────────────────────────────────────────────────

test('17: the template’s original sheets are all still present', async () => {
  const mgr = makeUser('m17', { role: 'manager' });
  const usr = makeUser('u17', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    const { wb } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    ['PRINTING', 'BINDING', 'PRINTING_ANNEXURE', 'BINDING_ANNEXURE']
      .forEach((n) => assert.ok(wb.getWorksheet(n), `${n} must survive`));
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('18: Detailed Jobs lists every job with its annexure and costs', async () => {
  const mgr = makeUser('m18', { role: 'manager' });
  const usr = makeUser('u18', { managerId: mgr.id });
  const jobs = [
    makeJob(usr, mgr, { approvedAt: JULY, printing: 250000, binding: 30000, finishing: 10000 }),
    makeJob(usr, mgr, { approvedAt: JULY, printing: 100000, binding: 0, finishing: 0 }),
  ];
  try {
    const { wb } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    const ws = wb.getWorksheet('Detailed Jobs');
    assert.ok(ws, 'the sheet exists');
    assert.equal(ws.rowCount, 3, 'a header plus one row per job');
    const numbers = [2, 3].map((r) => ws.getCell(r, 1).value);
    jobs.forEach((j) => assert.ok(numbers.includes(j.jobNumber), `${j.jobNumber} listed`));
    // Money is written in rupees, not paise.
    const totals = [2, 3].map((r) => Number(ws.getCell(r, 27).value));
    assert.ok(totals.includes(2900), '2,90,000 paise → 2900.00');
  } finally { cleanup(jobs.map((j) => j.jobId), [usr.id, mgr.id]); }
});

test('19: Manager Summary rolls up per member, per manager and overall', async () => {
  const mgr = makeUser('m19', { role: 'manager' });
  const a = makeUser('a19', { managerId: mgr.id });
  const b = makeUser('b19', { managerId: mgr.id });
  const jobs = [
    makeJob(a, mgr, { approvedAt: JULY, printing: 100000, binding: 0, finishing: 0 }),
    makeJob(b, mgr, { approvedAt: JULY, printing: 300000, binding: 0, finishing: 0 }),
  ];
  try {
    const report = reportFor('2026-07', { filters: { manager: mgr.id } });
    const { wb } = await roundTrip(report);
    const ws = wb.getWorksheet('Manager Summary');
    const last = ws.getRow(ws.rowCount);
    assert.match(String(last.getCell(1).value), /grand total/i);
    assert.equal(Number(last.getCell(8).value),
      report.totals.grand_total_paise / 100, 'the grand total matches the report');
  } finally { cleanup(jobs.map((j) => j.jobId), [a.id, b.id, mgr.id]); }
});

test('20: Cost Breakdown carries one row per job', async () => {
  const mgr = makeUser('m20', { role: 'manager' });
  const usr = makeUser('u20', { managerId: mgr.id });
  const jobs = [1, 2, 3].map(() => makeJob(usr, mgr, { approvedAt: JULY }));
  try {
    const { wb } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(wb.getWorksheet('Cost Breakdown').rowCount, 4, 'header plus three jobs');
  } finally { cleanup(jobs.map((j) => j.jobId), [usr.id, mgr.id]); }
});

// ── 5. Header block ─────────────────────────────────────────────────────────────

test('21: one project names itself; several defer to Detailed Jobs', async () => {
  const mgr = makeUser('m21', { role: 'manager' });
  const usr = makeUser('u21', { managerId: mgr.id });
  const one = makeJob(usr, mgr, { approvedAt: JULY, project: 'Solaris' });
  try {
    const single = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(single.ws.getCell('E2').value, 'Solaris');

    const two = makeJob(usr, mgr, { approvedAt: JULY, project: 'Vega' });
    try {
      const many = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
      assert.match(String(many.ws.getCell('E2').value), /Multiple Projects/i);
    } finally { cleanup([two.jobId], []); }
  } finally { cleanup([one.jobId], [usr.id, mgr.id]); }
});

test('22: START DATE and CLOSE DATE hold the window as dates, not as text', async () => {
  const mgr = makeUser('m22', { role: 'manager' });
  const usr = makeUser('u22', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    const { ws } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));

    // A date field must carry a date. It previously held "July 2026 (report month)"
    // and a manager's name, which is what a reader of those two rows was shown.
    assert.equal(ws.getCell('E5').value, '01-Jul-2026', 'START DATE: first IST day of July');
    assert.equal(ws.getCell('E6').value, '31-Jul-2026', 'CLOSE DATE: last IST day, not 1 August');
    assert.ok(!/manager/i.test(String(ws.getCell('E6').value)), 'no name in a date field');
    assert.ok(!/report month/i.test(String(ws.getCell('E5').value)));

    // The month is still named, in the free header cell.
    assert.match(String(ws.getCell('K5').value), /July 2026/i);
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('22b: the close date is the last day covered, across month lengths', async () => {
  const mgr = makeUser('m22b', { role: 'manager' });
  const usr = makeUser('u22b', { managerId: mgr.id });
  // February 2026 has 28 days; the half-open window ends at 1 March.
  const feb = makeJob(usr, mgr, { approvedAt: '2026-02-10 06:00:00' });
  const aug = makeJob(usr, mgr, { approvedAt: AUGUST });
  try {
    const f = await roundTrip(reportFor('2026-02', { filters: { member: usr.id } }));
    assert.equal(f.ws.getCell('E5').value, '01-Feb-2026');
    assert.equal(f.ws.getCell('E6').value, '28-Feb-2026', 'not 01-Mar');

    const a = await roundTrip(reportFor('2026-08', { filters: { member: usr.id } }));
    assert.equal(a.ws.getCell('E5').value, '01-Aug-2026');
    assert.equal(a.ws.getCell('E6').value, '31-Aug-2026');
  } finally { cleanup([feb.jobId, aug.jobId], [usr.id, mgr.id]); }
});

test('22c: D&T LEAD/INITIATOR reads "Manager / Initiator"', async () => {
  const mgr = makeUser('m22c', { role: 'manager' });
  const usr = makeUser('u22c', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY });
  try {
    const one = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(one.ws.getCell('E1').value, `${mgr.name} / ${usr.name}`,
      'the row names both, in the order its label promises');

    // A second team member under the same manager: the manager still names itself,
    // only the initiator side defers.
    const mate = makeUser('u22d', { managerId: mgr.id });
    const j2 = makeJob(mate, mgr, { approvedAt: JULY });
    try {
      const many = await roundTrip(reportFor('2026-07', { filters: { manager: mgr.id } }));
      assert.match(String(many.ws.getCell('E1').value),
        new RegExp(`^${mgr.name} / 2 Team Members`),
        'one manager is still named even when several members contributed');
    } finally { cleanup([j2.jobId], [mate.id]); }
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('23: the filename describes month and, when filtered, whose report it is', () => {
  const report = { month: { label: 'July 2026' } };
  assert.equal(workbookFilename(report), 'Printing_Annexure_July_2026.xlsx');
  assert.equal(workbookFilename(report, { memberName: 'Rahul Kumar' }),
    'Printing_Annexure_July_2026_Rahul_Kumar.xlsx');
  // Nothing that could break a Content-Disposition header or escape a directory.
  assert.equal(workbookFilename(report, { memberName: '../../etc/passwd"' }),
    'Printing_Annexure_July_2026_etc_passwd.xlsx');
});

// ── 6. The endpoint: authorization and isolation ────────────────────────────────

test('24: a manager cannot export another manager’s team by changing the filter', async () => {
  const mine = makeUser('m24a', { role: 'manager' });
  const theirs = makeUser('m24b', { role: 'manager' });
  const myMember = makeUser('u24a', { managerId: mine.id });
  const theirMember = makeUser('u24b', { managerId: theirs.id });
  const jobs = [
    makeJob(myMember, mine, { approvedAt: JULY }),
    makeJob(theirMember, theirs, { approvedAt: JULY }),
  ];
  try {
    // Signed in as `mine`, asking for `theirs`.
    const res = await request(app)
      .get('/api/annexures/monthly-report/export')
      .query({ month: '2026-07', manager: theirs.id })
      .set('Authorization', `Bearer ${tokenFor(mine)}`)
      .buffer(true).parse(binaryParser);

    if (res.status === 200) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body);
      const ws = wb.getWorksheet('Detailed Jobs');
      const rows = [];
      ws.eachRow((row, i) => { if (i > 1) rows.push(String(row.getCell(1).value)); });
      assert.ok(!rows.includes(jobs[1].jobNumber),
        'the other manager’s job must never appear, whatever the query says');
    } else {
      assert.ok([403, 404].includes(res.status), `unexpected ${res.status}`);
    }
  } finally { cleanup(jobs.map((j) => j.jobId), [myMember.id, theirMember.id, mine.id, theirs.id]); }
});

test('25: the endpoint streams a real xlsx with an attachment filename', async () => {
  const coord = makeUser('c25', { role: 'user', coordinator: true });
  const mgr = makeUser('m25', { role: 'manager' });
  const usr = makeUser('u25', { managerId: mgr.id });
  const j = makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 300 });
  try {
    const res = await request(app)
      .get('/api/annexures/monthly-report/export')
      .query({ month: '2026-07', member: usr.id })
      .set('Authorization', `Bearer ${tokenFor(coord)}`)
      .buffer(true).parse(binaryParser);

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /spreadsheetml\.sheet/);
    assert.match(res.headers['content-disposition'], /attachment; filename="Printing_Annexure_July_2026/);
    assert.equal(res.body.slice(0, 2).toString(), 'PK', 'a real xlsx is a zip');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    assert.equal(wb.getWorksheet(SHEET).getCell('E9').value, 300);
    assert.equal(wb.getWorksheet(SHEET).getCell('F9').formula, '$D9*E9');
  } finally { cleanup([j.jobId], [usr.id, mgr.id, coord.id]); }
});

test('26: an empty month is refused with a clear reason, not an empty workbook', async () => {
  const coord = makeUser('c26', { role: 'user', coordinator: true });
  try {
    const res = await request(app)
      .get('/api/annexures/monthly-report/export')
      .query({ month: '2019-02' })
      .set('Authorization', `Bearer ${tokenFor(coord)}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NO_APPROVED_JOBS');
  } finally { cleanup([], [coord.id]); }
});

test('27: an unauthenticated request cannot export', async () => {
  const res = await request(app)
    .get('/api/annexures/monthly-report/export').query({ month: '2026-07' });
  assert.ok([401, 403].includes(res.status), `expected a refusal, got ${res.status}`);
});

test('28: July and August export as separate, non-overlapping workbooks', async () => {
  const mgr = makeUser('m28', { role: 'manager' });
  const usr = makeUser('u28', { managerId: mgr.id });
  const july = makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 400 });
  const aug = makeJob(usr, mgr, { approvedAt: AUGUST, gsm: '80', colour: 'BW', size: 'A4', qty: 90 });
  try {
    const j = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    const a = await roundTrip(reportFor('2026-08', { filters: { member: usr.id } }));

    assert.equal(j.ws.getCell('E9').value, 400, 'July carries only July');
    assert.equal(a.ws.getCell('E9').value, 90, 'August carries only August');

    const listed = (wb) => {
      const out = [];
      wb.getWorksheet('Detailed Jobs').eachRow((row, i) => { if (i > 1) out.push(String(row.getCell(1).value)); });
      return out;
    };
    assert.deepEqual(listed(j.wb), [july.jobNumber]);
    assert.deepEqual(listed(a.wb), [aug.jobNumber]);
  } finally { cleanup([july.jobId, aug.jobId], [usr.id, mgr.id]); }
});

test('29: an approval late on 31 July IST stays in July, not August', async () => {
  const mgr = makeUser('m29', { role: 'manager' });
  const usr = makeUser('u29', { managerId: mgr.id });
  // 2026-07-31 23:00 IST = 2026-07-31 17:30 UTC — inside July's window.
  const j = makeJob(usr, mgr, { approvedAt: '2026-07-31 17:30:00', gsm: '80', colour: 'BW', size: 'A4', qty: 12 });
  try {
    const july = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    const august = await roundTrip(reportFor('2026-08', { filters: { member: usr.id } }));
    assert.equal(july.ws.getCell('E9').value, 12);
    assert.ok(august.ws.getCell('E9').value == null, 'and must not also appear in August');
  } finally { cleanup([j.jobId], [usr.id, mgr.id]); }
});

test('30: draft, rejected and cancelled work never reaches the workbook', async () => {
  const mgr = makeUser('m30', { role: 'manager' });
  const usr = makeUser('u30', { managerId: mgr.id });
  const included = makeJob(usr, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 50 });
  const excluded = [
    makeJob(usr, mgr, { approvedAt: JULY, status: 'draft', qty: 999 }),
    makeJob(usr, mgr, { approvedAt: JULY, status: 'rejected', qty: 999 }),
    makeJob(usr, mgr, { approvedAt: JULY, jobStatus: 'cancelled', qty: 999 }),
    makeJob(usr, mgr, { approvedAt: null, qty: 999 }),
  ];
  try {
    const { ws, wb } = await roundTrip(reportFor('2026-07', { filters: { member: usr.id } }));
    assert.equal(ws.getCell('E9').value, 50, 'only the approved job counts');
    assert.equal(wb.getWorksheet('Detailed Jobs').rowCount, 2, 'header plus the one job');
  } finally {
    cleanup([included.jobId, ...excluded.map((j) => j.jobId)], [usr.id, mgr.id]);
  }
});
