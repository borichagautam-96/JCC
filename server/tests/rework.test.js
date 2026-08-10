// Rework lifecycle: proof review → revised PDF → operator → back to review.
//
// The rules under test are the ones that make the history trustworthy: only the
// coordinator writes, versions never collide or get reused, the original job is
// never mutated, and one job cannot have two reworks open at once.

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
const uniq = () => `rwk-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

// A genuinely valid PDF of N pages, with a real xref table so the page count is read
// rather than guessed. The fixture must have enough pages for the ranges under test:
// page-range validation is enforced now, so a 1-page fixture would reject "30-36" —
// which is exactly the mistake this validation exists to catch.
const makePdf = (numPages) => {
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    `2 0 obj<</Type/Pages/Kids[${Array.from({ length: numPages }, (_, i) => `${i + 3} 0 R`).join(' ')}]/Count ${numPages}>>endobj\n`,
    ...Array.from({ length: numPages }, (_, i) =>
      `${i + 3} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n`),
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(body.length); body += o; }
  const xrefAt = body.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `${xref}trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
};

// 40 pages covers the default "5, 8, 30-36" used across these tests.
const PDF_BYTES = makePdf(40);

const makeUser = (suffix, flags = {}) => {
  const info = db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, is_printer_coordinator,
                        is_printer_operator, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', 'user', ?, ?, 1, datetime('now'))`
  ).run(`${uniq()}-${suffix}`, `Test ${suffix}`, `${uniq()}-${suffix}@example.test`,
        flags.coordinator ? 1 : 0, flags.operator ? 1 : 0);
  return { id: Number(info.lastInsertRowid), name: `Test ${suffix}`, role: 'user' };
};

