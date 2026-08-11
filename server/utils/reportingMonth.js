// Which reporting month an annexure approval falls in.
//
// Every timestamp in this schema is written by SQLite's datetime('now'), which is
// naive UTC — no offset stored, no offset implied. The printing department reports in
// IST (UTC+5:30, no daylight saving), and those two disagree for five and a half hours
// of every day:
//
//   approved at UTC 2026-07-31 19:30  ->  IST 2026-08-01 01:00
//     comparing the raw string puts it in JULY
//     the department counts it in AUGUST
//
// So every approval between 18:30 and 23:59 UTC belongs to the NEXT IST day, and at a
// month end, to the next month. Filtering on the stored string would silently misfile
// roughly a fifth of every month's approvals — including the exact case the spec calls
// out: "completed 31 July, approved 1 August, must appear in August".
//
// Rather than convert each row in JS, the window is converted once: an IST month
// [start, end) is expressed as the UTC instants that bound it, so the query stays a
// plain indexed comparison against approved_at.

const IST_OFFSET_MINUTES = 330; // +05:30, fixed — India has no DST

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD HH:MM:SS' in UTC for a given IST wall-clock moment. */
const istWallClockToUtc = (year, month, day) => {
  // Date.UTC treats the parts as UTC; subtracting the offset turns "IST wall clock"
  // into the actual UTC instant.
  const utcMs = Date.UTC(year, month - 1, day) - IST_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
       + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

/**
 * UTC bounds of one IST calendar month, half-open [startUtc, endUtc).
 *
 * Half-open on purpose: an approval at exactly midnight IST on the 1st belongs to the
 * new month, and a BETWEEN or <= would double-count it in both.
 *
 * July 2025 and July 2026 are unrelated windows — the year is always part of the key,
 * never just the month number.
 */
export const monthWindowIST = (year, month) => {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12 || y < 2000 || y > 2100) {
    return null;
  }
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    year: y,
    month: m,
    startUtc: istWallClockToUtc(y, m, 1),
    endUtc: istWallClockToUtc(nextY, nextM, 1),
    label: new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }),
  };
};

/** Accepts 'YYYY-MM'. Returns null for anything malformed rather than guessing. */
export const parseMonthKey = (key) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key ?? '').trim());
  return m ? monthWindowIST(Number(m[1]), Number(m[2])) : null;
};

/** The IST month a stored (naive UTC) timestamp falls in, as 'YYYY-MM'. */
export const istMonthKeyOf = (utcTimestamp) => {
  if (!utcTimestamp) return null;
  const d = new Date(`${String(utcTimestamp).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}`;
};

/** The IST month containing "now" — the sensible default for a month picker. */
export const currentMonthKeyIST = () => istMonthKeyOf(
  new Date().toISOString().slice(0, 19).replace('T', ' ')
);

export { IST_OFFSET_MINUTES };
