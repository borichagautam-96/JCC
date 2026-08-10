// Creating and discarding requests.
//
// Two rules under test:
//   1. Cloning writes nothing. It only reads a past request so the form can be
//      pre-filled — an accidental click must not leave a row behind.
//   2. Only an unsubmitted draft can be discarded, and only by its owner. Anything
//      submitted belongs to the workflow and stays.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database.js';
import jobsRouter from '../routes/jobs.js';
import { JWT_SECRET } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, '../../uploads/print-jobs');

const app = express();
app.use(express.json());
app.use('/api/jobs', jobsRouter);

const tokenFor = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
const uniq = () => `dft-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

const makeUser = (suffix) => {
  const ref = `${uniq()}-${suffix}`;
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', 'user', 1, datetime('now'))`
  ).run(ref, `Test ${suffix}`, `${ref}@example.test`);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role: 'user' };
};

const makeJob = (createdBy, status = 'draft') => {
  const ref = uniq();
  return Number(db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by, debit_code, project_name, department_name)
     VALUES (?, ?, ?, ?, 'DBT-1', 'Bridge deck', 'Engineering')`
  ).run(`REQ-${ref}`, status === 'draft' ? null : `JOB-${ref}`, status, createdBy).lastInsertRowid);
};

// Scoped to one user: test files run in parallel processes against the same database,
// so a global row count races with whatever else is running.
const jobCount = (userId) => db.prepare('SELECT COUNT(*) AS c FROM print_jobs WHERE created_by = ?').get(userId).c;
const getJob = (id) => db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);

const cleanup = (jobIds, userIds) => {
  jobIds.forEach((id) => {
    db.prepare('DELETE FROM print_job_documents WHERE job_id = ?').run(id);
    db.prepare("DELETE FROM audit_logs WHERE entity_type='print_job' AND entity_id = ?").run(id);
    db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id);
  });
  userIds.forEach((id) => {
    db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_activity_logs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
};

// ── Clone reads, it does not write ──────────────────────────────────────────────

test('reading a clone source creates nothing', async () => {
  const user = makeUser('clonereq');
  const src = makeJob(user.id, 'completed');
  const before = jobCount(user.id);

  const res = await request(app).get(`/api/jobs/${src}/clone-source`)
    .set('Authorization', `Bearer ${tokenFor(user)}`);

  assert.equal(res.status, 200);
  assert.equal(jobCount(user.id), before, 'clicking Clone must not insert a row');
  assert.equal(res.body.form.project_name, 'Bridge deck');
  assert.equal(res.body.form.debit_code, 'DBT-1');
  assert.ok(res.body.cloned_from, 'the source is named so provenance can be recorded on save');

  cleanup([src], [user.id]);
});

test('the old clone endpoint that inserted a draft is gone', async () => {
  const user = makeUser('oldclone');
  const src = makeJob(user.id, 'completed');
  const before = jobCount(user.id);

  const res = await request(app).post(`/api/jobs/${src}/clone`)
    .set('Authorization', `Bearer ${tokenFor(user)}`).send({});

  assert.equal(res.status, 404);
  assert.equal(jobCount(user.id), before);

  cleanup([src], [user.id]);
});

test('a clone source belonging to someone else is refused', async () => {
  const owner = makeUser('owner');
  const other = makeUser('other');
  const src = makeJob(owner.id, 'completed');

  const res = await request(app).get(`/api/jobs/${src}/clone-source`)
    .set('Authorization', `Bearer ${tokenFor(other)}`);

  assert.equal(res.status, 403);
  cleanup([src], [owner.id, other.id]);
});

test('saving a cloned form creates one request and records where it came from', async () => {
  const user = makeUser('savedclone');
  const src = makeJob(user.id, 'completed');
  const before = jobCount(user.id);

  const res = await request(app).post('/api/jobs')
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({ debit_code: 'DBT-1', project_name: 'Bridge deck', cloned_from: 'JOB-SOURCE' });

  assert.equal(res.status, 200);
  assert.equal(jobCount(user.id), before + 1, 'exactly one row, created on save');
  const audit = db.prepare(
    "SELECT action, details FROM audit_logs WHERE entity_type='print_job' AND entity_id = ?"
  ).get(res.body.id);
  assert.equal(audit.action, 'CLONE_PRINT_REQUEST');
  assert.match(audit.details, /cloned from JOB-SOURCE/i);

  cleanup([src, res.body.id], [user.id]);
});

// ── Discarding a draft ──────────────────────────────────────────────────────────

test('the owner can discard their own draft', async () => {
  const user = makeUser('discard');
  const jobId = makeJob(user.id, 'draft');

  const res = await request(app).delete(`/api/jobs/${jobId}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`);

  assert.equal(res.status, 200);
  // The db shim returns null rather than undefined for a missing row, so this checks
  // absence rather than a specific empty value.
  assert.ok(!getJob(jobId), 'the row is gone');

  cleanup([], [user.id]);
});

test('a submitted request cannot be discarded', async () => {
  const user = makeUser('submitted');
  for (const status of ['submitted', 'accepted', 'printing', 'completed']) {
    const jobId = makeJob(user.id, status);
    const res = await request(app).delete(`/api/jobs/${jobId}`)
      .set('Authorization', `Bearer ${tokenFor(user)}`);

    assert.equal(res.status, 400, `${status} must not be deletable`);
    assert.equal(res.body.code, 'NOT_A_DRAFT');
    assert.ok(getJob(jobId), `${status} row must survive`);
    cleanup([jobId], []);
  }
  cleanup([], [user.id]);
});

test('a draft belonging to someone else cannot be discarded', async () => {
  const owner = makeUser('draftowner');
  const other = makeUser('draftother');
  const jobId = makeJob(owner.id, 'draft');

  const res = await request(app).delete(`/api/jobs/${jobId}`)
    .set('Authorization', `Bearer ${tokenFor(other)}`);

  assert.equal(res.status, 403);
  assert.ok(getJob(jobId));

  cleanup([jobId], [owner.id, other.id]);
});

test('discarding a draft takes its documents and their files with it', async () => {
  const user = makeUser('withdocs');
  const jobId = makeJob(user.id, 'draft');

  // A real uploaded file, so the unlink is exercised rather than assumed.
  const filename = `${uniq()}-doc.pdf`;
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, filename), 'pdf bytes');
  db.prepare(
    `INSERT INTO print_job_documents (job_id, document_name, quantity, num_pages, pdf_path)
     VALUES (?, 'Manual', 1, 10, ?)`
  ).run(jobId, filename);

  const res = await request(app).delete(`/api/jobs/${jobId}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.deleted_documents, 1);
  // foreign_keys is OFF on this connection, so ON DELETE CASCADE never fires — the
  // route has to remove children itself or they are stranded.
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM print_job_documents WHERE job_id = ?').get(jobId).c, 0,
    'documents must not be left behind pointing at a job that no longer exists');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(uploadDir, filename)), false, 'the PDF is removed from disk');

  cleanup([], [user.id]);
});

test('discarding leaves an audit trail of the draft that existed', async () => {
  const user = makeUser('audited');
  const jobId = makeJob(user.id, 'draft');
  const requestId = getJob(jobId).request_id;

  await request(app).delete(`/api/jobs/${jobId}`).set('Authorization', `Bearer ${tokenFor(user)}`);

  const audit = db.prepare(
    "SELECT action, details FROM audit_logs WHERE entity_type='print_job' AND entity_id = ? AND action='DELETE_PRINT_REQUEST'"
  ).get(jobId);
  assert.ok(audit, 'the discard is recorded even though the row is gone');
  assert.match(audit.details, new RegExp(requestId));

  db.prepare("DELETE FROM audit_logs WHERE entity_type='print_job' AND entity_id = ?").run(jobId);
  cleanup([], [user.id]);
});
