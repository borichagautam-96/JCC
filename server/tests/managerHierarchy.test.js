// Manager-wise grouping of the cost register.
//
// Two rules under test:
//   1. The manager on a job is the one stamped WHEN IT WAS SUBMITTED. Moving somebody
//      between teams must not re-parent work they already raised — otherwise the same
//      report run twice, over identical data, shows different trees.
//   2. A manager may open the register, but sees only their own team.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import db from '../database.js';
import annexuresRouter from '../routes/annexures.js';
import jobsRouter from '../routes/jobs.js';
import { JWT_SECRET } from '../middleware/auth.js';

const app = express();
app.use(express.json());
app.use('/api/jobs', jobsRouter);
app.use('/api', annexuresRouter);

const tokenFor = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
const uniq = () => `mgr-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

const makeUser = (suffix, { role = 'user', managerId = null, coordinator = false } = {}) => {
  const ref = `${uniq()}-${suffix}`;
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, manager_id,
                        is_printer_coordinator, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', ?, ?, ?, 1, datetime('now'))`
  ).run(ref, `Test ${suffix}`, `${ref}@example.test`, role, managerId, coordinator ? 1 : 0);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role, ps_number: ref };
};

// A completed job with an annexure, stamped to `managerId` as if submitted under them.
const makeCostedJob = (requestorId, managerId, managerName) => {
  const ref = uniq();
  const jobId = Number(db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by, completed_at,
                             manager_id_at_submit, manager_name_at_submit, debit_code, project_name)
     VALUES (?, ?, 'completed', ?, datetime('now'), ?, ?, 'DBT-9', 'Alpha')`
  ).run(`REQ-${ref}`, `JOB-${ref}`, requestorId, managerId, managerName).lastInsertRowid);

  const annexureNo = `PCA-MG-${ref}`;
  db.prepare(
    `INSERT INTO cost_annexures (annexure_no, job_id, version, status, printing_paise,
                                 binding_paise, finishing_paise, grand_total_paise, line_count)
     VALUES (?, ?, 1, 'approved', 100000, 20000, 5000, 125000, 1)`
  ).run(annexureNo, jobId);
  return { jobId, annexureNo };
};

const cleanup = (jobIds, userIds) => {
  jobIds.forEach((id) => {
    db.prepare('DELETE FROM cost_annexures WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM job_cost_lines WHERE job_id = ?').run(id);
    db.prepare("DELETE FROM audit_logs WHERE entity_type='print_job' AND entity_id = ?").run(id);
    db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id);
  });
  userIds.forEach((id) => {
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_activity_logs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
};

// ── The manager is stamped, not derived ─────────────────────────────────────────

test('submitting a job stamps the requestor current manager onto it', async () => {
  const manager = makeUser('stampmgr', { role: 'manager' });
  const member = makeUser('stampmem', { managerId: manager.id });
  const jobId = Number(db.prepare(
    `INSERT INTO print_jobs (request_id, status, created_by, debit_code)
     VALUES (?, 'draft', ?, 'DBT-1')`
  ).run(`REQ-${uniq()}`, member.id).lastInsertRowid);
  db.prepare(
    `INSERT INTO print_job_documents (job_id, document_name, quantity, num_pages, pdf_path)
     VALUES (?, 'Manual', 1, 10, 'x.pdf')`
  ).run(jobId);

  const res = await request(app).post(`/api/jobs/${jobId}/submit`)
    .set('Authorization', `Bearer ${tokenFor(member)}`).send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
  assert.equal(job.manager_id_at_submit, manager.id);
  assert.equal(job.manager_name_at_submit, manager.name);

  cleanup([jobId], [manager.id, member.id]);
});

test('moving someone to a new manager does not re-parent work they already raised', async () => {
  const oldMgr = makeUser('oldmgr', { role: 'manager' });
  const newMgr = makeUser('newmgr', { role: 'manager' });
  const coordinator = makeUser('histcoord', { coordinator: true });
  const member = makeUser('mover', { managerId: oldMgr.id });
  const { jobId } = makeCostedJob(member.id, oldMgr.id, oldMgr.name);

  // The reorg: same person, different reporting line from today onward.
  db.prepare('UPDATE users SET manager_id = ? WHERE id = ?').run(newMgr.id, member.id);

  const res = await request(app).get('/api/annexures')
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`);
  const row = res.body.annexures.find((r) => r.job_id === jobId);

  assert.equal(row.manager_id, oldMgr.id, 'the job stays under the manager it was submitted to');
  assert.equal(row.manager_name, oldMgr.name);

  cleanup([jobId], [oldMgr.id, newMgr.id, coordinator.id, member.id]);
});

