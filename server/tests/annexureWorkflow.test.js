// The cost annexure approval chain.
//
//   completed job -> annexure issued as DRAFT (printing team's court)
//     -> operator checks / corrects it
//     -> "send for approval"        -> UNDER_REVIEW (requestor's court)
//     -> requestor APPROVES          -> APPROVED, locked
//        or REJECTS with a reason    -> back to DRAFT for the printing team
//
// The two boundaries under test: only the printing floor can send, and only the
// requestor who raised the job can approve or reject.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import db from '../database.js';
import annexuresRouter from '../routes/annexures.js';
import { JWT_SECRET } from '../middleware/auth.js';

const app = express();
app.use(express.json());
app.use('/api', annexuresRouter);

const tokenFor = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
const uniq = () => `wf-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

const makeUser = (suffix, { coordinator = false, operator = false } = {}) => {
  const ref = `${uniq()}-${suffix}`;
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, is_printer_coordinator,
                        is_printer_operator, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', 'user', ?, ?, 1, datetime('now'))`
  ).run(ref, `Test ${suffix}`, `${ref}@example.test`, coordinator ? 1 : 0, operator ? 1 : 0);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role: 'user' };
};

const makeAnnexure = (requestorId, operatorId = null) => {
  const ref = uniq();
  const jobId = Number(db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by, assigned_operator_id, completed_at)
     VALUES (?, ?, 'completed', ?, ?, datetime('now'))`
  ).run(`REQ-${ref}`, `JOB-${ref}`, requestorId, operatorId).lastInsertRowid);

  const id = Number(db.prepare(
    `INSERT INTO cost_annexures (annexure_no, job_id, version, status, grand_total_paise, line_count)
     VALUES (?, ?, 1, 'draft', 120000, 1)`
  ).run(`PCA-WF-${ref}`, jobId).lastInsertRowid);

  db.prepare(
    `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
                                 rate_milli, amount_paise, rate_status, annexure_id)
     VALUES (?, 'PRINT_W', 'Printing', 'printing', 10, 'nos', 12000, 120000, 'priced', ?)`
  ).run(jobId, id);

  return { jobId, id, annexure_no: `PCA-WF-${ref}` };
};

const statusOf = (id) => db.prepare('SELECT status FROM cost_annexures WHERE id = ?').get(id).status;
const trail = (id) => db.prepare(
  'SELECT role, remarks FROM annexure_approvals WHERE annexure_id = ? ORDER BY id'
).all(id);
const notificationsFor = (userId) =>
  db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id').all(userId);

const cleanup = ({ jobIds = [], userIds = [] }) => {
  jobIds.forEach((jid) => {
    // Approved annexures are locked at the database level, so the fixture has to
    // supersede them before its rows can be removed. Needing this is itself evidence
    // the lock is real rather than a route-level convention.
    db.prepare("UPDATE cost_annexures SET status = 'superseded' WHERE job_id = ? AND status = 'approved'").run(jid);
    db.prepare('SELECT id FROM cost_annexures WHERE job_id = ?').all(jid).forEach((r) => {
      db.prepare('DELETE FROM annexure_approvals WHERE annexure_id = ?').run(r.id);
    });
    db.prepare('DELETE FROM job_cost_lines WHERE job_id = ?').run(jid);
    db.prepare('DELETE FROM cost_annexures WHERE job_id = ?').run(jid);
    db.prepare('DELETE FROM print_jobs WHERE id = ?').run(jid);
  });
  userIds.forEach((id) => {
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
};

test('a new annexure starts with the printing team, not the requestor', async () => {
  const requestor = makeUser('start');
  const a = makeAnnexure(requestor.id);

  assert.equal(statusOf(a.id), 'draft');

  // The requestor cannot approve what has not been put to them yet.
  const res = await request(app).post(`/api/annexures/${a.annexure_no}/approve`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NOT_SENT_FOR_APPROVAL');
  assert.equal(statusOf(a.id), 'draft');

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id] });
});

test('the operator sends it for approval and the requestor is told', async () => {
  const requestor = makeUser('sendreq');
  const operator = makeUser('sendop', { operator: true });
  const a = makeAnnexure(requestor.id, operator.id);

  const res = await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(operator)}`).send({});

  assert.equal(res.status, 200);
  assert.equal(statusOf(a.id), 'under_review');
  // The printing team's check is signed before the requestor is ever asked.
  assert.deepEqual(trail(a.id).map((t) => t.role), ['reviewed']);
  assert.ok(notificationsFor(requestor.id).some((n) => /ready for your approval/i.test(n.title)));

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, operator.id] });
});

test('a requestor cannot send their own annexure for approval', async () => {
  const requestor = makeUser('selfsend');
  const a = makeAnnexure(requestor.id);

  const res = await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({});

  assert.equal(res.status, 403);
  assert.equal(statusOf(a.id), 'draft');

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id] });
});

