import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePageList, collapse, describePageList } from '../utils/pageRanges.js';

test('accepts the four notations from the spec', () => {
    assert.deepEqual(parsePageList('12').pages, [12]);
    assert.deepEqual(parsePageList('5, 8, 19').pages, [5, 8, 19]);
    assert.deepEqual(parsePageList('30-36').pages, [30, 31, 32, 33, 34, 35, 36]);
    assert.deepEqual(parsePageList('5, 8, 30-36').pages, [5, 8, 30, 31, 32, 33, 34, 35, 36]);
});

test('tolerates the separators and dashes a coordinator actually types', () => {
    const expected = [5, 8, 30, 31, 32, 33, 34, 35, 36];
    for (const input of [
        '5, 8, 30-36',
        '5,8,30-36',
        '5 8 30-36',
        '5; 8; 30 - 36',
        '5, 8, 30–36',   // en dash, e.g. pasted from Word
        '5, 8, 30—36',   // em dash
        '5, 8, 30 to 36',
        '  5,8,  30-36  ',
    ]) {
        const r = parsePageList(input);
        assert.equal(r.ok, true, `${input} should parse`);
        assert.deepEqual(r.pages, expected, `${input} should expand correctly`);
    }
});

test('sorts, de-duplicates, and re-collapses runs', () => {
    const r = parsePageList('8, 5, 30 to 36, 8');
    assert.equal(r.normalised, '5,8,30-36');
    assert.equal(r.count, 9);
});

test('runs of two stay listed, runs of three or more collapse', () => {
    assert.equal(collapse([5, 6]), '5,6');
    assert.equal(collapse([5, 6, 7]), '5-7');
    assert.equal(collapse([1, 2, 3, 9, 11, 12]), '1-3,9,11,12');
});

test('rejects the malformed cases', () => {
    for (const bad of ['', '   ', '0', 'abc', '5-', '-5', '1-2-3', '5,,8x', 'page 5']) {
        assert.equal(parsePageList(bad).ok, false, `${JSON.stringify(bad)} should be rejected`);
    }
});

test('rejects a backwards range with a helpful message', () => {
    const r = parsePageList('36-30');
    assert.equal(r.ok, false);
    assert.match(r.error, /did you mean 30-36/);
});

test('rejects pages beyond the uploaded PDF', () => {
    const r = parsePageList('5, 140', { maxPage: 122 });
    assert.equal(r.ok, false);
    assert.match(r.error, /Page 140 does not exist.*122 pages/);
});

test('accepts pages exactly at the page count boundary', () => {
    assert.equal(parsePageList('122', { maxPage: 122 }).ok, true);
    assert.equal(parsePageList('123', { maxPage: 122 }).ok, false);
});

test('empty input is rejected — modified pages are mandatory', () => {
    assert.equal(parsePageList(null).ok, false);
    assert.equal(parsePageList(undefined).ok, false);
});

test('describePageList reads naturally', () => {
    assert.equal(describePageList('5,8,30-36', 9), '9 pages: 5, 8, 30-36');
    assert.equal(describePageList('12', 1), '1 page: 12');
});
