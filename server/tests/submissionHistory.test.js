// End-to-end: submit → recall → edit → resubmit, and check the history records
// what actually changed. The diff engine has its own unit tests; this covers the
// wiring — that snapshots are written at the right moment, with the right trigger,
// and that the API hands back a usable comparison.

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
const uniq = () => `sub-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

const pdf = (marker) => Buffer.from(
  `%PDF-1.4\n% ${marker}\n` +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

const makeUser = (suffix, flags = {}) => {
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, is_printer_coordinator,
                        profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', 'user', ?, 1, datetime('now'))`
  ).run(`${uniq()}-${suffix}`, `Test ${suffix}`, `${uniq()}-${suffix}@example.test`, flags.coordinator ? 1 : 0);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role: 'user' };
};

const makeDraft = (userId) => {
  const ref = uniq();
  const info = db.prepare(
    `INSERT INTO print_jobs (request_id, status, created_by, debit_code, project_name, department_name)
     VALUES (?, 'draft', ?, '3559', 'Substation Manuals', 'PES D&T')`
  ).run(`REQ-${ref}`, userId);
  return Number(info.lastInsertRowid);
};

const addDoc = (token, jobId, fields, marker) => {
  const r = request(app).post(`/api/jobs/${jobId}/documents`).set('Authorization', `Bearer ${token}`);
  r.attach('pdf', pdf(marker), `${marker}.pdf`);
  // Full spec, as the real form always sends — otherwise the first snapshot has
  // blank fields and every later edit reads as "— → value".
  Object.entries({
    document_name: 'Commissioning Manual', quantity: 1, num_pages: 40,
    print_side: 'Double-sided', paper_size: 'A4', paper_gsm: '80',
    color_mode: 'Black & White', binding_type: 'Spiral',
    ...fields,
  }).forEach(([k, v]) => r.field(k, String(v)));
  return r;
};

const submit = (token, jobId) =>
  request(app).post(`/api/jobs/${jobId}/submit`).set('Authorization', `Bearer ${token}`).send({});

const submissions = (token, jobId) =>
  request(app).get(`/api/jobs/${jobId}/submissions`).set('Authorization', `Bearer ${token}`);

const cleanup = (jobIds, userIds) => {
  jobIds.forEach((id) => {
    db.prepare('SELECT pdf_path FROM print_job_documents WHERE job_id = ?').all(id).forEach((d) => {
      const f = path.join(uploadDir, d.pdf_path || '');
      if (d.pdf_path && fs.existsSync(f)) fs.unlinkSync(f);
    });
    db.prepare('DELETE FROM print_job_submissions WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM print_job_documents WHERE job_id = ?').run(id);
    db.prepare("DELETE FROM audit_logs WHERE entity_type='print_job' AND entity_id = ?").run(id);
    db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id);
  });
  userIds.forEach((id) => {
    ['notifications', 'audit_logs', 'user_activity_logs'].forEach((t) =>
      db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id));
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
};

test('the first submit records submission 1 as the initial one', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'v1');

  const res = await submit(tokenFor(user), jobId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.submission_seq, 1);
  assert.equal(res.body.change_count, null, 'nothing to compare against yet');

  const hist = await submissions(tokenFor(user), jobId);
  assert.equal(hist.body.submissions.length, 1);
  assert.equal(hist.body.submissions[0].triggerKind, 'initial');
  assert.equal(hist.body.submissions[0].diff, null);
  assert.equal(hist.body.submissions[0].summary, 'Initial submission');
  assert.deepEqual(hist.body.submissions[0].totals, { books: 1, copies: 1, pages: 40 });

  cleanup([jobId], [user.id]);
});

test('recall, change the spec, resubmit — the diff names what moved', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'v1');
  await submit(tokenFor(user), jobId);

  await request(app).post(`/api/jobs/${jobId}/recall`).set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({ reason: 'Wrong binding and paper' });

  // Edit: swap the binding and paper on the existing document, bump copies.
  const doc = db.prepare('SELECT id FROM print_job_documents WHERE job_id = ?').get(jobId);
  db.prepare("UPDATE print_job_documents SET binding_type='Wiro', paper_gsm='100', quantity=2 WHERE id=?").run(doc.id);

  const res = await submit(tokenFor(user), jobId);
  assert.equal(res.status, 200);
  assert.equal(res.body.submission_seq, 2);
  assert.equal(res.body.change_count, 3, 'binding, paper, copies');

  const hist = await submissions(tokenFor(user), jobId);
  const second = hist.body.submissions[1];
  assert.equal(second.triggerKind, 'after_recall');
  assert.equal(second.triggerReason, 'Wrong binding and paper');

  const labels = second.diff.documentChanges[0].fieldChanges.map((f) => f.label).sort();
  assert.deepEqual(labels, ['Binding', 'Copies', 'Paper (gsm)']);
  // 40 pages x 1 copy → 40 pages x 2 copies
  assert.deepEqual(second.diff.totals.pages, { from: 40, to: 80, delta: 40 });
  assert.deepEqual(second.diff.totals.copies, { from: 1, to: 2, delta: 1 });

  cleanup([jobId], [user.id]);
});

