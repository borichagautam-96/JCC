// Which month an approved annexure is reported in.
//
// The rule: the reporting month is the IST month of the annexure's approval — not the
// job's creation, completion, or the raw UTC timestamp. Timestamps are stored naive
// UTC, and IST is UTC+5:30, so every approval between 18:30 and 23:59 UTC falls on the
// NEXT IST day. At a month end that moves it into the next month, which is exactly the
// case the spec calls out: completed 31 July, approved 1 August, reported in August.

import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../database.js';
import { monthWindowIST, parseMonthKey, istMonthKeyOf } from '../utils/reportingMonth.js';

test('an IST month window starts and ends 5h30 before midnight UTC', () => {
  const july = monthWindowIST(2026, 7);
  // Midnight 1 July IST is 18:30 on 30 June UTC.
  assert.equal(july.startUtc, '2026-06-30 18:30:00');
  assert.equal(july.endUtc, '2026-07-31 18:30:00');
});

test('the window is half-open, so a boundary approval lands in exactly one month', () => {
  const july = monthWindowIST(2026, 7);
  const august = monthWindowIST(2026, 8);
  // July ends where August begins; a `<` on one side and `>=` on the other means an
  // approval at that instant is counted once, not twice or never.
  assert.equal(july.endUtc, august.startUtc);
});

test('the spec case: completed 31 July, approved 1 August, reported in August', () => {
  // 1 Aug 2026, 01:00 IST — stored as 31 Jul 19:30 UTC.
  const approvedAt = '2026-07-31 19:30:00';
  assert.equal(istMonthKeyOf(approvedAt), '2026-08');

  const july = monthWindowIST(2026, 7);
  const august = monthWindowIST(2026, 8);
  assert.equal(approvedAt >= july.startUtc && approvedAt < july.endUtc, false, 'must not be in July');
  assert.equal(approvedAt >= august.startUtc && approvedAt < august.endUtc, true, 'must be in August');
});

test('an approval just before the IST rollover stays in the earlier month', () => {
  // 31 Jul 2026, 23:59 IST — stored as 31 Jul 18:29 UTC.
  const approvedAt = '2026-07-31 18:29:00';
  assert.equal(istMonthKeyOf(approvedAt), '2026-07');

  const july = monthWindowIST(2026, 7);
  assert.equal(approvedAt >= july.startUtc && approvedAt < july.endUtc, true);
});

test('comparing the raw UTC string would misfile the boundary — which is why we convert', () => {
  // Guards the bug rather than the fix: naive string matching says July, IST says August.
  const approvedAt = '2026-07-31 19:30:00';
  assert.equal(approvedAt.slice(0, 7), '2026-07', 'the stored string reads as July');
  assert.equal(istMonthKeyOf(approvedAt), '2026-08', 'but the department counts it in August');
});

test('the same month in different years is a different window', () => {
  const a = monthWindowIST(2025, 7);
  const b = monthWindowIST(2026, 7);
  assert.notEqual(a.startUtc, b.startUtc);
  // A 2025 approval must not fall inside the 2026 window.
  assert.equal('2025-07-15 06:00:00' < b.startUtc, true);
});

test('December rolls into the next January, not month 13', () => {
  const dec = monthWindowIST(2026, 12);
  assert.equal(dec.endUtc, '2026-12-31 18:30:00');
  assert.equal(monthWindowIST(2027, 1).startUtc, dec.endUtc);
});

test('a malformed month is rejected rather than defaulted', () => {
  // Silently falling back to "this month" would produce a plausible, wrong report.
  assert.equal(monthWindowIST(2026, 13), null);
  assert.equal(monthWindowIST(2026, 0), null);
  assert.equal(parseMonthKey('2026-13'), null);
  assert.equal(parseMonthKey('July 2026'), null);
  assert.equal(parseMonthKey(''), null);
  assert.equal(parseMonthKey(null), null);
  assert.equal(parseMonthKey('2026-07').month, 7);
});

// ── Schema ──────────────────────────────────────────────────────────────────────

test('cost_annexures carries approved_at', () => {
  const cols = db.prepare('PRAGMA table_info(cost_annexures)').all().map((c) => c.name);
  assert.ok(cols.includes('approved_at'), 'the reporting month depends on this column');
});

test('approving an annexure stamps approved_at in the same write as the status', () => {
  const ref = `rm-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;
  const jobId = Number(db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by)
     VALUES (?, ?, 'completed', 1)`
  ).run(`REQ-${ref}`, `JOB-${ref}`).lastInsertRowid);
  const id = Number(db.prepare(
    `INSERT INTO cost_annexures (annexure_no, job_id, version, status, grand_total_paise, line_count)
     VALUES (?, ?, 1, 'draft', 1000, 1)`
  ).run(`PCA-${ref}`, jobId).lastInsertRowid);

  assert.equal(db.prepare('SELECT approved_at FROM cost_annexures WHERE id = ?').get(id).approved_at, null);

  db.prepare("UPDATE cost_annexures SET status='approved', approved_at=datetime('now') WHERE id=?").run(id);
  const row = db.prepare('SELECT status, approved_at FROM cost_annexures WHERE id = ?').get(id);
  assert.equal(row.status, 'approved');
  assert.ok(row.approved_at, 'an approved annexure with no timestamp cannot be reported on');
  assert.ok(istMonthKeyOf(row.approved_at), 'and it must resolve to a month');

  db.prepare("UPDATE cost_annexures SET status='superseded' WHERE id=?").run(id);
  db.prepare('DELETE FROM cost_annexures WHERE id = ?').run(id);
  db.prepare('DELETE FROM print_jobs WHERE id = ?').run(jobId);
});

test('a superseded version keeps its own timestamp and is excluded by status, not by date', () => {
  // Both versions may carry an approved_at. Only the non-superseded one may be counted,
  // so the report filters on status as well as the month window.
  const ref = `sup-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;
  const jobId = Number(db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by)
     VALUES (?, ?, 'completed', 1)`
  ).run(`REQ-${ref}`, `JOB-${ref}`).lastInsertRowid);
  const mk = (v, status) => Number(db.prepare(
    `INSERT INTO cost_annexures (annexure_no, job_id, version, status, grand_total_paise, line_count, approved_at)
     VALUES (?, ?, ?, ?, 5000, 1, '2026-07-15 06:00:00')`
  ).run(`PCA-${ref}-v${v}`, jobId, v, status).lastInsertRowid);
  const v1 = mk(1, 'superseded');
  const v2 = mk(2, 'approved');

  const july = monthWindowIST(2026, 7);
  const counted = db.prepare(
    `SELECT id FROM cost_annexures
      WHERE job_id = ? AND status = 'approved'
        AND approved_at >= ? AND approved_at < ?`
  ).all(jobId, july.startUtc, july.endUtc).map((r) => r.id);

  assert.deepEqual(counted, [v2], 'only the live approved version contributes');
  assert.equal(counted.includes(v1), false);

  db.prepare("UPDATE cost_annexures SET status='superseded' WHERE job_id=?").run(jobId);
  db.prepare('DELETE FROM cost_annexures WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM print_jobs WHERE id = ?').run(jobId);
});