test('a job with no stamp falls back to the live reporting line', async () => {
  const manager = makeUser('fallbackmgr', { role: 'manager' });
  const coordinator = makeUser('fbcoord', { coordinator: true });
  const member = makeUser('fbmem', { managerId: manager.id });
  const { jobId } = makeCostedJob(member.id, null, null);   // pre-migration shape

  const res = await request(app).get('/api/annexures')
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`);
  const row = res.body.annexures.find((r) => r.job_id === jobId);

  assert.equal(row.manager_id, manager.id, 'unstamped rows still group somewhere sensible');
  assert.equal(row.manager_name, manager.name);

  cleanup([jobId], [manager.id, coordinator.id, member.id]);
});

// ── Manager access, scoped to their own team ────────────────────────────────────

test('a manager can open the register and sees only their own team', async () => {
  const mine = makeUser('minemgr', { role: 'manager' });
  const theirs = makeUser('theirmgr', { role: 'manager' });
  const myMember = makeUser('mymem', { managerId: mine.id });
  const theirMember = makeUser('theirmem', { managerId: theirs.id });
  const a = makeCostedJob(myMember.id, mine.id, mine.name);
  const b = makeCostedJob(theirMember.id, theirs.id, theirs.name);

  const res = await request(app).get('/api/annexures')
    .set('Authorization', `Bearer ${tokenFor(mine)}`);

  assert.equal(res.status, 200, 'a manager is no longer locked out of the register');
  const ids = res.body.annexures.map((r) => r.job_id);
  assert.ok(ids.includes(a.jobId), 'their own team is visible');
  assert.equal(ids.includes(b.jobId), false, 'another manager team is not');
  assert.ok(res.body.annexures.every((r) => r.manager_id === mine.id));

  cleanup([a.jobId, b.jobId], [mine.id, theirs.id, myMember.id, theirMember.id]);
});

test('a coordinator still sees every team', async () => {
  const coordinator = makeUser('allcoord', { coordinator: true });
  const mgrA = makeUser('amgr', { role: 'manager' });
  const mgrB = makeUser('bmgr', { role: 'manager' });
  const memA = makeUser('amem', { managerId: mgrA.id });
  const memB = makeUser('bmem', { managerId: mgrB.id });
  const a = makeCostedJob(memA.id, mgrA.id, mgrA.name);
  const b = makeCostedJob(memB.id, mgrB.id, mgrB.name);

  const res = await request(app).get('/api/annexures')
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`);

  const ids = res.body.annexures.map((r) => r.job_id);
  assert.ok(ids.includes(a.jobId) && ids.includes(b.jobId));

  cleanup([a.jobId, b.jobId], [coordinator.id, mgrA.id, mgrB.id, memA.id, memB.id]);
});

test('a plain user with no printing role still gets nothing', async () => {
  const outsider = makeUser('nobody');
  const res = await request(app).get('/api/annexures')
    .set('Authorization', `Bearer ${tokenFor(outsider)}`);

  assert.equal(res.status, 403);
  cleanup([], [outsider.id]);
});

test('a manager can open an annexure from their team but not another team', async () => {
  const mine = makeUser('detailmine', { role: 'manager' });
  const theirs = makeUser('detailtheirs', { role: 'manager' });
  const myMember = makeUser('dmem', { managerId: mine.id });
  const theirMember = makeUser('dother', { managerId: theirs.id });
  const a = makeCostedJob(myMember.id, mine.id, mine.name);
  const b = makeCostedJob(theirMember.id, theirs.id, theirs.name);

  const ok = await request(app).get(`/api/annexures/${a.annexureNo}`)
    .set('Authorization', `Bearer ${tokenFor(mine)}`);
  assert.equal(ok.status, 200);

  const denied = await request(app).get(`/api/annexures/${b.annexureNo}`)
    .set('Authorization', `Bearer ${tokenFor(mine)}`);
  assert.equal(denied.status, 403, 'the View button must not reach another team');

  cleanup([a.jobId, b.jobId], [mine.id, theirs.id, myMember.id, theirMember.id]);
});