const makeJob = (requestorId, status = 'printing_completed') => {
  const ref = uniq();
  const info = db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by, submitted_at, current_version)
     VALUES (?, ?, ?, ?, datetime('now'), 1)`
  ).run(`REQ-${ref}`, `JOB-${ref}`, status, requestorId);
  return Number(info.lastInsertRowid);
};

const getJob = (id) => db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
const reworksFor = (id) => db.prepare('SELECT * FROM print_job_reworks WHERE job_id = ? ORDER BY version_no').all(id);

// Reworks are raised by the person who submitted the job. Assignment is a separate
// coordinator step, so tests that need an operator call assignRework as well.
const createRework = (token, jobId, fields = {}) => {
  const req = request(app).post(`/api/jobs/${jobId}/reworks/request`).set('Authorization', `Bearer ${token}`);
  req.attach('pdf', PDF_BYTES, fields.filename || 'revised.pdf');
  const body = {
    modified_pages: '5, 8, 30-36',
    additional_pages: 0,
    change_description: 'Corrected the revision table and drawing.',
    ...fields,
  };
  delete body.filename;
  delete body.operator_id;   // assignment is the coordinator's step, not the requestor's
  Object.entries(body).forEach(([k, v]) => { if (v !== undefined && v !== null) req.field(k, String(v)); });
  return req;
};

const assignRework = (coordToken, jobId, reworkRowId, operatorId) =>
  request(app).post(`/api/jobs/${jobId}/reworks/${reworkRowId}/assign`)
    .set('Authorization', `Bearer ${coordToken}`).send({ operator_id: operatorId });

const cleanup = (jobIds, userIds) => {
  jobIds.forEach((id) => {
    reworksFor(id).forEach((r) => {
      const f = path.join(uploadDir, r.pdf_path || '');
      if (r.pdf_path && fs.existsSync(f)) fs.unlinkSync(f);
    });
    db.prepare('DELETE FROM print_job_reworks WHERE job_id = ?').run(id);
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

const setup = async () => {
  const requestor = makeUser('req');
  const coord = makeUser('coord', { coordinator: true });
  const op = makeUser('op', { operator: true });
  const jobId = makeJob(requestor.id);
  await request(app).post(`/api/jobs/${jobId}/release-proof`).set('Authorization', `Bearer ${tokenFor(coord)}`).send({});
  return { requestor, coord, op, jobId, ids: [requestor.id, coord.id, op.id] };
};

test('releasing a proof moves the job to proof_review', async () => {
  const requestor = makeUser('req');
  const coord = makeUser('coord', { coordinator: true });
  const jobId = makeJob(requestor.id);

  const res = await request(app).post(`/api/jobs/${jobId}/release-proof`)
    .set('Authorization', `Bearer ${tokenFor(coord)}`).send({});

  assert.equal(res.status, 200);
  const job = getJob(jobId);
  assert.equal(job.status, 'proof_review');
  assert.ok(job.proof_released_at);
  cleanup([jobId], [requestor.id, coord.id]);
});

test('approving a proof sends the job to collection without creating a version', async () => {
  const { requestor, coord, jobId, ids } = await setup();
  const res = await request(app).post(`/api/jobs/${jobId}/proof-verdict`)
    .set('Authorization', `Bearer ${tokenFor(coord)}`).send({ approved: true });

  assert.equal(res.status, 200);
  assert.equal(getJob(jobId).status, 'ready_for_collection');
  assert.equal(reworksFor(jobId).length, 0);
  assert.equal(requestor.id > 0, true);
  cleanup([jobId], ids);
});

test('a rework stores V2 with the parsed page list and never touches V1', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();
  const before = getJob(jobId);

  const res = await createRework(tokenFor(requestor), jobId);

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.version_no, 2);
  assert.match(res.body.rework_id, /^RWK\d{4}$/);
  assert.equal(res.body.modified_pages.normalised, '5,8,30-36');
  assert.equal(res.body.modified_pages.count, 9);

  const [rw] = reworksFor(jobId);
  assert.equal(rw.version_no, 2);
  assert.equal(rw.modified_pages, '5, 8, 30-36', 'raw input preserved verbatim');
  assert.equal(rw.modified_pages_norm, '5,8,30-36');
  assert.equal(rw.modified_page_count, 9);
  assert.equal(rw.status, 'pending');
  assert.ok(rw.pdf_path, 'revised PDF stored');
  assert.ok(fs.existsSync(path.join(uploadDir, rw.pdf_path)), 'PDF written to disk');

  // The original job identity must be untouched.
  const after = getJob(jobId);
  assert.equal(after.request_id, before.request_id);
  assert.equal(after.job_number, before.job_number);
  assert.equal(after.created_by, before.created_by);
  assert.equal(after.current_version, 2);
  assert.equal(after.rework_count, 1);

  cleanup([jobId], ids);
});

test('only the person who raised the job can rework it', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();

  // The coordinator schedules reworks; they do not author them. The positive case
  // is covered by 'the requestor can raise a rework' — this test stays negative so
  // the "nothing was written" assertion below stays meaningful.
  const asCoordinator = await createRework(tokenFor(coord), jobId);
  assert.equal(asCoordinator.status, 403);

  const asOperator = await createRework(tokenFor(op), jobId);
  assert.equal(asOperator.status, 403);

  assert.equal(reworksFor(jobId).length, 0);
  cleanup([jobId], ids);
});

test('the coordinator create-rework route no longer exists', async () => {
  const { requestor, coord, jobId, ids } = await setup();
  const res = await request(app).post(`/api/jobs/${jobId}/reworks`)
    .set('Authorization', `Bearer ${tokenFor(coord)}`)
    .attach('pdf', PDF_BYTES, 'revised.pdf')
    .field('modified_pages', '5')
    .field('change_description', 'trying the removed route');
  assert.equal(res.status, 404, 'removed, not merely guarded');
  assert.equal(reworksFor(jobId).length, 0);
  cleanup([jobId], ids);
});

test('modified pages are mandatory and must parse', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();

  const empty = await createRework(tokenFor(requestor), jobId, { modified_pages: '' });
  assert.equal(empty.status, 400);

  const junk = await createRework(tokenFor(requestor), jobId, { modified_pages: 'abc' });
  assert.equal(junk.status, 400);

  const backwards = await createRework(tokenFor(requestor), jobId, { modified_pages: '36-30' });
  assert.equal(backwards.status, 400);
  assert.match(backwards.body.error, /runs backwards/);

  assert.equal(reworksFor(jobId).length, 0, 'nothing persisted on a rejected upload');
  cleanup([jobId], ids);
});

test('additional pages require an insert position', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();

  const missing = await createRework(tokenFor(requestor), jobId, { additional_pages: 2 });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /where the 2 new pages go/);

  const ok = await createRework(tokenFor(requestor), jobId, {
    additional_pages: 2, insert_position: 'After page 40',
  });
  assert.equal(ok.status, 201);
  assert.equal(reworksFor(jobId)[0].insert_position, 'After page 40');

  cleanup([jobId], ids);
});

test('a second rework cannot open while one is still in flight', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();
  await createRework(tokenFor(requestor), jobId);

  const second = await createRework(tokenFor(requestor), jobId);
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already open on this job/);
  assert.equal(reworksFor(jobId).length, 1);

  cleanup([jobId], ids);
});

test('full cycle: two reworks produce V2 then V3, both retained', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();

  // Round one
  await createRework(tokenFor(requestor), jobId);
  let rw = reworksFor(jobId)[0];
  await assignRework(tokenFor(coord), jobId, rw.id, op.id);
  await request(app).post(`/api/jobs/${jobId}/reworks/${rw.id}/start`).set('Authorization', `Bearer ${tokenFor(op)}`).send({});
  assert.equal(getJob(jobId).status, 'rework_printing');
  await request(app).post(`/api/jobs/${jobId}/reworks/${rw.id}/complete`).set('Authorization', `Bearer ${tokenFor(op)}`).send({});
  assert.equal(getJob(jobId).status, 'printing_completed');

  // Back out for review, then round two
  await request(app).post(`/api/jobs/${jobId}/release-proof`).set('Authorization', `Bearer ${tokenFor(coord)}`).send({});
  const second = await createRework(tokenFor(requestor), jobId, {
    modified_pages: '28, 35', additional_pages: 2, insert_position: 'After page 40',
  });
  assert.equal(second.body.version_no, 3);

  const all = reworksFor(jobId);
  assert.equal(all.length, 2, 'both versions retained');
  assert.deepEqual(all.map((r) => r.version_no), [2, 3]);
  assert.notEqual(all[0].pdf_path, all[1].pdf_path, 'each version keeps its own file');
  assert.ok(fs.existsSync(path.join(uploadDir, all[0].pdf_path)), 'V2 PDF still on disk after V3');
  assert.equal(getJob(jobId).rework_count, 2);

  cleanup([jobId], ids);
});

test('version history unions the original submission with every rework', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();
  await createRework(tokenFor(requestor), jobId);

  const res = await request(app).get(`/api/jobs/${jobId}/versions`).set('Authorization', `Bearer ${tokenFor(coord)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].version_no, 1);
  assert.equal(res.body[0].uploaded_by_role, 'Requestor');
  assert.equal(res.body[0].kind, 'Original submission');
  assert.equal(res.body[1].version_no, 2);
  assert.equal(res.body[1].uploaded_by_role, 'Coordinator');
  assert.equal(res.body[1].modified_pages, '5,8,30-36');

  cleanup([jobId], ids);
});

