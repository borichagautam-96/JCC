// A voucher must never disappear from the requestor's history.
//
// Two ways it did:
//   1. The list joined users with an INNER JOIN, so a voucher whose creator no longer
//      resolved was dropped from the result set entirely — the claim vanished because
//      of something done to an account, not to the claim.
//   2. The Pending tile counted `status === 'pending'`, which is not a voucher status
//      at all. It belongs to approver_status and supplier_ack_status. A claim sitting
//      with the manager is `pending_approval_1`, so the tile always read 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import db from '../database.js';
import jccRouter from '../routes/jcc.js';
import { JWT_SECRET } from '../middleware/auth.js';
import { isPending, isApproved, isRejected } from '../../src/constants/voucherStatus.js';

const app = express();
app.use(express.json());
app.use('/api/jcc', jccRouter);

const tokenFor = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
const uniq = () => `vis-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

const makeUser = (suffix, role = 'user') => {
  const ref = `${uniq()}-${suffix}`;
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', ?, 1, datetime('now'))`
  ).run(ref, `Test ${suffix}`, `${ref}@example.test`, role);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role };
};

const makeVoucher = (userId, status) => Number(db.prepare(
  `INSERT INTO voucher_requests (user_id, claimed_by, department, supplier, description, status)
   VALUES (?, 'Claimed By Name', 'Eng', 'ACME', 'test', ?)`
).run(userId, status).lastInsertRowid);

const cleanup = (voucherIds, userIds) => {
  voucherIds.forEach((id) => {
    db.prepare('DELETE FROM voucher_materials WHERE voucher_id = ?').run(id);
    db.prepare('DELETE FROM voucher_requests WHERE id = ?').run(id);
  });
  userIds.forEach((id) => {
    db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_activity_logs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
};

// ── Status buckets ──────────────────────────────────────────────────────────────

test('a voucher awaiting approval counts as pending', () => {
  // The literal that was being compared. Nothing writes it as a voucher status.
  assert.equal(isPending('pending'), false, "'pending' is not a voucher status");

  for (const s of ['pending_approval_1', 'pending_approval_2', 'info_requested', 'recalled']) {
    assert.equal(isPending(s), true, `${s} should count as pending for the requestor`);
    assert.equal(isApproved(s), false);
    assert.equal(isRejected(s), false);
  }
});

test('downstream payment states still read as approved', () => {
  // Payment and vendor steps are bookkeeping after the verdict, not a different one.
  for (const s of ['approved', 'pending_payment', 'voucher_created']) {
    assert.equal(isApproved(s), true, `${s} should count as approved`);
    assert.equal(isPending(s), false, `${s} must not also be counted as pending`);
  }
});

test('rejected is its own bucket, and the buckets never overlap', () => {
  assert.equal(isRejected('rejected'), true);
  const all = ['pending_approval_1', 'pending_approval_2', 'info_requested', 'recalled',
    'approved', 'pending_payment', 'voucher_created', 'rejected'];
  for (const s of all) {
    const hits = [isPending(s), isApproved(s), isRejected(s)].filter(Boolean).length;
    assert.equal(hits, 1, `${s} must land in exactly one bucket, landed in ${hits}`);
  }
});

test('status matching tolerates casing and stray whitespace', () => {
  assert.equal(isPending(' Pending_Approval_1 '), true);
  assert.equal(isApproved('APPROVED'), true);
});

test('an unknown status is not silently counted as anything', () => {
  // Better to under-report than to file a claim under the wrong verdict.
  assert.equal(isPending('some_new_state'), false);
  assert.equal(isApproved('some_new_state'), false);
  assert.equal(isRejected('some_new_state'), false);
});

// ── Visibility ──────────────────────────────────────────────────────────────────

test('a requestor sees their own voucher in every status', async () => {
  const user = makeUser('own');
  const ids = ['pending_approval_1', 'approved', 'rejected'].map((s) => makeVoucher(user.id, s));

  const res = await request(app).get('/api/jcc/vouchers')
    .set('Authorization', `Bearer ${tokenFor(user)}`);

  assert.equal(res.status, 200);
  const mine = res.body.filter((v) => ids.includes(v.id));
  assert.equal(mine.length, 3, 'no status should be hidden from its own requestor');

  cleanup(ids, [user.id]);
});

test('a voucher survives its creator being deactivated', async () => {
  const admin = makeUser('visadmin', 'admin');
  const user = makeUser('leaver');
  const id = makeVoucher(user.id, 'pending_approval_1');

  db.prepare("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(user.id);

  const res = await request(app).get('/api/jcc/vouchers')
    .set('Authorization', `Bearer ${tokenFor(admin)}`);
  const found = res.body.find((v) => v.id === id);

  assert.ok(found, 'deactivating an account must not erase the claims it raised');
  assert.equal(found.user_name, user.name);

  cleanup([id], [admin.id, user.id]);
});

test('a voucher whose creator row is gone still appears, named from the claim', async () => {
  // The inner-join failure. user_id is NOT NULL so it can never be blank, but the FK to
  // users is not enforced at runtime (the connection sets foreign_keys = OFF), so it can
  // point at a row that no longer exists — which is exactly what hard-deleting users used
  // to leave behind, and what an INNER JOIN then hid.
  const admin = makeUser('orphanadmin', 'admin');
  const id = makeVoucher(admin.id, 'approved');
  const ghostId = 99000000 + (process.pid % 100000);
  db.prepare('UPDATE voucher_requests SET user_id = ? WHERE id = ?').run(ghostId, id);

  const res = await request(app).get('/api/jcc/vouchers')
    .set('Authorization', `Bearer ${tokenFor(admin)}`);
  const found = res.body.find((v) => v.id === id);

  assert.ok(found, 'a dangling creator must not hide a financial record');
  assert.equal(found.user_name, 'Claimed By Name', 'falls back to who the claim says it is for');

  cleanup([id], [admin.id]);
});
