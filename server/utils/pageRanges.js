// Parsing for the "modified pages" notation a coordinator types when logging a
// rework: "12", "5, 8, 19", "30-36", or a mix like "5, 8, 30-36".
//
// Input is forgiving because it is transcribed by hand from what the requestor
// wrote on a printed proof — separators may be commas, semicolons or plain
// spaces, and the dash may be a hyphen, an en dash pasted from Word, or the
// word "to". Output is strict: a canonical string, the fully expanded page
// list, and a count, so the database never stores an ambiguous form.

const SEPARATOR = /[,;\s]+/;

// Dashes must be resolved BEFORE splitting on separators, or "30 - 36" and
// "30 to 36" break into three tokens and the range is lost. Anchoring on digits
// either side keeps the rewrite from touching stray words.
const normaliseDashes = (s) => s.replace(/(\d)\s*(?:-{1,2}|–|—|\bto\b)\s*(\d)/gi, '$1-$2');

/**
 * Parse page notation into { ok, pages, normalised, count } or { ok:false, error }.
 * `pages` is ascending, de-duplicated. `normalised` re-collapses runs of three or
 * more consecutive pages back into ranges, so "5,6,7,8" round-trips as "5-8".
 */
export const parsePageList = (input, { maxPage = null } = {}) => {
    const raw = String(input ?? '').trim();
    if (!raw) return { ok: false, error: 'Enter the page numbers that changed.' };

    const tokens = normaliseDashes(raw).split(SEPARATOR).filter(Boolean);
    if (!tokens.length) return { ok: false, error: 'Enter the page numbers that changed.' };

    const pages = new Set();
    for (const token of tokens) {
        // Empty parts are kept, not filtered — dropping them would silently read
        // "5-" as the single page 5 rather than rejecting an unfinished range.
        const parts = token.split('-');
        if (parts.length > 2) {
            return { ok: false, error: `"${token}" is not a page or a range. Try 12, or 30-36.` };
        }
        const numbers = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
        if (numbers.some((n) => Number.isNaN(n))) {
            return { ok: false, error: `"${token}" is not a page number. Use digits, like 12 or 30-36.` };
        }
        if (numbers.some((n) => n < 1)) {
            return { ok: false, error: 'Page numbers start at 1.' };
        }
        if (parts.length === 1) {
            pages.add(numbers[0]);
            continue;
        }
        const [start, end] = numbers;
        if (start > end) {
            return { ok: false, error: `Range ${start}-${end} runs backwards — did you mean ${end}-${start}?` };
        }
        if (end - start > 5000) {
            return { ok: false, error: `Range ${start}-${end} is too large to be a page range.` };
        }
        for (let p = start; p <= end; p += 1) pages.add(p);
    }

    const sorted = [...pages].sort((a, b) => a - b);
    if (maxPage != null) {
        const over = sorted.find((p) => p > maxPage);
        if (over) {
            return { ok: false, error: `Page ${over} does not exist — the uploaded PDF has ${maxPage} pages.` };
        }
    }

    return { ok: true, pages: sorted, normalised: collapse(sorted), count: sorted.length };
};

/** [5,8,30,31,32,33] → "5,8,30-33". Runs of two stay listed; three or more collapse. */
export const collapse = (pages) => {
    const out = [];
    let i = 0;
    while (i < pages.length) {
        let j = i;
        while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j += 1;
        const runLength = j - i + 1;
        if (runLength >= 3) {
            out.push(`${pages[i]}-${pages[j]}`);
        } else {
            for (let k = i; k <= j; k += 1) out.push(String(pages[k]));
        }
        i = j + 1;
    }
    return out.join(',');
};

/** Human summary for emails and the operator card: "9 pages: 5, 8, 30-36". */
export const describePageList = (normalised, count) => {
    if (!normalised) return '-';
    return `${count} page${count === 1 ? '' : 's'}: ${normalised.replace(/,/g, ', ')}`;
};
