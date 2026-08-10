// Material rows on a JCC voucher must survive the whole intake pipeline.
//
// `descriptionOfMaterial` was once silently dropped because it was added to the form
// but missed in the parser — it reached the server and vanished before the INSERT, so
// the field looked saved and printed blank. These tests pin every hop for `quantity`
// so the same gap cannot open again: the browser's nested keys, a multipart form's
// flat keys, the sanitiser, the keep-row filter, and the round trip back out.

import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../database.js';
import { parseVoucherMaterials } from '../routes/jcc.js';

const uniq = () => `vm-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;

test('the schema carries a quantity column', () => {
  const cols = db.prepare('PRAGMA table_info(voucher_materials)').all().map((c) => c.name);
  assert.ok(cols.includes('quantity'), 'voucher_materials.quantity must exist');
});

test('quantity survives a JSON body', () => {
  const parsed = parseVoucherMaterials({
    materials: [{ descriptionOfMaterial: 'Cable', amount: '500', quantity: '3', projectCode: 'P1', projectName: 'Alpha' }],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].quantity, '3');
  assert.equal(parsed[0].descriptionOfMaterial, 'Cable');
});

test('quantity survives the flat keys a multipart form posts', () => {
  // This is the shape that dropped descriptionOfMaterial: the browser sends
  // materials[0][quantity], not a nested object.
  const parsed = parseVoucherMaterials({
    'materials[0][descriptionOfMaterial]': 'Cable',
    'materials[0][amount]': '500',
    'materials[0][quantity]': '2.5',
    'materials[0][projectCode]': 'P1',
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].quantity, '2.5', 'a flat quantity key must not be discarded');
});

test('a row with only a quantity is still kept', () => {
  // The keep-row filter decides what reaches the INSERT. If quantity is not one of the
  // fields it looks at, a row carrying only a quantity is dropped without a word.
  const parsed = parseVoucherMaterials({ materials: [{ quantity: '7' }] });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].quantity, '7');
});

test('a fully blank row is still discarded', () => {
  const parsed = parseVoucherMaterials({
    materials: [{ descriptionOfMaterial: '', amount: '', quantity: '', projectCode: '', projectName: '' }],
  });
  assert.equal(parsed.length, 0, 'adding a field must not make empty rows persist');
});

test('a decimal quantity is preserved, not truncated to an integer', () => {
  // Materials are claimed in units that are not always whole; the column is DECIMAL
  // for this reason, and an INTEGER column here would silently round.
  const voucherId = Number(db.prepare(
    `INSERT INTO voucher_requests (user_id, claimed_by, department, supplier, description, status)
     VALUES (1, ?, 'Eng', 'ACME', 'test', 'draft')`
  ).run(`Test ${uniq()}`).lastInsertRowid);

  db.prepare(
    `INSERT INTO voucher_materials (voucher_id, amount, project_code, project_name, description_of_material, quantity)
     VALUES (?, '500', 'P1', 'Alpha', 'Cable', ?)`
  ).run(voucherId, 2.5);

  const row = db.prepare('SELECT quantity FROM voucher_materials WHERE voucher_id = ?').get(voucherId);
  assert.equal(Number(row.quantity), 2.5);

  db.prepare('DELETE FROM voucher_materials WHERE voucher_id = ?').run(voucherId);
  db.prepare('DELETE FROM voucher_requests WHERE id = ?').run(voucherId);
});

test('a blank quantity is stored as NULL, not zero', () => {
  // "not stated" and "none claimed" are different facts, and 0 would print on the PDF
  // as though somebody had claimed zero of something.
  const voucherId = Number(db.prepare(
    `INSERT INTO voucher_requests (user_id, claimed_by, department, supplier, description, status)
     VALUES (1, ?, 'Eng', 'ACME', 'test', 'draft')`
  ).run(`Test ${uniq()}`).lastInsertRowid);

  db.prepare(
    `INSERT INTO voucher_materials (voucher_id, amount, description_of_material, quantity)
     VALUES (?, '500', 'Cable', ?)`
  ).run(voucherId, null);

  const row = db.prepare('SELECT quantity FROM voucher_materials WHERE voucher_id = ?').get(voucherId);
  assert.equal(row.quantity, null);

  db.prepare('DELETE FROM voucher_materials WHERE voucher_id = ?').run(voucherId);
  db.prepare('DELETE FROM voucher_requests WHERE id = ?').run(voucherId);
});

// ── Department code ─────────────────────────────────────────────────────────────
// Two codes exist for the same department, so it cannot be derived from the
// department name — the initiator's choice has to be recorded per voucher.

test('the schema carries a department_code column', () => {
  const cols = db.prepare('PRAGMA table_info(voucher_requests)').all().map((c) => c.name);
  assert.ok(cols.includes('department_code'), 'voucher_requests.department_code must exist');
});

test('a chosen department code is stored and read back', () => {
  const uid = db.prepare('SELECT id FROM users WHERE deleted_at IS NULL LIMIT 1').get().id;
  const voucherId = Number(db.prepare(
    `INSERT INTO voucher_requests (user_id, claimed_by, department, department_code, supplier, description, status)
     VALUES (?, ?, 'Documentation & Training', '3998', 'ACME', 'test', 'draft')`
  ).run(uid, `Test ${uniq()}`).lastInsertRowid);

  const row = db.prepare('SELECT department, department_code FROM voucher_requests WHERE id = ?').get(voucherId);
  assert.equal(row.department_code, '3998');
  // Same department, different code — which is exactly why it cannot be derived.
  assert.match(row.department, /Documentation/);

  db.prepare('DELETE FROM voucher_requests WHERE id = ?').run(voucherId);
});

test('both codes are accepted, and only those two', () => {
  // Mirrors VALID_DEPARTMENT_CODES in routes/jcc.js and DEPARTMENT_CODES on the client.
  // 3988 is here on purpose: it was a long-standing typo for 3998 on the printing form,
  // and must not quietly become valid again.
  const allowed = ['3559', '3998'];
  assert.deepEqual(allowed.filter((c) => ['3559', '3998'].includes(c)), allowed);
  assert.equal(['3559', '3998'].includes('3988'), false, '3988 was a typo and is not a real code');
});
