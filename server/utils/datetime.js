// Server-side rendering of stored timestamps.
//
// Timestamps are written with SQLite's `datetime('now')` — UTC, with no zone
// marker ("2026-07-23 06:13:41"). `new Date(...)` reads such a string as the
// *process* local time, which in a container (TZ unset → UTC) silently happens
// to work and on a developer machine does not. Parse explicitly as UTC, then
// format in the business timezone so PDFs and emails read the same everywhere
// regardless of where the server runs.
//
// Storage stays UTC — only display is converted. Override the display zone with
// APP_TIMEZONE if the deployment is not in India.

export const DISPLAY_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

/** Parse a stored value into a Date, or null. Naive datetimes are read as UTC. */
export const parseStoredDate = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
        const fromEpoch = new Date(value);
        return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
    }

    const raw = String(value).trim();
    if (!raw) return null;

    let parsed;
    if (DATE_ONLY.test(raw)) {
        // A calendar date, not an instant — anchor it at noon UTC so shifting into
        // the display zone can never roll it to the neighbouring day.
        const [year, month, day] = raw.split('-').map(Number);
        parsed = new Date(Date.UTC(year, month - 1, day, 12));
    } else if (NAIVE_DATETIME.test(raw)) {
        parsed = new Date(`${raw.replace(' ', 'T')}Z`);
    } else {
        parsed = new Date(raw);
    }

    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parts = (date) => {
    const map = {};
    for (const part of new Intl.DateTimeFormat('en-GB', {
        timeZone: DISPLAY_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date)) {
        map[part.type] = part.value;
    }
    return map;
};

/** "DD-MM-YYYY" in the display timezone — the format the JCC PDF expects. */
export const formatStoredDateDMY = (value, fallback = '-') => {
    const date = parseStoredDate(value);
    if (!date) return fallback;
    const { day, month, year } = parts(date);
    return `${day}-${month}-${year}`;
};

/** Long, human date ("Thursday, October 16, 2025") in the display timezone. */
export const formatStoredDateLong = (value, fallback = '-') => {
    const date = parseStoredDate(value);
    if (!date) return fallback;
    return date.toLocaleDateString('en-US', {
        timeZone: DISPLAY_TIMEZONE,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
};

/** Date + time in the display timezone, for emails and audit trails. */
export const formatStoredDateTime = (value, fallback = '-') => {
    // A date-only value carries no time of day — showing the noon-UTC anchor
    // shifted into the display zone would invent one.
    if (typeof value === 'string' && DATE_ONLY.test(value.trim())) {
        return formatStoredDateDMY(value, fallback);
    }
    const date = parseStoredDate(value);
    if (!date) return fallback;
    return date.toLocaleString('en-IN', { timeZone: DISPLAY_TIMEZONE });
};