test('sending twice is refused', async () => {
  const requestor = makeUser('twicereq');
  const coordinator = makeUser('twicecoord', { coordinator: true });
  const a = makeAnnexure(requestor.id);

  await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`).send({});
  const again = await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`).send({});

  assert.equal(again.status, 400);
  assert.match(again.body.error, /already with the requestor/i);

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, coordinator.id] });
});

test('the requestor approves and the figures lock', async () => {
  const requestor = makeUser('okreq');
  const coordinator = makeUser('okcoord', { coordinator: true });
  const a = makeAnnexure(requestor.id);

  await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`).send({});
  const res = await request(app).post(`/api/annexures/${a.annexure_no}/approve`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({});

  assert.equal(res.status, 200);
  assert.equal(statusOf(a.id), 'approved');
  assert.ok(res.body.payload_sha256);
  assert.deepEqual(trail(a.id).map((t) => t.role), ['reviewed', 'approved']);
  assert.ok(notificationsFor(coordinator.id).some((n) => /approved by requestor/i.test(n.title)));

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, coordinator.id] });
});

test('the requestor rejects, and it goes back to the printing team with the reason', async () => {
  const requestor = makeUser('rejreq');
  const operator = makeUser('rejop', { operator: true });
  const a = makeAnnexure(requestor.id, operator.id);

  await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(operator)}`).send({});
  const res = await request(app).post(`/api/annexures/${a.annexure_no}/reject`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`)
    .send({ reason: 'Page count is wrong — only 40 pages were printed, not 60' });

  assert.equal(res.status, 200);
  // Back to the printing team on the SAME annexure, not superseded.
  assert.equal(statusOf(a.id), 'draft');
  const t = trail(a.id);
  assert.deepEqual(t.map((x) => x.role), ['reviewed', 'returned']);
  assert.match(t[1].remarks, /only 40 pages/);
  assert.ok(notificationsFor(operator.id).some((n) => /rejected by requestor/i.test(n.title)
    && n.message.includes('only 40 pages')));

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, operator.id] });
});

test('a rejection must say what is wrong', async () => {
  const requestor = makeUser('noreason');
  const coordinator = makeUser('nrcoord', { coordinator: true });
  const a = makeAnnexure(requestor.id);

  await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`).send({});
  const res = await request(app).post(`/api/annexures/${a.annexure_no}/reject`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({ reason: '   ' });

  assert.equal(res.status, 400);
  assert.equal(statusOf(a.id), 'under_review', 'still with the requestor — nothing moved');

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, coordinator.id] });
});

test('only the requestor who raised the job can reject it', async () => {
  const requestor = makeUser('ownreq');
  const coordinator = makeUser('othercoord', { coordinator: true });
  const a = makeAnnexure(requestor.id);

  await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`).send({});
  // The coordinator prepared these figures — they do not get to reject them either.
  const res = await request(app).post(`/api/annexures/${a.annexure_no}/reject`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`).send({ reason: 'nope' });

  assert.equal(res.status, 403);
  assert.equal(statusOf(a.id), 'under_review');

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, coordinator.id] });
});

test('a draft cannot be rejected — it was never sent', async () => {
  const requestor = makeUser('draftrej');
  const a = makeAnnexure(requestor.id);

  const res = await request(app).post(`/api/annexures/${a.annexure_no}/reject`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({ reason: 'too much' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /not been sent for your approval/i);

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id] });
});

test('the full round trip: reject, correct, resend, approve', async () => {
  const requestor = makeUser('rtreq');
  const operator = makeUser('rtop', { operator: true });
  const a = makeAnnexure(requestor.id, operator.id);
  const send = () => request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(operator)}`).send({});

  await send();
  await request(app).post(`/api/annexures/${a.annexure_no}/reject`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({ reason: 'Wrong paper size' });
  assert.equal(statusOf(a.id), 'draft');

  // Corrected and put back to the requestor on the same annexure number.
  await send();
  assert.equal(statusOf(a.id), 'under_review');
  const res = await request(app).post(`/api/annexures/${a.annexure_no}/approve`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({});

  assert.equal(res.status, 200);
  assert.equal(statusOf(a.id), 'approved');
  // Both rounds are on one history, so the rejection is not lost by the fix.
  assert.deepEqual(trail(a.id).map((x) => x.role),
    ['reviewed', 'returned', 'reviewed', 'approved']);

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, operator.id] });
});

test('an approved annexure can no longer be rejected', async () => {
  const requestor = makeUser('lockedreq');
  const coordinator = makeUser('lockedcoord', { coordinator: true });
  const a = makeAnnexure(requestor.id);

  await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`).send({});
  await request(app).post(`/api/annexures/${a.annexure_no}/approve`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({});

  const res = await request(app).post(`/api/annexures/${a.annexure_no}/reject`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({ reason: 'changed my mind' });

  assert.equal(res.status, 400);
  assert.equal(statusOf(a.id), 'approved');

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, coordinator.id] });
});