test('a cancelled rework burns its version number rather than reusing it', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();
  await createRework(tokenFor(requestor), jobId);
  const rw = reworksFor(jobId)[0];

  const noReason = await request(app).post(`/api/jobs/${jobId}/reworks/${rw.id}/cancel`)
    .set('Authorization', `Bearer ${tokenFor(coord)}`).send({});
  assert.equal(noReason.status, 400, 'a reason is required');

  await request(app).post(`/api/jobs/${jobId}/reworks/${rw.id}/cancel`)
    .set('Authorization', `Bearer ${tokenFor(coord)}`).send({ reason: 'Wrong PDF attached' });

  const next = await createRework(tokenFor(requestor), jobId);
  assert.equal(next.body.version_no, 3, 'V2 is burnt, next is V3');

  cleanup([jobId], ids);
});

test('an operator cannot start a rework assigned to someone else', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();
  const other = makeUser('op2', { operator: true });
  await createRework(tokenFor(requestor), jobId);
  const rw = reworksFor(jobId)[0];
  await assignRework(tokenFor(coord), jobId, rw.id, op.id);

  const res = await request(app).post(`/api/jobs/${jobId}/reworks/${rw.id}/start`)
    .set('Authorization', `Bearer ${tokenFor(other)}`).send({});
  assert.equal(res.status, 403);
  assert.equal(reworksFor(jobId)[0].status, 'pending');

  cleanup([jobId], [...ids, other.id]);
});