test('adding a document on resubmit shows up as an addition with page totals', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'v1');
  await submit(tokenFor(user), jobId);
  await request(app).post(`/api/jobs/${jobId}/recall`).set('Authorization', `Bearer ${tokenFor(user)}`).send({ reason: 'Missing annexure' });

  await addDoc(tokenFor(user), jobId, { document_name: 'Annexure B', num_pages: 12 }, 'annexb');
  const res = await submit(tokenFor(user), jobId);
  assert.equal(res.status, 200);

  const hist = await submissions(tokenFor(user), jobId);
  const d = hist.body.submissions[1].diff;
  const added = d.documentChanges.filter((c) => c.kind === 'added');
  assert.equal(added.length, 1);
  assert.equal(added[0].documentName, 'Annexure B');
  assert.deepEqual(d.totals.books, { from: 1, to: 2, delta: 1 });
  assert.deepEqual(d.totals.pages, { from: 40, to: 52, delta: 12 });
  assert.match(hist.body.submissions[1].summary, /\+1 document/);

  cleanup([jobId], [user.id]);
});

test('a replaced PDF is detected even when every spec is identical', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'original');
  await submit(tokenFor(user), jobId);
  await request(app).post(`/api/jobs/${jobId}/recall`).set('Authorization', `Bearer ${tokenFor(user)}`).send({ reason: 'Wrong revision attached' });

  // Replace the file: delete and re-add the same document with different bytes.
  const doc = db.prepare('SELECT id FROM print_job_documents WHERE job_id = ?').get(jobId);
  await request(app).delete(`/api/jobs/${jobId}/documents/${doc.id}`).set('Authorization', `Bearer ${tokenFor(user)}`);
  await addDoc(tokenFor(user), jobId, {}, 'corrected');

  await submit(tokenFor(user), jobId);
  const hist = await submissions(tokenFor(user), jobId);
  const d = hist.body.submissions[1].diff;
  assert.equal(d.documentChanges.length, 1);
  assert.equal(d.documentChanges[0].pdfReplaced, true, 'hash difference caught it');
  assert.equal(d.totals.pages.delta, 0, 'nothing else moved');

  cleanup([jobId], [user.id]);
});

test('a resubmit with no edits reports no changes', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'v1');
  await submit(tokenFor(user), jobId);
  await request(app).post(`/api/jobs/${jobId}/recall`).set('Authorization', `Bearer ${tokenFor(user)}`).send({ reason: 'Changed my mind' });

  const res = await submit(tokenFor(user), jobId);
  assert.equal(res.body.change_count, 0);
  const hist = await submissions(tokenFor(user), jobId);
  assert.equal(hist.body.submissions[1].diff.isNoOp, true);
  assert.equal(hist.body.submissions[1].summary, 'no changes');

  cleanup([jobId], [user.id]);
});

test('a header field change is recorded across a recall', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'v1');
  await submit(tokenFor(user), jobId);
  await request(app).post(`/api/jobs/${jobId}/recall`).set('Authorization', `Bearer ${tokenFor(user)}`).send({ reason: 'Wrong debit code' });

  db.prepare("UPDATE print_jobs SET debit_code='3612' WHERE id=?").run(jobId);
  await submit(tokenFor(user), jobId);

  const hist = await submissions(tokenFor(user), jobId);
  const hc = hist.body.submissions[1].diff.headerChanges;
  assert.equal(hc.length, 1);
  assert.deepEqual(hc[0], { field: 'debit_code', label: 'Debit code', from: '3559', to: '3612' });

  cleanup([jobId], [user.id]);
});

test('any two submissions can be compared directly', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'v1');
  await submit(tokenFor(user), jobId);

  for (const gsm of ['90', '100']) {
    await request(app).post(`/api/jobs/${jobId}/recall`).set('Authorization', `Bearer ${tokenFor(user)}`).send({ reason: 'tweak' });
    db.prepare('UPDATE print_job_documents SET paper_gsm=? WHERE job_id=?').run(gsm, jobId);
    await submit(tokenFor(user), jobId);
  }

  // 1 → 3 skips the intermediate step and still reports one net change.
  const res = await request(app).get(`/api/jobs/${jobId}/submissions/1/diff/3`)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
  assert.equal(res.status, 200);
  const fc = res.body.diff.documentChanges[0].fieldChanges;
  assert.deepEqual(fc[0], { field: 'paper_gsm', label: 'Paper (gsm)', from: '80', to: '100' });

  const missing = await request(app).get(`/api/jobs/${jobId}/submissions/1/diff/9`)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
  assert.equal(missing.status, 404);

  cleanup([jobId], [user.id]);
});

