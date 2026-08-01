// Receipt confirmation on printing jobs.
//
// The rule under test: a coordinator can record that they handed materials over,
// but only the requestor who raised the job can state that they were received.
// Handover must therefore never reach 'completed' on its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import db from '../database.js';
import jobsRouter from '../routes/jobs.js';
import { JWT_SECRET } from '../middleware/auth.js';

const app = express();
app.use(express.json());
app.use('/api/jobs', jobsRouter);

// Tokens carry no session_token, so the middleware skips session validation.
const tokenFor = (user) => jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET);

const uniq = () => `rcpt-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

// profile_completed / profile_verified_at are required or authenticateToken
// rejects every request with PROFILE_INCOMPLETE before the route is reached.
const makeUser = (suffix, { coordinator = false } = {}) => {
  const info = db
    .prepare(
      `INSERT INTO users (ps_number, name, email, password, role, is_printer_coordinator,
                          profile_completed, profile_verified_at)
       VALUES (?, ?, ?, 'x', 'user', ?, 1, datetime('now'))`
    )
    .run(`${uniq()}-${suffix}`, `Test ${suffix}`, `${uniq()}-${suffix}@example.test`, coordinator ? 1 : 0);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role: 'user' };
};

const makeReadyJob = (requestorId) => {
  const ref = uniq();
  const info = db
    .prepare(
      `INSERT INTO print_jobs (request_id, job_number, status, created_by, ready_at)
       VALUES (?, ?, 'ready_for_collection', ?, datetime('now'))`
    )
    .run(`REQ-${ref}`, `JOB-${ref}`, requestorId);
  return Number(info.lastInsertRowid);
};

const getJob = (id) => db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);

const cleanup = (jobIds, userIds) => {
  jobIds.forEach((id) => db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id));
  userIds.forEach((id) => {
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
};

test('handover parks the job at awaiting_receipt instead of completing it', async () => {
  const requestor = makeUser('req');
  const coordinator = makeUser('coord', { coordinator: true });
  const jobId = makeReadyJob(requestor.id);

  const res = await request(app)
    .post(`/api/jobs/${jobId}/collect`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`)
    .send({});

  assert.equal(res.status, 200);
  const job = getJob(jobId);
  assert.equal(job.status, 'awaiting_receipt');
  assert.equal(job.handed_over_by, coordinator.name);
  assert.ok(job.handed_over_at, 'handover timestamp recorded');
  // The whole point: nothing yet claims the materials were received.
  assert.equal(job.completed_at, null);
  assert.equal(job.received_at, null);
  assert.equal(job.received_by, null);

  cleanup([jobId], [requestor.id, coordinator.id]);
});

test('the coordinator cannot confirm receipt on the requestor behalf', async () => {
  const requestor = makeUser('req');
  const coordinator = makeUser('coord', { coordinator: true });
  const jobId = makeReadyJob(requestor.id);

  await request(app)
    .post(`/api/jobs/${jobId}/collect`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`)
    .send({});

  const res = await request(app)
    .post(`/api/jobs/${jobId}/confirm-receipt`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`)
    .send({});

  assert.equal(res.status, 403);
  assert.equal(getJob(jobId).status, 'awaiting_receipt', 'job stays open');

  cleanup([jobId], [requestor.id, coordinator.id]);
});

test('an unrelated user cannot confirm receipt', async () => {
  const requestor = makeUser('req');
  const coordinator = makeUser('coord', { coordinator: true });
  const stranger = makeUser('stranger');
  const jobId = makeReadyJob(requestor.id);

  await request(app)
    .post(`/api/jobs/${jobId}/collect`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`)
    .send({});

  const res = await request(app)
    .post(`/api/jobs/${jobId}/confirm-receipt`)
    .set('Authorization', `Bearer ${tokenFor(stranger)}`)
    .send({});

  assert.equal(res.status, 403);
  assert.equal(getJob(jobId).status, 'awaiting_receipt');

  cleanup([jobId], [requestor.id, coordinator.id, stranger.id]);
});

test('the requestor confirming receipt closes the job and records who received it', async () => {
  const requestor = makeUser('req');
  const coordinator = makeUser('coord', { coordinator: true });
  const jobId = makeReadyJob(requestor.id);

  await request(app)
    .post(`/api/jobs/${jobId}/collect`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`)
    .send({});

  const res = await request(app)
    .post(`/api/jobs/${jobId}/confirm-receipt`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`)
    .send({});

  assert.equal(res.status, 200);
  const job = getJob(jobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.received_by, requestor.name);
  assert.equal(job.received_by_user_id, requestor.id);
  assert.ok(job.received_at, 'receipt timestamp recorded');
  assert.ok(job.completed_at, 'completion timestamp recorded');

  cleanup([jobId], [requestor.id, coordinator.id]);
});

test('receipt cannot be confirmed twice, or before handover', async () => {
  const requestor = makeUser('req');
  const coordinator = makeUser('coord', { coordinator: true });
  const jobId = makeReadyJob(requestor.id);

  // Before handover the job is still ready_for_collection.
  const early = await request(app)
    .post(`/api/jobs/${jobId}/confirm-receipt`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`)
    .send({});
  assert.equal(early.status, 400);

  await request(app)
    .post(`/api/jobs/${jobId}/collect`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`)
    .send({});
  await request(app)
    .post(`/api/jobs/${jobId}/confirm-receipt`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`)
    .send({});

  const again = await request(app)
    .post(`/api/jobs/${jobId}/confirm-receipt`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`)
    .send({});
  assert.equal(again.status, 400);

  cleanup([jobId], [requestor.id, coordinator.id]);
});

test('a handed-over job appears on the coordinator awaiting-receipt list', async () => {
  const requestor = makeUser('req');
  const coordinator = makeUser('coord', { coordinator: true });
  const jobId = makeReadyJob(requestor.id);

  await request(app)
    .post(`/api/jobs/${jobId}/collect`)
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`)
    .send({});

  const res = await request(app)
    .get('/api/jobs/awaiting-receipt')
    .set('Authorization', `Bearer ${tokenFor(coordinator)}`);

  assert.equal(res.status, 200);
  assert.ok(res.body.some((j) => j.id === jobId), 'job is chaseable by the coordinator');

  cleanup([jobId], [requestor.id, coordinator.id]);
});