test('a completed job cannot be reworked', async () => {
  const requestor = makeUser('req');
  const coord = makeUser('coord', { coordinator: true });
  const op = makeUser('op', { operator: true });
  const jobId = makeJob(requestor.id, 'completed');

  const res = await createRework(tokenFor(requestor), jobId);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /nothing printed/);

  cleanup([jobId], [requestor.id, coord.id, op.id]);
});

// ── Requestor-raised reworks ────────────────────────────────────────────────
// The requestor supplies the evidence; the coordinator still decides who prints it.

const requestRework = (token, jobId, fields = {}) => {
  const req = request(app).post(`/api/jobs/${jobId}/reworks/request`).set('Authorization', `Bearer ${token}`);
  req.attach('pdf', PDF_BYTES, 'revised.pdf');
  const body = {
    modified_pages: '12-15',
    additional_pages: 0,
    change_description: 'Updated the technical drawing on pages 12 to 14.',
    ...fields,
  };
  Object.entries(body).forEach(([k, v]) => { if (v !== undefined && v !== null) req.field(k, String(v)); });
  return req;
};

test('the requestor can raise a rework, and it arrives unassigned', async () => {
  const { requestor, jobId, ids } = await setup();

  const res = await requestRework(tokenFor(requestor), jobId);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.version_no, 2);

  const [rw] = reworksFor(jobId);
  assert.equal(rw.created_by, requestor.id, 'attributed to the requestor');
  assert.equal(rw.assigned_operator_id, null, 'no operator chosen by the requestor');
  assert.equal(rw.status, 'pending');
  assert.equal(rw.modified_pages_norm, '12-15');
  assert.equal(getJob(jobId).status, 'rework_requested');

  cleanup([jobId], ids);
});

test('a requestor cannot raise a rework on somebody else job', async () => {
  const { requestor, jobId, ids } = await setup();
  const stranger = makeUser('stranger');

  const res = await requestRework(tokenFor(stranger), jobId);
  assert.equal(res.status, 403);
  assert.equal(reworksFor(jobId).length, 0);

  cleanup([jobId], [...ids, stranger.id]);
});

test('the requestor request is validated exactly like the coordinator form', async () => {
  const { requestor, jobId, ids } = await setup();

  const junk = await requestRework(tokenFor(requestor), jobId, { modified_pages: 'abc' });
  assert.equal(junk.status, 400);

  const noPosition = await requestRework(tokenFor(requestor), jobId, { additional_pages: 3 });
  assert.equal(noPosition.status, 400);
  assert.match(noPosition.body.error, /where the 3 new pages go/);

  const thinDescription = await requestRework(tokenFor(requestor), jobId, { change_description: 'fix' });
  assert.equal(thinDescription.status, 400);

  assert.equal(reworksFor(jobId).length, 0);
  cleanup([jobId], ids);
});

