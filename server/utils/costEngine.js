// Pricing kernel.
//
// Deliberately knows nothing about printing. It takes billable quantities and rate
// lines and produces cost lines. Paper, binding and lamination vocabulary lives in
// the domain adapter (costPrinting.js), so a second service department can reuse this
// without touching it.
//
// All money is integer. rate_milli is the rate x 1000 (the printed card carries three
// decimals: 1.150 -> 1150). Amounts are paise. Nothing here uses a float, so a total
// always agrees with a hand-check on the annexure.

/** Half-up rounding on integers, sign-aware. */
export const roundHalfUp = (numerator, denominator) => {
    const sign = numerator < 0 ? -1 : 1;
    const n = Math.abs(numerator);
    return sign * Math.floor((n * 2 + denominator) / (denominator * 2));
};

/**
 * qty x rate_milli -> paise.
 * rate_milli is thousandths of a rupee; paise are hundredths. So the conversion is
 * a divide by 10, rounded half-up at the line — never at the total (BR-09).
 */
export const lineAmountPaise = (qty, rateMilli) => roundHalfUp(qty * rateMilli, 10);

/** Rupee string for display. Never used for arithmetic. */
export const paiseToRupees = (paise) =>
    (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const milliToRate = (milli) => (milli / 1000).toFixed(3);

/**
 * Price one billable item.
 *   item  { serviceCode, quantity, uom, costGroup, label, meta }
 *   rate  { rate_milli, min_charge_paise, pricing_kind }
 * Returns a cost line, or null when quantity rounds to nothing chargeable.
 */
export const priceItem = (item, rate) => {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) return null;

    const kind = rate.pricing_kind || 'per_unit';
    // `fixed` ignores quantity — one charge per job however many units were produced.
    const chargeableQty = kind === 'fixed' ? 1 : qty;

    let amount = lineAmountPaise(chargeableQty, rate.rate_milli);

    let minApplied = false;
    if (rate.min_charge_paise != null && amount < rate.min_charge_paise) {
        amount = rate.min_charge_paise;
        minApplied = true;
    }

    return {
        serviceCode: item.serviceCode,
        label: item.label,
        costGroup: item.costGroup,
        quantity: chargeableQty,
        uom: item.uom,
        rateMilli: rate.rate_milli,
        amountPaise: amount,
        minChargeApplied: minApplied,
        meta: item.meta || null,
    };
};

/** Sum lines into the annexure's four groups plus rework, kept separate (BR-11). */
export const summarise = (lines) => {
    const totals = { printing: 0, binding: 0, finishing: 0, misc: 0, rework: 0, unconfigured: 0 };
    for (const l of lines) {
        // A line with no rate contributes nothing to money, but is counted so the
        // annexure can say how much of the job is still unpriced.
        if (l.rateStatus === 'not_configured' || l.rate_status === 'not_configured') {
            totals.unconfigured += 1;
            continue;
        }
        if (l.isRework) totals.rework += l.amountPaise;
        else if (totals[l.costGroup] !== undefined) totals[l.costGroup] += l.amountPaise;
        else totals.misc += l.amountPaise;
    }
    const basic = totals.printing + totals.binding + totals.finishing + totals.misc;
    return { ...totals, basic, grandTotal: basic + totals.rework };
};

/** Indian-format words for the annexure footer. Rupees only; paise stated separately. */
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const twoDigits = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`);

const belowThousand = (n) => {
    if (n === 0) return '';
    if (n < 100) return twoDigits(n);
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${twoDigits(rest)}` : ''}`;
};

export const amountInWords = (paise) => {
    const rupees = Math.floor(Math.abs(paise) / 100);
    const p = Math.abs(paise) % 100;
    if (rupees === 0 && p === 0) return 'Rupees zero only';

    const parts = [];
    const scales = [[10000000, 'crore'], [100000, 'lakh'], [1000, 'thousand']];
    let left = rupees;
    for (const [value, name] of scales) {
        const count = Math.floor(left / value);
        if (count > 0) {
            // Crore and above can exceed 999, so recurse for the leading group.
            parts.push(`${count > 999 ? amountInWords(count * 100).replace(/^Rupees | only$/g, '') : belowThousand(count)} ${name}`);
            left %= value;
        }
    }
    if (left > 0) parts.push(belowThousand(left));

    const rupeeWords = parts.join(' ').replace(/\s+/g, ' ').trim();
    const paiseWords = p > 0 ? ` and ${twoDigits(p)} paise` : '';
    return `Rupees ${rupeeWords || 'zero'}${paiseWords} only`;
};
