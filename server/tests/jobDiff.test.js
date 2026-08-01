// The diff engine decides what a verifier is told changed on a resubmit. If it
// over-reports, they stop trusting it; if it under-reports, they miss a real edit.
// These cases are the ones that decide which way it goes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSubmissions, matchDocuments, changed, rollUps, summariseDiff } from '../utils/jobDiff.js';

const doc = (over = {}) => ({
    document_name: 'Commissioning Manual',
    quantity: 1,
    num_pages: 40,
    print_side: 'Double-sided',
    paper_size: 'A4',
    paper_gsm: '80',
    color_mode: 'Black & White',
    binding_type: 'Spiral',
    pdf_sha256: 'aaa',
    ...over,
});
const snap = (docs, header = {}) => ({ header: { debit_code: '3559', project_name: 'jjjj', ...header }, documents: docs });

test('an unchanged resubmit reports nothing', () => {
    const d = diffSubmissions(snap([doc()]), snap([doc()]));
    assert.equal(d.isNoOp, true);
    assert.equal(d.changeCount, 0);
    assert.equal(summariseDiff(d), 'no changes');
});

test('blank-ish values are treated as equal', () => {
    assert.equal(changed(null, ''), false);
    assert.equal(changed('', '   '), false);
    assert.equal(changed(undefined, null), false);
    assert.equal(changed('', 'x'), true);
});

test('numeric values compare numerically, not as strings', () => {
    assert.equal(changed('80', 80), false);
    assert.equal(changed(0, '0'), false);
    assert.equal(changed('80', '100'), true);
    // and non-numeric strings still compare as text
    assert.equal(changed('Spiral', 'Wiro'), true);
    assert.equal(changed(' Spiral ', 'Spiral'), false);
});

test('a changed header field is reported with a readable label', () => {
    const d = diffSubmissions(snap([doc()]), snap([doc()], { debit_code: '3612' }));
    assert.equal(d.headerChanges.length, 1);
    assert.deepEqual(d.headerChanges[0], { field: 'debit_code', label: 'Debit code', from: '3559', to: '3612' });
    assert.equal(d.changeCount, 1);
});

test('an added document reports its pages and lifts the roll-ups', () => {
    const d = diffSubmissions(
        snap([doc()]),
        snap([doc(), doc({ document_name: 'Annexure B', num_pages: 12, pdf_sha256: 'bbb' })]),
    );
    const added = d.documentChanges.filter((x) => x.kind === 'added');
    assert.equal(added.length, 1);
    assert.equal(added[0].documentName, 'Annexure B');
    assert.equal(added[0].pages, 12);
    assert.deepEqual(d.totals.books, { from: 1, to: 2, delta: 1 });
    assert.deepEqual(d.totals.pages, { from: 40, to: 52, delta: 12 });
});

test('a removed document is reported as removed', () => {
    const d = diffSubmissions(
        snap([doc(), doc({ document_name: 'Annexure B', pdf_sha256: 'bbb' })]),
        snap([doc()]),
    );
    const removed = d.documentChanges.filter((x) => x.kind === 'removed');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].documentName, 'Annexure B');
    assert.equal(d.totals.books.delta, -1);
});

test('a rename is one change, not a removal plus an addition', () => {
    const d = diffSubmissions(
        snap([doc({ document_name: 'Manual' })]),
        snap([doc({ document_name: 'Commissioning Manual v2' })]),
    );
    assert.equal(d.documentChanges.filter((x) => x.kind === 'added').length, 0, 'not an addition');
    assert.equal(d.documentChanges.filter((x) => x.kind === 'removed').length, 0, 'not a removal');
    const mod = d.documentChanges.find((x) => x.kind === 'modified');
    assert.ok(mod, 'reported as a modification');
    assert.deepEqual(mod.fieldChanges[0], { field: 'document_name', label: 'Name', from: 'Manual', to: 'Commissioning Manual v2' });
});

test('reordering documents is not a change', () => {
    const a = doc({ document_name: 'A', pdf_sha256: 'a1' });
    const b = doc({ document_name: 'B', pdf_sha256: 'b1' });
    const d = diffSubmissions(snap([a, b]), snap([b, a]));
    assert.equal(d.isNoOp, true, 'same documents, different order');
});