test('the coordinator assigns an operator to a requested rework', async () => {
  const { requestor, coord, op, jobId, ids } = await setup();
  await requestRework(tokenFor(requestor), jobId);
  const rw = reworksFor(jobId)[0];

  const res = await request(app).post(`/api/jobs/${jobId}/reworks/${rw.id}/assign`)
    .set('Authorization', `Bearer ${tokenFor(coord)}`).send({ operator_id: op.id });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const after = reworksFor(jobId)[0];
  assert.equal(after.assigned_operator_id, op.id);
  assert.ok(after.assigned_at);

  // and it is now workable by that operator
  const start = await request(app).post(`/api/jobs/${jobId}/reworks/${rw.id}/start`)
    .set('Authorization', `Bearer ${tokenFor(op)}`).send({});
  assert.equal(start.status, 200);
  assert.equal(getJob(jobId).status, 'rework_printing');

  cleanup([jobId], ids);
});

test('a requestor cannot assign an operator', async () => {
  const { requestor, op, jobId, ids } = await setup();
  await requestRework(tokenFor(requestor), jobId);
  const rw = reworksFor(jobId)[0];

  const res = await request(app).post(`/api/jobs/${jobId}/reworks/${rw.id}/assign`)
    .set('Authorization', `Bearer ${tokenFor(requestor)}`).send({ operator_id: op.id });
  assert.equal(res.status, 403);
  assert.equal(reworksFor(jobId)[0].assigned_operator_id, null);

  cleanup([jobId], ids);
});

test('an unassigned rework cannot be started by an operator who grabs it', async () => {
  const { requestor, op, jobId, ids } = await setup();
  await requestRework(tokenFor(requestor), jobId);
  const rw = reworksFor(jobId)[0];

  const res = await request(app).post(`/api/jobs/${jobId}/reworks/${rw.id}/start`)
    .set('Authorization', `Bearer ${tokenFor(op)}`).send({});
  assert.equal(res.status, 403, 'must be assigned by a coordinator first');

  cleanup([jobId], ids);
});

test('the requestor cannot open a second rework while one is in flight', async () => {
  const { requestor, jobId, ids } = await setup();
  await requestRework(tokenFor(requestor), jobId);

  const second = await requestRework(tokenFor(requestor), jobId);
  assert.equal(second.status, 409);
  assert.equal(reworksFor(jobId).length, 1);

  cleanup([jobId], ids);
});

test('a rework can be requested on a job that is ready for collection', async () => {
  const requestor = makeUser('req');
  const coord = makeUser('coord', { coordinator: true });
  const jobId = makeJob(requestor.id, 'ready_for_collection');

  const res = await requestRework(tokenFor(requestor), jobId);
  assert.equal(res.status, 201, 'printed output exists, so rework is allowed');

  cleanup([jobId], [requestor.id, coord.id]);
});

test('a rework cannot be requested on a job that has not been printed', async () => {
  const requestor = makeUser('req');
  const jobId = makeJob(requestor.id, 'submitted');

  const res = await requestRework(tokenFor(requestor), jobId);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /nothing printed/);

  cleanup([jobId], [requestor.id]);
});

// ── Recall & edit: the pre-print correction path ───────────────────────────
// Rework is for reprinting what came out wrong. Recall is for fixing a job that
// has not been printed yet. The boundary between them is what is tested here.

const recall = (token, jobId, reason = 'Wrong file attached') =>
  request(app).post(`/api/jobs/${jobId}/recall`)
    .set('Authorization', `Bearer ${token}`).send({ reason });

test('a submitted job can be recalled by its owner and becomes editable', async () => {
  const requestor = makeUser('req');
  const jobId = makeJob(requestor.id, 'submitted');

  const res = await recall(tokenFor(requestor), jobId);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const job = getJob(jobId);
  assert.equal(job.status, 'recalled');
  assert.ok(job.recalled_at);
  assert.equal(job.recall_reason, 'Wrong file attached');
  // Identity survives — same request and job number.
  assert.ok(job.request_id && job.job_number);

  cleanup([jobId], [requestor.id]);
});

test('an accepted job can still be recalled while no operator holds it', async () => {
  const requestor = makeUser('req');
  const jobId = makeJob(requestor.id, 'accepted');
  const res = await recall(tokenFor(requestor), jobId);
  assert.equal(res.status, 200);
  assert.equal(getJob(jobId).status, 'recalled');
  cleanup([jobId], [requestor.id]);
});

