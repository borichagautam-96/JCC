// Shared date/time handling for everything the UI renders from the API.
//
// Root cause this module exists for: the server writes timestamps with SQLite's
// `datetime('now')`, which produces UTC with no zone marker — "2026-07-23 06:13:41".
// `new Date("2026-07-23 06:13:41")` treats that string as *local* time, so every
// timestamp rendered straight from the API drifts by the browser's UTC offset
// (5h30m behind in IST). Parse those strings explicitly as UTC here, then let
// Intl render them in the viewer's own system timezone.
//
// Three input shapes reach us and each needs different handling:
//   "2026-07-23 06:13:41" / "2026-07-23T06:13:41"  → SQLite UTC, no marker → append Z
//   "2026-07-23T06:13:41.000Z" / "...+05:30"       → already unambiguous → parse as-is
//   "2026-07-23"                                   → a calendar date, not an instant;
//                                                    pin to local midnight so it never
//                                                    rolls back a day in +offset zones

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

/**
 * Turn any server-supplied date value into a Date, or null if it isn't one.
 * Naive datetimes are read as UTC; date-only values as local calendar dates.
 */
export const parseServerDate = (value) => {
    if (value === null || value === undefined || value === '') return null;

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === 'number') {
        const fromEpoch = new Date(value);
        return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
    }

    const raw = String(value).trim();
    if (!raw) return null;

    let parsed;
    if (DATE_ONLY.test(raw)) {
        const [year, month, day] = raw.split('-').map(Number);
        parsed = new Date(year, month - 1, day);
    } else if (NAIVE_DATETIME.test(raw)) {
        parsed = new Date(`${raw.replace(' ', 'T')}Z`);
    } else {
        parsed = new Date(raw);
    }

    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const format = (value, options, fallback) => {
    const date = parseServerDate(value);
    if (!date) return fallback;
    // Locale/timezone left undefined on purpose: render in the viewer's own
    // system settings rather than pinning everyone to one zone.
    return date.toLocaleString(undefined, options);
};

/** Date + time, e.g. "23/07/2026, 11:43:41 am". */
export const formatDateTime = (value, { fallback = '-', ...options } = {}) =>
    format(value, { dateStyle: 'short', timeStyle: 'medium', ...options }, fallback);

/** Date + time without seconds, for dense tables and captions. */
export const formatDateTimeShort = (value, { fallback = '-', ...options } = {}) =>
    format(value, { dateStyle: 'short', timeStyle: 'short', ...options }, fallback);

/** Date only — safe for calendar fields like invoice_date / po_date. */
export const formatDate = (value, { fallback = '-', ...options } = {}) =>
    format(value, { dateStyle: 'short', ...options }, fallback);

/** Time only. */
export const formatTime = (value, { fallback = '-', ...options } = {}) =>
    format(value, { timeStyle: 'short', ...options }, fallback);

/** Milliseconds elapsed since a server timestamp, or null if unparseable. */
export const msSince = (value) => {
    const date = parseServerDate(value);
    return date ? Date.now() - date.getTime() : null;
};

/** Whole days elapsed since a server timestamp, or null if unparseable. */
export const daysSince = (value) => {
    const elapsed = msSince(value);
    return elapsed === null ? null : Math.floor(elapsed / 86400000);
};

/** Epoch millis for sorting; missing/invalid values sort last in ascending order. */
export const dateSortValue = (value, fallback = 0) => {
    const date = parseServerDate(value);
    return date ? date.getTime() : fallback;
};

/**
 * "YYYY-MM-DD" for <input type="date">, using the *local* calendar day.
 * toISOString() would answer in UTC and hand back yesterday for anyone east of
 * Greenwich during the early hours.
 */
export const toDateInputValue = (value) => {
    const date = parseServerDate(value) || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