test('the queue separates what needs the operator from what needs the requestor', async () => {
  const coordinator = makeUser('qcoord', { coordinator: true });
  const requestor = makeUser('qreq');
  const waiting = makeAnnexure(requestor.id);
  const sent = makeAnnexure(requestor.id);

  await request(app).post(`/api/annexures/${sent.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`).send({});

  const res = await request(app).get('/api/annexures/pending')
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.annexures.find((r) => r.id === waiting.id).with_requestor, false);
  assert.equal(res.body.annexures.find((r) => r.id === sent.id).with_requestor, true);
  assert.ok(res.body.with_printing >= 1);
  assert.ok(res.body.with_requestor >= 1);

  cleanup({ jobIds: [waiting.jobId, sent.jobId], userIds: [coordinator.id, requestor.id] });
});

// ── The approved lock, at the database rather than the route ────────────────────
// The route guard is one `if` on one path. These assert the rule holds even when the
// routes are bypassed entirely — a script, a migration or a future endpoint cannot
// quietly rewrite figures the requestor has already signed off.

const approvedAnnexure = async (requestor, coordinator) => {
  const a = makeAnnexure(requestor.id);
  await request(app).post(`/api/annexures/${a.annexure_no}/send-for-approval`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`).send({});
  await request(app).post(`/api/annexures/${a.annexure_no}/approve`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({});
  assert.equal(statusOf(a.id), 'approved');
  return a;
};

test('an approved annexure cost line cannot be updated, even directly in SQL', async () => {
  const requestor = makeUser('lockupd');
  const coordinator = makeUser('lockupdc', { coordinator: true });
  const a = await approvedAnnexure(requestor, coordinator);
  const line = db.prepare('SELECT * FROM job_cost_lines WHERE annexure_id = ?').get(a.id);

  assert.throws(
    () => db.prepare('UPDATE job_cost_lines SET amount_paise = 999999 WHERE id = ?').run(line.id),
    /approved annexure cannot be changed/i);
  assert.equal(
    db.prepare('SELECT amount_paise FROM job_cost_lines WHERE id = ?').get(line.id).amount_paise,
    line.amount_paise);

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, coordinator.id] });
});

test('an approved annexure cost line cannot be deleted, even directly in SQL', async () => {
  const requestor = makeUser('lockdel');
  const coordinator = makeUser('lockdelc', { coordinator: true });
  const a = await approvedAnnexure(requestor, coordinator);
  const line = db.prepare('SELECT * FROM job_cost_lines WHERE annexure_id = ?').get(a.id);

  assert.throws(
    () => db.prepare('DELETE FROM job_cost_lines WHERE id = ?').run(line.id),
    /approved annexure cannot be deleted/i);
  assert.ok(db.prepare('SELECT 1 FROM job_cost_lines WHERE id = ?').get(line.id));

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, coordinator.id] });
});

test('a new cost line cannot be added to an approved annexure', async () => {
  const requestor = makeUser('lockins');
  const coordinator = makeUser('lockinsc', { coordinator: true });
  const a = await approvedAnnexure(requestor, coordinator);

  assert.throws(
    () => db.prepare(
      `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
                                   rate_milli, amount_paise, rate_status, annexure_id)
       VALUES (?, 'SNEAK', 'Sneaked in', 'misc', 1, 'nos', 50000, 50000, 'priced', ?)`
    ).run(a.jobId, a.id),
    /cannot be added to an approved annexure/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM job_cost_lines WHERE annexure_id = ?').get(a.id).c, 1);

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, coordinator.id] });
});

test('an approved annexure cannot be dropped back to draft or under_review', async () => {
  const requestor = makeUser('lockstat');
  const coordinator = makeUser('lockstatc', { coordinator: true });
  const a = await approvedAnnexure(requestor, coordinator);

  for (const target of ['draft', 'under_review']) {
    assert.throws(
      () => db.prepare('UPDATE cost_annexures SET status = ? WHERE id = ?').run(target, a.id),
      /can only be superseded by a reissue/i);
  }
  assert.equal(statusOf(a.id), 'approved');

  // Superseding IS allowed — that is what a reissue does.
  db.prepare("UPDATE cost_annexures SET status = 'superseded' WHERE id = ?").run(a.id);
  assert.equal(statusOf(a.id), 'superseded');

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, coordinator.id] });
});

test('the operator is refused by the route as well, with a usable message', async () => {
  const requestor = makeUser('lockroute');
  const operator = makeUser('lockrouteop', { operator: true });
  const coordinator = makeUser('lockroutec', { coordinator: true });
  const a = await approvedAnnexure(requestor, coordinator);

  const res = await request(app).put(`/api/jobs/${a.jobId}/cost/lines`)
    .set('Authorization', `Bearer ${tokenFor(operator)}`)
    .send({ reason: 'trying to change it', lines: [{ service_code: 'PRINT_W', quantity: 999 }] });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /approved and locked/i);

  const del = await request(app)
    .delete(`/api/jobs/${a.jobId}/cost/lines/${db.prepare('SELECT id FROM job_cost_lines WHERE annexure_id = ?').get(a.id).id}`)
    .set('Authorization', `Bearer ${tokenFor(operator)}`);
  assert.equal(del.status, 409);

  cleanup({ jobIds: [a.jobId], userIds: [requestor.id, operator.id, coordinator.id] });
});