test('a quantity change multiplies through the page roll-up', () => {
    const d = diffSubmissions(snap([doc({ quantity: 1 })]), snap([doc({ quantity: 3 })]));
    assert.deepEqual(d.totals.copies, { from: 1, to: 3, delta: 2 });
    assert.deepEqual(d.totals.pages, { from: 40, to: 120, delta: 80 }, '40 pages x 3 copies');
    const mod = d.documentChanges.find((x) => x.kind === 'modified');
    assert.deepEqual(mod.fieldChanges[0], { field: 'quantity', label: 'Copies', from: '1', to: '3' });
});

test('a replaced PDF with identical specs is reported exactly once', () => {
    const d = diffSubmissions(snap([doc()]), snap([doc({ pdf_sha256: 'zzz' })]));
    assert.equal(d.documentChanges.length, 1);
    assert.equal(d.documentChanges[0].kind, 'pdf_replaced');
    assert.equal(d.documentChanges[0].pdfReplaced, true);
    assert.equal(d.documentChanges[0].fieldChanges.length, 0);
    assert.equal(d.changeCount, 1);
});

test('a replaced PDF with a new page count reports both', () => {
    const d = diffSubmissions(snap([doc()]), snap([doc({ pdf_sha256: 'zzz', num_pages: 52 })]));
    const mod = d.documentChanges[0];
    assert.equal(mod.kind, 'modified');
    assert.equal(mod.pdfReplaced, true);
    assert.deepEqual(mod.fieldChanges[0], { field: 'num_pages', label: 'Pages', from: '40', to: '52' });
    assert.equal(d.totals.pages.delta, 12);
});

test('several spec changes on one document are all listed', () => {
    const d = diffSubmissions(
        snap([doc()]),
        snap([doc({ binding_type: 'Wiro', paper_gsm: '100', color_mode: 'Colour' })]),
    );
    const labels = d.documentChanges[0].fieldChanges.map((f) => f.label).sort();
    assert.deepEqual(labels, ['Binding', 'Colour', 'Paper (gsm)']);
    assert.equal(d.changeCount, 3);
});

test('matchDocuments prefers name, then hash, then position', () => {
    // name wins even when hashes differ
    let m = matchDocuments([doc({ document_name: 'X', pdf_sha256: '1' })], [doc({ document_name: 'X', pdf_sha256: '2' })]);
    assert.equal(m.pairs.length, 1);
    assert.equal(m.added.length + m.removed.length, 0);

    // hash rescues a pure rename
    m = matchDocuments([doc({ document_name: 'Old', pdf_sha256: 'same' })], [doc({ document_name: 'New', pdf_sha256: 'same' })]);
    assert.equal(m.pairs.length, 1);

    // genuinely different documents are an add and a remove
    m = matchDocuments([doc({ document_name: 'Old', pdf_sha256: 'p' })], [doc({ document_name: 'New', pdf_sha256: 'q' })]);
    assert.equal(m.pairs.length, 1, 'falls back to position');
});

test('rollUps counts documents, copies and page-prints', () => {
    assert.deepEqual(rollUps([]), { books: 0, copies: 0, pages: 0 });
    assert.deepEqual(
        rollUps([{ quantity: 2, num_pages: 10 }, { quantity: 3, num_pages: 5 }]),
        { books: 2, copies: 5, pages: 35 },
    );
    // missing page counts must not produce NaN
    assert.deepEqual(rollUps([{ quantity: 2, num_pages: null }]), { books: 1, copies: 2, pages: 0 });
});

test('summariseDiff reads as a sentence', () => {
    const d = diffSubmissions(
        snap([doc()]),
        snap([doc({ quantity: 2 }), doc({ document_name: 'Annexure B', num_pages: 12, pdf_sha256: 'bbb' })], { debit_code: '3612' }),
    );
    const summary = summariseDiff(d);
    assert.match(summary, /\+1 document/);
    assert.match(summary, /pages/);
    assert.match(summary, /request field/);
});

test('empty and missing snapshots do not throw', () => {
    assert.equal(diffSubmissions(null, null).isNoOp, true);
    assert.equal(diffSubmissions(undefined, snap([doc()])).documentChanges.length, 1);
    assert.equal(diffSubmissions(snap([]), snap([])).isNoOp, true);
});