test('someone else cannot read a job submission history', async () => {
  const user = makeUser('req');
  const stranger = makeUser('stranger');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'v1');
  await submit(tokenFor(user), jobId);

  const res = await submissions(tokenFor(stranger), jobId);
  assert.equal(res.status, 403);

  cleanup([jobId], [user.id, stranger.id]);
});

test('a coordinator can read the history of a job they verify', async () => {
  const user = makeUser('req');
  const coord = makeUser('coord', { coordinator: true });
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'v1');
  await submit(tokenFor(user), jobId);

  const res = await submissions(tokenFor(coord), jobId);
  assert.equal(res.status, 200);
  assert.equal(res.body.submissions.length, 1);

  cleanup([jobId], [user.id, coord.id]);
});

// ── Replacing a document's PDF ──────────────────────────────────────────────
// The correction path. Before this existed the only option was Delete + Add, which
// left a recalled job carrying both the old and the corrected file.

const replacePdf = (token, jobId, docId, marker) =>
  request(app).put(`/api/jobs/${jobId}/documents/${docId}/file`)
    .set('Authorization', `Bearer ${token}`)
    .attach('pdf', pdf(marker), `${marker}.pdf`);

test('replacing a PDF keeps one document, not two', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'original');
  await submit(tokenFor(user), jobId);
  await request(app).post(`/api/jobs/${jobId}/recall`).set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({ reason: 'Wrong revision' });

  const doc = db.prepare('SELECT * FROM print_job_documents WHERE job_id = ?').get(jobId);
  const before = doc.pdf_path;

  const res = await replacePdf(tokenFor(user), jobId, doc.id, 'corrected');
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const docs = db.prepare('SELECT * FROM print_job_documents WHERE job_id = ?').all(jobId);
  assert.equal(docs.length, 1, 'still exactly one document');
  assert.equal(docs[0].id, doc.id, 'same row');
  assert.equal(docs[0].document_name, doc.document_name, 'name preserved');
  assert.equal(docs[0].binding_type, doc.binding_type, 'specs preserved');
  assert.notEqual(docs[0].pdf_path, before, 'file swapped');
  assert.notEqual(docs[0].pdf_sha256, doc.pdf_sha256, 'hash changed');

  // The superseded file stays on disk so the earlier submission is retrievable.
  assert.ok(fs.existsSync(path.join(uploadDir, before)), 'old file retained');

  cleanup([jobId], [user.id]);
});

test('after replacing, the resubmit diff says PDF replaced and not +1 document', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'original');
  await submit(tokenFor(user), jobId);
  await request(app).post(`/api/jobs/${jobId}/recall`).set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({ reason: 'Wrong revision' });

  const doc = db.prepare('SELECT id FROM print_job_documents WHERE job_id = ?').get(jobId);
  await replacePdf(tokenFor(user), jobId, doc.id, 'corrected');
  await submit(tokenFor(user), jobId);

  const hist = await submissions(tokenFor(user), jobId);
  const d = hist.body.submissions[1].diff;
  assert.equal(d.totals.books.delta, 0, 'document count unchanged');
  assert.equal(d.documentChanges.length, 1);
  assert.equal(d.documentChanges[0].kind, 'pdf_replaced');
  assert.equal(d.documentChanges[0].pdfReplaced, true);

  cleanup([jobId], [user.id]);
});

test('re-uploading the identical file is refused', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'same');
  const doc = db.prepare('SELECT id FROM print_job_documents WHERE job_id = ?').get(jobId);

  const res = await replacePdf(tokenFor(user), jobId, doc.id, 'same');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /same file/);

  cleanup([jobId], [user.id]);
});

test('a PDF cannot be replaced once the job has left the editable states', async () => {
  const user = makeUser('req');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'original');
  await submit(tokenFor(user), jobId);   // now 'submitted', no longer editable

  const doc = db.prepare('SELECT id FROM print_job_documents WHERE job_id = ?').get(jobId);
  const res = await replacePdf(tokenFor(user), jobId, doc.id, 'corrected');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no longer be edited/);

  cleanup([jobId], [user.id]);
});

test('one user cannot replace a PDF on another user job', async () => {
  const user = makeUser('req');
  const stranger = makeUser('stranger');
  const jobId = makeDraft(user.id);
  await addDoc(tokenFor(user), jobId, {}, 'original');
  const doc = db.prepare('SELECT id FROM print_job_documents WHERE job_id = ?').get(jobId);

  const res = await replacePdf(tokenFor(stranger), jobId, doc.id, 'corrected');
  assert.equal(res.status, 403);

  cleanup([jobId], [user.id, stranger.id]);
});