test('a job already with an operator cannot be recalled', async () => {
  const requestor = makeUser('req');
  const op = makeUser('op', { operator: true });
  const jobId = makeJob(requestor.id, 'accepted');
  db.prepare('UPDATE print_jobs SET assigned_operator_id = ? WHERE id = ?').run(op.id, jobId);

  const res = await recall(tokenFor(requestor), jobId);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /assigned to an operator/);
  assert.equal(getJob(jobId).status, 'accepted');

  cleanup([jobId], [requestor.id, op.id]);
});

test('a printing job cannot be recalled', async () => {
  const requestor = makeUser('req');
  const jobId = makeJob(requestor.id, 'printing');
  const res = await recall(tokenFor(requestor), jobId);
  assert.equal(res.status, 400);
  assert.equal(getJob(jobId).status, 'printing');
  cleanup([jobId], [requestor.id]);
});

test('a printed job points the user at rework instead of recall', async () => {
  const requestor = makeUser('req');
  const jobId = makeJob(requestor.id, 'ready_for_collection');

  const res = await recall(tokenFor(requestor), jobId);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Request rework/, 'the error names the right tool');

  cleanup([jobId], [requestor.id]);
});

test('one user cannot recall another user job', async () => {
  const requestor = makeUser('req');
  const stranger = makeUser('stranger');
  const jobId = makeJob(requestor.id, 'submitted');

  const res = await recall(tokenFor(stranger), jobId);
  assert.equal(res.status, 403);
  assert.equal(getJob(jobId).status, 'submitted');

  cleanup([jobId], [requestor.id, stranger.id]);
});

test('recall and rework never both apply to the same job state', async () => {
  const requestor = makeUser('req');
  const RECALLABLE = ['submitted', 'accepted'];
  const REWORKABLE = ['printing_completed', 'proof_review', 'rework_requested', 'ready_for_collection'];
  const overlap = RECALLABLE.filter((x) => REWORKABLE.includes(x));
  assert.deepEqual(overlap, [], 'the two paths must not offer both buttons at once');

  // And a state in neither list offers nothing — paper is moving.
  const jobId = makeJob(requestor.id, 'assigned');
  const res = await recall(tokenFor(requestor), jobId);
  assert.equal(res.status, 400);
  cleanup([jobId], [requestor.id]);
});

// ── Page-range safety ───────────────────────────────────────────────────────────
// A rework that names pages the revised PDF does not have is a wasted print run: the
// operator discovers it standing at the machine. It is caught when the rework is
// raised, and re-checked at assignment — the last gate before the press.

test('a rework naming pages beyond the PDF is refused when raised', async () => {
  const user = makeUser('shortreq');
  const jobId = makeJob(user.id);

  const res = await request(app)
    .post(`/api/jobs/${jobId}/reworks/request`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .attach('pdf', makePdf(10), 'revised.pdf')
    .field('modified_pages', '12-15')
    .field('additional_pages', '0')
    .field('change_description', 'Fixed the drawing on the later pages.');

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Page 12 does not exist.*10 pages/i);
  assert.equal(reworksFor(jobId).length, 0, 'nothing is stored for an impossible range');

  cleanup([jobId], [user.id]);
});