test('the register is ordered manager, then member, then job so the client can group by walking', async () => {
  const coordinator = makeUser('ordcoord', { coordinator: true });
  const manager = makeUser('ordmgr', { role: 'manager' });
  const memberA = makeUser('aaa', { managerId: manager.id });
  const memberB = makeUser('bbb', { managerId: manager.id });
  // Inserted out of order on purpose.
  const j1 = makeCostedJob(memberB.id, manager.id, manager.name);
  const j2 = makeCostedJob(memberA.id, manager.id, manager.name);
  const j3 = makeCostedJob(memberB.id, manager.id, manager.name);

  const res = await request(app).get('/api/annexures')
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`);
  const mine = res.body.annexures.filter((r) => r.manager_id === manager.id);
  const names = mine.map((r) => r.requestor_name);

  // Each member's rows must be contiguous, or a single-pass grouping splits them.
  const firstSeen = new Map();
  names.forEach((n, i) => { if (!firstSeen.has(n)) firstSeen.set(n, i); });
  for (const [name, start] of firstSeen) {
    const rowsFor = names.filter((n) => n === name).length;
    assert.deepEqual(names.slice(start, start + rowsFor), Array(rowsFor).fill(name),
      `${name} rows must be contiguous`);
  }

  cleanup([j1.jobId, j2.jobId, j3.jobId], [coordinator.id, manager.id, memberA.id, memberB.id]);
});

// ── Filters ─────────────────────────────────────────────────────────────────────
// Applied server-side so the hierarchy and its rollups always describe exactly the
// rows on screen. Scope is applied separately: clearing filters must never widen what
// a manager can see.

const filterSetup = () => {
  const coordinator = makeUser('fcoord', { coordinator: true });
  const mgrA = makeUser('fmgrA', { role: 'manager' });
  const mgrB = makeUser('fmgrB', { role: 'manager' });
  const memA = makeUser('fmemA', { managerId: mgrA.id });
  const memB = makeUser('fmemB', { managerId: mgrB.id });
  const a = makeCostedJob(memA.id, mgrA.id, mgrA.name);
  const b = makeCostedJob(memB.id, mgrB.id, mgrB.name);
  return { coordinator, mgrA, mgrB, memA, memB, a, b,
           users: [coordinator.id, mgrA.id, mgrB.id, memA.id, memB.id],
           jobs: [a.jobId, b.jobId] };
};

const getRegister = (user, query = '') =>
  request(app).get(`/api/annexures${query}`).set('Authorization', `Bearer ${tokenFor(user)}`);

test('filtering by manager narrows to that team', async () => {
  const f = filterSetup();
  const res = await getRegister(f.coordinator, `?manager=${f.mgrA.id}`);

  const ids = res.body.annexures.map((r) => r.job_id);
  assert.ok(ids.includes(f.a.jobId));
  assert.equal(ids.includes(f.b.jobId), false);

  cleanup(f.jobs, f.users);
});

test('filtering by team member narrows to that person', async () => {
  const f = filterSetup();
  const res = await getRegister(f.coordinator, `?member=${f.memB.id}`);

  assert.ok(res.body.annexures.every((r) => r.requestor_id === f.memB.id));
  assert.ok(res.body.annexures.some((r) => r.job_id === f.b.jobId));

  cleanup(f.jobs, f.users);
});

test('free text matches a job number and an annexure number', async () => {
  const f = filterSetup();
  const job = db.prepare('SELECT job_number FROM print_jobs WHERE id = ?').get(f.a.jobId).job_number;

  const byJob = await getRegister(f.coordinator, `?q=${encodeURIComponent(job)}`);
  assert.deepEqual(byJob.body.annexures.map((r) => r.job_id), [f.a.jobId]);

  const byAnnexure = await getRegister(f.coordinator, `?q=${encodeURIComponent(f.b.annexureNo)}`);
  assert.deepEqual(byAnnexure.body.annexures.map((r) => r.job_id), [f.b.jobId]);

  cleanup(f.jobs, f.users);
});

test('a date range bounds on the completion date', async () => {
  const f = filterSetup();
  // Both fixtures completed today; a window that ends yesterday must exclude them.
  const past = await getRegister(f.coordinator, '?to=2000-01-01');
  assert.equal(past.body.annexures.filter((r) => f.jobs.includes(r.job_id)).length, 0);

  const now = await getRegister(f.coordinator, '?from=2000-01-01');
  assert.equal(now.body.annexures.filter((r) => f.jobs.includes(r.job_id)).length, 2);

  cleanup(f.jobs, f.users);
});

test('filters combine, and an impossible combination returns nothing', async () => {
  const f = filterSetup();
  // Manager A's team, but member B — nobody satisfies both.
  const res = await getRegister(f.coordinator, `?manager=${f.mgrA.id}&member=${f.memB.id}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.annexures.length, 0);
  assert.ok(res.body.total_count > 0, 'total_count still reports the unfiltered scope');

  cleanup(f.jobs, f.users);
});

test('a manager cannot use the manager filter to reach another team', async () => {
  const f = filterSetup();
  // mgrA asks for mgrB's team explicitly.
  const res = await getRegister(f.mgrA, `?manager=${f.mgrB.id}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.annexures.some((r) => r.job_id === f.b.jobId), false,
    'scope is a permission, not a filter — it must not be overridable by query string');
  assert.ok(res.body.annexures.every((r) => r.manager_id === f.mgrA.id));

  cleanup(f.jobs, f.users);
});

test('the option lists come from the whole scope, not the filtered rows', async () => {
  const f = filterSetup();
  // Narrow hard, then check the dropdowns still offer everything in scope.
  const res = await getRegister(f.coordinator, `?member=${f.memA.id}`);

  const memberIds = res.body.filters.members.map((m) => m.value);
  assert.ok(memberIds.includes(f.memA.id));
  assert.ok(memberIds.includes(f.memB.id),
    'narrowing on one member must not empty the member dropdown');

  cleanup(f.jobs, f.users);
});

test('a manager option list is limited to their own team', async () => {
  const f = filterSetup();
  const res = await getRegister(f.mgrA);

  const memberIds = res.body.filters.members.map((m) => m.value);
  assert.ok(memberIds.includes(f.memA.id));
  assert.equal(memberIds.includes(f.memB.id), false,
    'the dropdown must not name people outside the manager team');

  cleanup(f.jobs, f.users);
});
