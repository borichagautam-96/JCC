// The kernel produces the figures on a chargeback document. If a total disagrees with
// a hand-check on the printed annexure, nobody trusts the module again — so these
// cases are checked against arithmetic done by hand from the August 2026 card.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    roundHalfUp, lineAmountPaise, priceItem, summarise, amountInWords, paiseToRupees, milliToRate,
} from '../utils/costEngine.js';

test('half-up rounding, including negatives', () => {
    assert.equal(roundHalfUp(10, 10), 1);
    assert.equal(roundHalfUp(15, 10), 2, '1.5 rounds up, not to even');
    assert.equal(roundHalfUp(14, 10), 1);
    assert.equal(roundHalfUp(25, 10), 3);
    assert.equal(roundHalfUp(-15, 10), -2, 'away from zero');
    assert.equal(roundHalfUp(0, 10), 0);
});

test('the worked example from the card is exact', () => {
    // 250 pages x 5 copies of A4 80 GSM B&W at 1.150
    assert.equal(lineAmountPaise(1250, 1150), 143750);
    assert.equal(paiseToRupees(143750), '1,437.50');
    // 5 spiral bindings at 17.250
    assert.equal(lineAmountPaise(5, 17250), 8625);
    assert.equal(paiseToRupees(8625), '86.25');
    // basic total
    assert.equal(paiseToRupees(143750 + 8625), '1,523.75');
});

test('three-decimal rates survive the round trip', () => {
    assert.equal(milliToRate(570), '0.570');
    assert.equal(milliToRate(33350), '33.350');
    assert.equal(milliToRate(1475000), '1475.000');
});

test('a rate with a trailing half-paise rounds up once, at the line', () => {
    // 0.570 x 3 = 1.710 -> 171 paise exactly
    assert.equal(lineAmountPaise(3, 570), 171);
    // 0.005 x 1 = 0.5 paise -> rounds to 1 paisa
    assert.equal(lineAmountPaise(1, 5), 1);
    // 0.004 -> rounds to 0
    assert.equal(lineAmountPaise(1, 4), 0);
});

test('summing rounded lines never re-rounds the total', () => {
    // Three lines that each round up; the total must be the sum of the rounded lines,
    // not a re-rounding of the raw arithmetic.
    const lines = [
        { costGroup: 'printing', amountPaise: lineAmountPaise(1, 5) },
        { costGroup: 'printing', amountPaise: lineAmountPaise(1, 5) },
        { costGroup: 'printing', amountPaise: lineAmountPaise(1, 5) },
    ];
    assert.equal(summarise(lines).printing, 3, 'three 1-paise lines, not 2');
});

test('per_unit prices on quantity', () => {
    const line = priceItem(
        { serviceCode: 'PRINT', label: 'Printing', costGroup: 'printing', quantity: 1250, uom: 'page' },
        { rate_milli: 1150, pricing_kind: 'per_unit' },
    );
    assert.equal(line.quantity, 1250);
    assert.equal(line.amountPaise, 143750);
    assert.equal(line.minChargeApplied, false);
});

test('fixed ignores quantity — one charge per job', () => {
    const line = priceItem(
        { serviceCode: 'STICKER', label: 'Sticker', costGroup: 'finishing', quantity: 40, uom: 'piece' },
        { rate_milli: 1475000, pricing_kind: 'fixed' },
    );
    assert.equal(line.quantity, 1, 'quantity collapsed to 1');
    assert.equal(line.amountPaise, 147500, 'Rs 1475.00 once');
});

test('minimum charge lifts a small line and is flagged', () => {
    const line = priceItem(
        { serviceCode: 'SCAN', label: 'Scanning', costGroup: 'printing', quantity: 2, uom: 'page' },
        { rate_milli: 400, pricing_kind: 'per_unit', min_charge_paise: 5000 },
    );
    assert.equal(line.amountPaise, 5000, 'floored at Rs 50.00');
    assert.equal(line.minChargeApplied, true, 'flagged so the annexure can show why');
});

test('minimum charge does not lower a line above it', () => {
    const line = priceItem(
        { serviceCode: 'SCAN', label: 'Scanning', costGroup: 'printing', quantity: 500, uom: 'page' },
        { rate_milli: 400, pricing_kind: 'per_unit', min_charge_paise: 5000 },
    );
    assert.equal(line.amountPaise, 20000);
    assert.equal(line.minChargeApplied, false);
});

test('zero or negative quantity produces no line', () => {
    const base = { serviceCode: 'PRINT', label: 'x', costGroup: 'printing', uom: 'page' };
    assert.equal(priceItem({ ...base, quantity: 0 }, { rate_milli: 1150 }), null);
    assert.equal(priceItem({ ...base, quantity: -5 }, { rate_milli: 1150 }), null);
    assert.equal(priceItem({ ...base, quantity: null }, { rate_milli: 1150 }), null);
});

test('rework is summarised apart from the basic total', () => {
    const lines = [
        { costGroup: 'printing',  amountPaise: 143750 },
        { costGroup: 'binding',   amountPaise: 8625 },
        { costGroup: 'finishing', amountPaise: 7370 },
        { costGroup: 'misc',      amountPaise: 13625 },
        { costGroup: 'printing',  amountPaise: 2300, isRework: true },
    ];
    const s = summarise(lines);
    assert.equal(s.printing, 143750, 'rework excluded from the printing group');
    assert.equal(s.rework, 2300);
    assert.equal(s.basic, 173370);
    assert.equal(s.grandTotal, 175670);
    assert.equal(paiseToRupees(s.grandTotal), '1,756.70');
});

test('an unknown cost group falls into misc rather than vanishing', () => {
    const s = summarise([{ costGroup: 'something_new', amountPaise: 500 }]);
    assert.equal(s.misc, 500);
    assert.equal(s.basic, 500);
});

test('amount in words uses Indian grouping', () => {
    assert.equal(amountInWords(0), 'Rupees zero only');
    assert.equal(amountInWords(143750), 'Rupees one thousand four hundred thirty-seven and fifty paise only');
    assert.equal(amountInWords(247000), 'Rupees two thousand four hundred seventy only');
    assert.equal(amountInWords(100000), 'Rupees one thousand only');
    assert.match(amountInWords(1234567890), /crore/);
    assert.match(amountInWords(50000000), /lakh/);
});

test('words and figures agree on the worked example', () => {
    const paise = 143750 + 8625;
    assert.equal(paiseToRupees(paise), '1,523.75');
    assert.equal(amountInWords(paise), 'Rupees one thousand five hundred twenty-three and seventy-five paise only');
});