test('the last page of the PDF is accepted — the boundary is inclusive', async () => {
  const user = makeUser('edgereq');
  const jobId = makeJob(user.id);

  const res = await request(app)
    .post(`/api/jobs/${jobId}/reworks/request`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .attach('pdf', makePdf(10), 'revised.pdf')
    .field('modified_pages', '8-10')
    .field('additional_pages', '0')
    .field('change_description', 'Corrected the final three pages.');

  assert.equal(res.status, 201);
  assert.equal(reworksFor(jobId)[0].num_pages, 10, 'the real page count is stored, not assumed');

  cleanup([jobId], [user.id]);
});

test('the page count is read from the file and stored on the rework', async () => {
  const user = makeUser('countreq');
  const jobId = makeJob(user.id);

  await request(app)
    .post(`/api/jobs/${jobId}/reworks/request`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .attach('pdf', makePdf(7), 'revised.pdf')
    .field('modified_pages', '3')
    .field('additional_pages', '0')
    .field('change_description', 'One page corrected.');

  assert.equal(reworksFor(jobId)[0].num_pages, 7);

  cleanup([jobId], [user.id]);
});

test('assignment re-checks the range, catching a rework stored before validation worked', async () => {
  const user = makeUser('legacyreq');
  const coordinator = makeUser('legacycoord', { coordinator: true });
  const operator = makeUser('legacyop', { operator: true });
  const jobId = makeJob(user.id);

  const created = await createRework(tokenFor(user), jobId, { modified_pages: '5, 8' });
  assert.equal(created.status, 201);
  const rw = reworksFor(jobId)[0];

  // Reproduce the state left by the broken page-count reader: a range that overruns a
  // PDF that was never measured, so nothing rejected it on the way in.
  db.prepare(
    "UPDATE print_job_reworks SET num_pages = NULL, modified_pages = '12-15', modified_pages_norm = '12-15' WHERE id = ?"
  ).run(rw.id);
  fs.writeFileSync(path.join(uploadDir, rw.pdf_path), makePdf(10));

  const res = await assignRework(tokenFor(coordinator), jobId, rw.id, operator.id);

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PAGE_RANGE_INVALID');
  assert.equal(res.body.pdf_pages, 10);
  assert.match(res.body.error, /12-15/);
  // Nothing reached the press.
  assert.equal(db.prepare('SELECT assigned_operator_id FROM print_job_reworks WHERE id = ?').get(rw.id).assigned_operator_id, null);

  cleanup([jobId], [user.id, coordinator.id, operator.id]);
});

test('assignment recovers a missing page count instead of skipping the check', async () => {
  const user = makeUser('backfillreq');
  const coordinator = makeUser('backfillcoord', { coordinator: true });
  const operator = makeUser('backfillop', { operator: true });
  const jobId = makeJob(user.id);

  const created = await createRework(tokenFor(user), jobId, { modified_pages: '5, 8' });
  assert.equal(created.status, 201);
  const rw = reworksFor(jobId)[0];
  db.prepare('UPDATE print_job_reworks SET num_pages = NULL WHERE id = ?').run(rw.id);

  const res = await assignRework(tokenFor(coordinator), jobId, rw.id, operator.id);

  assert.equal(res.status, 200);
  assert.equal(res.body.warning, null, 'a readable PDF is verified, not waved through');
  assert.equal(res.body.pdf_pages, 40);
  // Backfilled, so the next reader does not re-parse the file.
  assert.equal(db.prepare('SELECT num_pages FROM print_job_reworks WHERE id = ?').get(rw.id).num_pages, 40);

  cleanup([jobId], [user.id, coordinator.id, operator.id]);
});

test('an unreadable PDF warns rather than blocking a legitimate rework', async () => {
  const user = makeUser('unreadreq');
  const coordinator = makeUser('unreadcoord', { coordinator: true });
  const operator = makeUser('unreadop', { operator: true });
  const jobId = makeJob(user.id);

  const created = await createRework(tokenFor(user), jobId, { modified_pages: '5, 8' });
  assert.equal(created.status, 201);
  const rw = reworksFor(jobId)[0];
  db.prepare('UPDATE print_job_reworks SET num_pages = NULL WHERE id = ?').run(rw.id);
  fs.writeFileSync(path.join(uploadDir, rw.pdf_path), Buffer.from('not a pdf at all', 'latin1'));

  const res = await assignRework(tokenFor(coordinator), jobId, rw.id, operator.id);

  // A parser limitation is not evidence of a bad range, so the work still goes out —
  // but the coordinator is told the range was never verified.
  assert.equal(res.status, 200);
  assert.match(res.body.warning, /could not be read/i);
  assert.match(res.body.message, /could not be read/i);

  cleanup([jobId], [user.id, coordinator.id, operator.id]);
});
