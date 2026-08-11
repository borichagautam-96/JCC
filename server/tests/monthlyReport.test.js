// Monthly printing report — scope, month isolation and aggregation.
//
// The rule everything rests on: a job belongs to the IST month its annexure was
// APPROVED in. Not raised, not printed, not completed. Everything else here exists to
// stop something being counted twice or in the wrong month.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import db from '../database.js';
import annexuresRouter from '../routes/annexures.js';
import { JWT_SECRET } from '../middleware/auth.js';
import { buildMonthlyReport } from '../services/monthlyPrintingReport.js';

const app = express();
app.use(express.json());
app.use('/api', annexuresRouter);

const tokenFor = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
const uniq = () => `mr-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

const makeUser = (suffix, { role = 'user', managerId = null, coordinator = false } = {}) => {
  const ref = `${uniq()}-${suffix}`;
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, manager_id,
                        is_printer_coordinator, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', ?, ?, ?, 1, datetime('now'))`
  ).run(ref, `Test ${suffix}`, `${ref}@example.test`, role, managerId, coordinator ? 1 : 0);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role };
};

/**
 * A costed job. `approvedAt` is a naive-UTC string, exactly as the app stores it, so a
 * test can place an approval on either side of an IST month boundary precisely.
 */
const makeJob = (requestor, manager, {
  approvedAt, status = 'approved', jobStatus = 'completed',
  gsm = '80', colour = 'BW', size = 'A4', qty = 100,
  printing = 100000, binding = 20000, finishing = 5000, project = 'Alpha', pages = 10,
} = {}) => {
  const ref = uniq();
  const jobId = Number(db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by, completed_at,
                             manager_id_at_submit, manager_name_at_submit, manager_ps_at_submit,
                             project_name, department_name, debit_code, number_of_pages)
     VALUES (?, ?, ?, ?, datetime('now'), ?, ?, '999', ?, 'Engineering', '3559', ?)`
  ).run(`REQ-${ref}`, `JOB-${ref}`, jobStatus, requestor.id,
        manager?.id ?? null, manager?.name ?? null, project, pages).lastInsertRowid);

  // Created as a draft, lines added, THEN moved to its final status — the same order
  // the app uses. Inserting an approved annexure first would trip the immutability
  // triggers that stop cost lines being written to something already signed off.
  const annexureId = Number(db.prepare(
    `INSERT INTO cost_annexures (annexure_no, job_id, version, status, approved_at,
                                 printing_paise, binding_paise, finishing_paise,
                                 basic_paise, grand_total_paise, line_count)
     VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, 1)`
  ).run(`PCA-${ref}`, jobId, approvedAt ?? null,
        printing, binding, finishing, printing + binding + finishing,
        printing + binding + finishing).lastInsertRowid);

  db.prepare(
    `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
                                 rate_milli, amount_paise, rate_status,
                                 paper_size, paper_gsm, colour_mode, annexure_id)
     VALUES (?, 'PRINT', 'Printing', 'printing', ?, 'page', 1150, ?, 'priced', ?, ?, ?, ?)`
  ).run(jobId, qty, printing, size, gsm, colour, annexureId);

  if (status !== 'draft') {
    db.prepare('UPDATE cost_annexures SET status = ? WHERE id = ?').run(status, annexureId);
  }

  return { jobId, annexureId, jobNumber: `JOB-${ref}` };
};

const cleanup = (jobIds, userIds) => {
  jobIds.forEach((id) => {
    // Unlock first: the approved-annexure triggers refuse to let its lines be deleted.
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

// Mid-month instants, safely inside the IST window on both sides.
const JULY = '2026-07-15 06:00:00';
const AUGUST = '2026-08-15 06:00:00';

const reportFor = (monthKey, extra = {}) =>
  buildMonthlyReport({ monthKey, scope: { managerId: null }, ...extra });

const jobNumbersIn = (report) =>
  report.managers.flatMap((m) => m.members.flatMap((x) => x.jobs.map((j) => j.job_number)));

// ── A–D: month isolation ────────────────────────────────────────────────────────

test('A+B+C+D: July and August reports contain only their own approvals', () => {
  const mgr = makeUser('mgr', { role: 'manager' });
  const rahul = makeUser('rahul', { managerId: mgr.id });
  const julyJobs = Array.from({ length: 5 }, () => makeJob(rahul, mgr, { approvedAt: JULY }));
  const augJobs = Array.from({ length: 3 }, () => makeJob(rahul, mgr, { approvedAt: AUGUST }));

  const july = reportFor('2026-07', { filters: { member: rahul.id } });
  const august = reportFor('2026-08', { filters: { member: rahul.id } });

  assert.equal(july.counts.jobs, 5, 'A: all five July approvals included');
  assert.equal(august.counts.jobs, 3, 'B: all three August approvals included');

  const inJuly = jobNumbersIn(july);
  const inAug = jobNumbersIn(august);
  augJobs.forEach((j) => assert.equal(inJuly.includes(j.jobNumber), false, 'C: no August job in July'));
  julyJobs.forEach((j) => assert.equal(inAug.includes(j.jobNumber), false, 'D: no July job in August'));

  cleanup([...julyJobs, ...augJobs].map((j) => j.jobId), [mgr.id, rahul.id]);
});

// ── E–F: aggregation ────────────────────────────────────────────────────────────

test('E: identical paper + type + size across jobs collapses to one row', () => {
  const mgr = makeUser('aggmgr', { role: 'manager' });
  const user = makeUser('agguser', { managerId: mgr.id });
  const a = makeJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 500 });
  const b = makeJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 300 });

  const rows = reportFor('2026-07', { filters: { member: user.id } }).paper_rows;
  const bw = rows.filter((r) => r.paper_gsm === '80' && r.colour_mode === 'BW' && r.paper_size === 'A4');

  assert.equal(bw.length, 1, 'one row, not one per job');
  assert.equal(bw[0].quantity, 800, '500 + 300 aggregated');

  cleanup([a.jobId, b.jobId], [mgr.id, user.id]);
});

test('F: a different type or size stays a separate row', () => {
  const mgr = makeUser('sepmgr', { role: 'manager' });
  const user = makeUser('sepuser', { managerId: mgr.id });
  const bw = makeJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 500 });
  const clr = makeJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'COLOUR', size: 'A4', qty: 200 });
  const a3 = makeJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A3', qty: 50 });

  const rows = reportFor('2026-07', { filters: { member: user.id } }).paper_rows;
  const find = (c, s) => rows.find((r) => r.paper_gsm === '80' && r.colour_mode === c && r.paper_size === s);

  assert.equal(find('BW', 'A4').quantity, 500);
  assert.equal(find('COLOUR', 'A4').quantity, 200, 'colour is its own row');
  assert.equal(find('BW', 'A3').quantity, 50, 'size is its own row');

  cleanup([bw.jobId, clr.jobId, a3.jobId], [mgr.id, user.id]);
});

test('A5 and B5 fold onto the template single A5/B5 row', () => {
  // The rate sheet prices them together and has one row for both; the job records one
  // size. Without folding, the report produces rows the template cannot place.
  const mgr = makeUser('foldmgr', { role: 'manager' });
  const user = makeUser('folduser', { managerId: mgr.id });
  const a5 = makeJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A5', qty: 40 });
  const b5 = makeJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'B5', qty: 60 });

  const rows = reportFor('2026-07', { filters: { member: user.id } }).paper_rows;
  const folded = rows.filter((r) => r.paper_size === 'A5/B5');
  assert.equal(folded.length, 1);
  assert.equal(folded[0].quantity, 100);

  cleanup([a5.jobId, b5.jobId], [mgr.id, user.id]);
});

// ── G–I: what must never be counted ─────────────────────────────────────────────

test('G: a superseded version is not counted even with its own approval date', () => {
  const mgr = makeUser('supmgr', { role: 'manager' });
  const user = makeUser('supuser', { managerId: mgr.id });
  const live = makeJob(user, mgr, { approvedAt: JULY, printing: 100000 });
  const old = makeJob(user, mgr, { approvedAt: JULY, status: 'superseded', printing: 999999 });

  const report = reportFor('2026-07', { filters: { member: user.id } });
  assert.equal(report.counts.jobs, 1, 'only the live version');
  assert.equal(report.totals.printing_paise, 100000, 'the superseded amount is not added');

  cleanup([live.jobId, old.jobId], [mgr.id, user.id]);
});

test('H+I: rejected, draft and under_review annexures are not counted', () => {
  const mgr = makeUser('stmgr', { role: 'manager' });
  const user = makeUser('stuser', { managerId: mgr.id });
  const good = makeJob(user, mgr, { approvedAt: JULY });
  // A rejected annexure returns to draft, so 'draft' covers the rejected case too.
  const draft = makeJob(user, mgr, { approvedAt: JULY, status: 'draft' });
  const review = makeJob(user, mgr, { approvedAt: JULY, status: 'under_review' });

  const report = reportFor('2026-07', { filters: { member: user.id } });
  assert.equal(report.counts.jobs, 1);
  assert.deepEqual(jobNumbersIn(report), [good.jobNumber]);

  cleanup([good.jobId, draft.jobId, review.jobId], [mgr.id, user.id]);
});

test('a cancelled job is excluded even if its annexure was approved', () => {
  const mgr = makeUser('canmgr', { role: 'manager' });
  const user = makeUser('canuser', { managerId: mgr.id });
  const ok = makeJob(user, mgr, { approvedAt: JULY });
  const cancelled = makeJob(user, mgr, { approvedAt: JULY, jobStatus: 'cancelled' });

  const report = reportFor('2026-07', { filters: { member: user.id } });
  assert.equal(report.counts.jobs, 1);
  assert.deepEqual(jobNumbersIn(report), [ok.jobNumber]);

  cleanup([ok.jobId, cancelled.jobId], [mgr.id, user.id]);
});

test('an approved annexure with no approved_at is excluded rather than guessed at', () => {
  const mgr = makeUser('nullmgr', { role: 'manager' });
  const user = makeUser('nulluser', { managerId: mgr.id });
  const j = makeJob(user, mgr, { approvedAt: null });

  assert.equal(reportFor('2026-07', { filters: { member: user.id } }).counts.jobs, 0);
  assert.equal(reportFor('2026-08', { filters: { member: user.id } }).counts.jobs, 0);

  cleanup([j.jobId], [mgr.id, user.id]);
});

// ── J: historical manager ───────────────────────────────────────────────────────

test('J: a job stays under the manager stamped at submission after a reorg', () => {
  const oldMgr = makeUser('oldmgr', { role: 'manager' });
  const newMgr = makeUser('newmgr', { role: 'manager' });
  const user = makeUser('mover', { managerId: oldMgr.id });
  const j = makeJob(user, oldMgr, { approvedAt: JULY });

  db.prepare('UPDATE users SET manager_id = ? WHERE id = ?').run(newMgr.id, user.id);

  const report = reportFor('2026-07', { filters: { member: user.id } });
  const names = report.managers.map((m) => m.manager_name);
  assert.ok(names.includes(oldMgr.name), 'stays with the manager at submit');
  assert.equal(names.includes(newMgr.name), false, 'does not re-parent to the new manager');

  cleanup([j.jobId], [oldMgr.id, newMgr.id, user.id]);
});

// ── K–L: boundaries ─────────────────────────────────────────────────────────────

test('K: an approval at the exact IST month boundary lands in the new month only', () => {
  const mgr = makeUser('bmgr', { role: 'manager' });
  const user = makeUser('buser', { managerId: mgr.id });
  // 2026-07-31 18:30 UTC == 1 Aug 00:00 IST — the first instant of August.
  const boundary = makeJob(user, mgr, { approvedAt: '2026-07-31 18:30:00' });
  // One minute earlier is still 31 July IST.
  const justBefore = makeJob(user, mgr, { approvedAt: '2026-07-31 18:29:00' });

  const july = jobNumbersIn(reportFor('2026-07', { filters: { member: user.id } }));
  const august = jobNumbersIn(reportFor('2026-08', { filters: { member: user.id } }));

  assert.equal(august.includes(boundary.jobNumber), true, 'midnight IST belongs to August');
  assert.equal(july.includes(boundary.jobNumber), false, 'and not to July');
  assert.equal(july.includes(justBefore.jobNumber), true, '23:59 IST stays in July');
  assert.equal(august.includes(justBefore.jobNumber), false);

  cleanup([boundary.jobId, justBefore.jobId], [mgr.id, user.id]);
});

test('L: July 2025 and July 2026 are independent', () => {
  const mgr = makeUser('ymgr', { role: 'manager' });
  const user = makeUser('yuser', { managerId: mgr.id });
  const y2025 = makeJob(user, mgr, { approvedAt: '2025-07-15 06:00:00' });
  const y2026 = makeJob(user, mgr, { approvedAt: '2026-07-15 06:00:00' });

  const a = jobNumbersIn(reportFor('2025-07', { filters: { member: user.id } }));
  const b = jobNumbersIn(reportFor('2026-07', { filters: { member: user.id } }));

  assert.deepEqual(a, [y2025.jobNumber]);
  assert.deepEqual(b, [y2026.jobNumber]);

  cleanup([y2025.jobId, y2026.jobId], [mgr.id, user.id]);
});

// ── Totals, traceability and the API ────────────────────────────────────────────

test('member and manager totals equal the sum of their jobs', () => {
  const mgr = makeUser('totmgr', { role: 'manager' });
  const rahul = makeUser('totrahul', { managerId: mgr.id });
  const priya = makeUser('totpriya', { managerId: mgr.id });
  const jobs = [
    makeJob(rahul, mgr, { approvedAt: JULY, printing: 100000, binding: 17500, finishing: 0 }),
    makeJob(rahul, mgr, { approvedAt: JULY, printing: 150000, binding: 0, finishing: 4200 }),
    makeJob(priya, mgr, { approvedAt: JULY, printing: 300000, binding: 52500, finishing: 20000 }),
  ];

  const report = reportFor('2026-07', { filters: { manager: mgr.id } });
  const m = report.managers.find((x) => x.manager_id === mgr.id);
  const rahulRow = m.members.find((x) => x.requestor_id === rahul.id);

  // §18: every figure traces back to jobs on the detailed sheet.
  const rahulSum = rahulRow.jobs.reduce((n, j) => n + j.grand_total_paise, 0);
  assert.equal(rahulRow.totals.grand_total_paise, rahulSum);
  const mgrSum = m.members.reduce((n, x) => n + x.totals.grand_total_paise, 0);
  assert.equal(m.totals.grand_total_paise, mgrSum);
  assert.equal(report.totals.grand_total_paise, 100000 + 17500 + 150000 + 4200 + 300000 + 52500 + 20000);
  assert.equal(m.totals.jobs, 3);

  cleanup(jobs.map((j) => j.jobId), [mgr.id, rahul.id, priya.id]);
});

test('the header can name one project, or reports that there are several', () => {
  const mgr = makeUser('projmgr', { role: 'manager' });
  const user = makeUser('projuser', { managerId: mgr.id });
  const one = makeJob(user, mgr, { approvedAt: JULY, project: 'Alpha' });
  assert.deepEqual(reportFor('2026-07', { filters: { member: user.id } }).projects, ['Alpha']);

  const two = makeJob(user, mgr, { approvedAt: JULY, project: 'Beta' });
  const r = reportFor('2026-07', { filters: { member: user.id } });
  assert.equal(r.projects.length, 2, 'the Excel header must say "multiple" for this month');

  cleanup([one.jobId, two.jobId], [mgr.id, user.id]);
});

test('GET /annexures/monthly-report returns the month for a coordinator', async () => {
  const coordinator = makeUser('apicoord', { coordinator: true });
  const mgr = makeUser('apimgr', { role: 'manager' });
  const user = makeUser('apiuser', { managerId: mgr.id });
  const j = makeJob(user, mgr, { approvedAt: JULY });

  const res = await request(app).get('/api/annexures/monthly-report?month=2026-07')
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.month.key, '2026-07');
  assert.equal(res.body.month.start_utc, '2026-06-30 18:30:00');
  assert.ok(res.body.counts.jobs >= 1);
  assert.ok(Array.isArray(res.body.paper_rows));

  cleanup([j.jobId], [coordinator.id, mgr.id, user.id]);
});

test('a manager sees only their own team, and cannot widen it by query string', async () => {
  const mine = makeUser('scopemine', { role: 'manager' });
  const theirs = makeUser('scopetheirs', { role: 'manager' });
  const myMember = makeUser('scopemem', { managerId: mine.id });
  const theirMember = makeUser('scopeother', { managerId: theirs.id });
  const a = makeJob(myMember, mine, { approvedAt: JULY });
  const b = makeJob(theirMember, theirs, { approvedAt: JULY });

  const res = await request(app)
    .get(`/api/annexures/monthly-report?month=2026-07&manager=${theirs.id}`)
    .set('Authorization', `Bearer ${tokenFor(mine)}`);

  assert.equal(res.status, 200);
  const names = jobNumbersIn(res.body);
  assert.equal(names.includes(a.jobNumber), true);
  assert.equal(names.includes(b.jobNumber), false, 'scope is a permission, not a filter');

  cleanup([a.jobId, b.jobId], [mine.id, theirs.id, myMember.id, theirMember.id]);
});

test('a malformed month is refused rather than silently defaulted', async () => {
  const coordinator = makeUser('badmonth', { coordinator: true });
  const res = await request(app).get('/api/annexures/monthly-report?month=2026-13')
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`);
  assert.equal(res.status, 400);
  cleanup([], [coordinator.id]);
});

test('a month with nothing approved returns an empty report, not an error', () => {
  const r = reportFor('2019-01');
  assert.equal(r.counts.jobs, 0);
  assert.deepEqual(r.managers, []);
  assert.deepEqual(r.paper_rows, []);
  assert.equal(r.totals.grand_total_paise, 0);
});
