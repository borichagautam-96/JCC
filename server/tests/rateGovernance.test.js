// Segregation of duties on the rate master.
//
// An approved rate card prices every job that follows it, so whoever imports or edits
// a card must not be the one who puts it in force.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import db from '../database.js';
import ratesRouter from '../routes/rates.js';
import { JWT_SECRET } from '../middleware/auth.js';

const app = express();
app.use(express.json());
app.use('/api/rates', ratesRouter);

const tokenFor = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
const uniq = () => `gov-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

const makeUser = (suffix, { coordinator = false, approver = false, operator = false } = {}) => {
  const ref = `${uniq()}-${suffix}`;
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, is_printer_coordinator,
                        is_printer_operator, is_rate_approver, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', 'user', ?, ?, ?, 1, datetime('now'))`
  ).run(ref, `Test ${suffix}`, `${ref}@example.test`,
        coordinator ? 1 : 0, operator ? 1 : 0, approver ? 1 : 0);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role: 'user' };
};

const makeDraftCard = (preparedBy) => {
  const code = `RC-T-${uniq()}`.toUpperCase();
  const id = Number(db.prepare(
    `INSERT INTO rate_versions (code, label, status, effective_from)
     VALUES (?, 'Test card', 'draft', date('now'))`
  ).run(code).lastInsertRowid);
  if (preparedBy) {
    db.prepare("INSERT INTO rate_card_activity (version_id, user_id, action) VALUES (?,?,'import')")
      .run(id, preparedBy);
  }
  return { id, code };
};

const cleanupCards = (ids) => ids.forEach((id) => {
  db.prepare('DELETE FROM rate_card_activity WHERE version_id = ?').run(id);
  db.prepare('DELETE FROM rate_lines WHERE version_id = ?').run(id);
  db.prepare('DELETE FROM rate_versions WHERE id = ?').run(id);
});
const cleanupUsers = (ids) => ids.forEach((id) => {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
});

// ── Segregation of duties ───────────────────────────────────────────────────────

test('the coordinator who prepared a card cannot approve it', async () => {
  // The dangerous account: holds both rights at once.
  const both = makeUser('both', { coordinator: true, approver: true });
  const card = makeDraftCard(both.id);

  const res = await request(app)
    .post(`/api/rates/versions/${card.code}/approve`)
    .set('Authorization', `Bearer ${tokenFor(both)}`).send({});

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'SEGREGATION_OF_DUTIES');
  assert.equal(db.prepare('SELECT status FROM rate_versions WHERE id = ?').get(card.id).status, 'draft');

  cleanupCards([card.id]);
  cleanupUsers([both.id]);
});

test('a coordinator who is not a designated approver cannot approve at all', async () => {
  const preparer = makeUser('prep', { coordinator: true });
  const other = makeUser('coordonly', { coordinator: true });
  const card = makeDraftCard(preparer.id);

  const res = await request(app)
    .post(`/api/rates/versions/${card.code}/approve`)
    .set('Authorization', `Bearer ${tokenFor(other)}`).send({});

  assert.equal(res.status, 403);
  assert.match(res.body.error, /designated rate approver/i);

  cleanupCards([card.id]);
  cleanupUsers([preparer.id, other.id]);
});

test('a designated approver who did not touch the card can approve it', async () => {
  const preparer = makeUser('prep2', { coordinator: true });
  const approver = makeUser('appr2', { approver: true });
  const card = makeDraftCard(preparer.id);

  const res = await request(app)
    .post(`/api/rates/versions/${card.code}/approve`)
    .set('Authorization', `Bearer ${tokenFor(approver)}`).send({});

  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status, approved_by FROM rate_versions WHERE id = ?').get(card.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.approved_by, approver.id);

  cleanupCards([card.id]);
  cleanupUsers([preparer.id, approver.id]);
});

test('editing a rate makes you a preparer, even if someone else imported it', async () => {
  const importer = makeUser('imp', { coordinator: true });
  // Holds both rights: could import, but here only edits — and must still be excluded.
  const editor = makeUser('edit', { coordinator: true, approver: true });
  const card = makeDraftCard(importer.id);

  db.prepare(
    `INSERT INTO service_items (code, label, cost_group, uom) VALUES (?, 'Edit svc', 'printing', 'nos')
     ON CONFLICT(code) DO NOTHING`
  ).run(`SVC-${card.code}`);
  const lineId = Number(db.prepare(
    'INSERT INTO rate_lines (version_id, service_code, rate_milli) VALUES (?,?,1000)'
  ).run(card.id, `SVC-${card.code}`).lastInsertRowid);

  const edit = await request(app)
    .patch(`/api/rates/versions/${card.code}/lines/${lineId}`)
    .set('Authorization', `Bearer ${tokenFor(editor)}`).send({ rate: '9.5' });
  assert.equal(edit.status, 200);

  const res = await request(app)
    .post(`/api/rates/versions/${card.code}/approve`)
    .set('Authorization', `Bearer ${tokenFor(editor)}`).send({});
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'SEGREGATION_OF_DUTIES');

  cleanupCards([card.id]);
  db.prepare('DELETE FROM service_items WHERE code = ?').run(`SVC-${card.code}`);
  cleanupUsers([importer.id, editor.id]);
});

test('the card view explains why approval is unavailable', async () => {
  const both = makeUser('why', { coordinator: true, approver: true });
  const card = makeDraftCard(both.id);

  const res = await request(app)
    .get(`/api/rates/versions/${card.code}/lines`)
    .set('Authorization', `Bearer ${tokenFor(both)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.can_approve, false);
  assert.equal(res.body.approval_block, 'you_prepared_it');
  assert.ok(res.body.prepared_by.includes(both.name));

  cleanupCards([card.id]);
  cleanupUsers([both.id]);
});
