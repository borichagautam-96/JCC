// Audit trail for the monthly printing report.
//
// The report is read-only: it reads approved annexures and writes nothing back. The
// audit row is therefore the ONLY database write the preview or the export performs,
// and that is deliberate — see the read-only test in monthlyReportAudit.test.js, which
// fingerprints the business tables before and after an export and fails if anything
// other than audit_logs moved.
//
// Everything needed to identify what was exported lives in the row itself: month,
// filters, job count, grand total, user, timestamp and filename. The Excel binary is
// not stored — audit_logs is a text table and this codebase has no document store.

import crypto from 'node:crypto';
import db from '../database.js';
import { paiseToRupees } from '../utils/costEngine.js';

export const ENTITY_TYPE = 'monthly_printing_report';

export const ACTIONS = {
  PREVIEWED: 'MONTHLY_PRINTING_REPORT_PREVIEWED',
  EXPORTED: 'MONTHLY_PRINTING_REPORT_EXPORTED',
};

// SQLite stores naive UTC. The printing department reads these entries in IST, and a
// created_at of 18:30 UTC is the next day locally, so the IST instant is written into
// the details rather than left for a reader to convert.
const IST_OFFSET_MS = 330 * 60 * 1000;
export const istStamp = (date = new Date()) => {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} IST`;
};

/**
 * A stable identifier for "this report, these filters, this month".
 *
 * Deterministic on purpose: the same request produces the same id, so two audit rows
 * can be compared to see whether they describe the same extract. It deliberately does
 * NOT include the timestamp or the user — those are separate columns, and folding them
 * in would make every id unique and useless for that comparison.
 */
export const reportIdentifier = ({ monthKey, filters = {} }) => {
  const canonical = ['manager', 'member', 'department', 'debit_code', 'project']
    .map((k) => `${k}=${String(filters[k] ?? '').trim()}`)
    .join('&');
  const hash = crypto.createHash('sha256').update(`${monthKey}|${canonical}`).digest('hex');
  return `MPR-${monthKey}-${hash.slice(0, 10)}`;
};

// Filters are recorded by NAME as well as id — an id alone stops being readable the
// moment a user is renamed or deactivated, which is exactly when an audit trail matters.
const describeFilters = (filters = {}, report) => {
  const out = [];
  const nameOf = (list, value) =>
    (report?.options?.[list] || []).find((o) => String(o.value) === String(value))?.label;

  if (filters.manager) {
    out.push(`Manager = ${nameOf('managers', filters.manager) || `#${filters.manager}`}`);
  }
  if (filters.member) {
    out.push(`Team Member = ${nameOf('members', filters.member) || `#${filters.member}`}`);
  }
  if (filters.department) out.push(`Department = ${filters.department}`);
  if (filters.debit_code) out.push(`Debit Code = ${filters.debit_code}`);
  if (filters.project) out.push(`Project = ${filters.project}`);
  return out.length ? out.join(', ') : 'None (all in scope)';
};

// A preview refires on every filter change, and a browser can legitimately repeat the
// same request within seconds (React's development double-render, a refresh, a
// double-click). Recording each one buries the meaningful entries. An identical
// preview by the same user inside this window is treated as the same viewing.
//
// Exports are never collapsed: each one produced a file that left the building.
const PREVIEW_DEDUPE_SECONDS = 30;

const recentDuplicate = (userId, action, identifier) => {
  if (action !== ACTIONS.PREVIEWED) return false;
  const row = db.prepare(
    `SELECT 1 FROM audit_logs
      WHERE user_id = ? AND action = ? AND entity_type = ?
        AND details LIKE ?
        AND created_at >= datetime('now', ?)
      LIMIT 1`
  ).get(userId, action, ENTITY_TYPE, `%Report ID: ${identifier}%`,
        `-${PREVIEW_DEDUPE_SECONDS} seconds`);
  return !!row;
};

/**
 * Write one audit row for a preview or an export.
 *
 * Never throws: an audit failure must not deny a coordinator their report, and the
 * error is logged rather than swallowed silently.
 */
export const writeReportAudit = (req, action, report, {
  filters = {}, filename = null, unmapped = [],
} = {}) => {
  try {
    const identifier = reportIdentifier({ monthKey: report.month.key, filters });
    if (recentDuplicate(req.user.id, action, identifier)) return identifier;
    const lines = [
      'MONTHLY PRINTING ANNEXURE REPORT',
      `Month: ${report.month.label}`,
      `Filters: ${describeFilters(filters, report)}`,
      `Jobs: ${report.counts.jobs}`,
      `Managers: ${report.counts.managers}, Team members: ${report.counts.members}`,
      `Grand Total: ₹${paiseToRupees(report.totals.grand_total_paise)}`,
      `Report ID: ${identifier}`,
      `Generated: ${istStamp()}`,
    ];
    if (filename) lines.push(`File: ${filename}`);
    // An unpriced item excluded from the total is recorded, so the audit row explains a
    // total that does not match a hand count of the month's work.
    if (unmapped.length) {
      lines.push(`Unmapped (rate not configured, EXCLUDED from total): ${unmapped
        .map((u) => `${u.label || 'Printing'} ${u.paper_gsm ?? '?'} GSM / `
          + `${u.colour_label || u.colour_mode || '?'} / ${u.paper_size ?? '?'} — qty ${u.quantity}`)
        .join('; ')}`);
    }

    db.prepare(
      `INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details, ip_address)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`
    ).run(req.user.id, req.user.name, action, ENTITY_TYPE, lines.join('\n'), req.ip || null);

    return identifier;
  } catch (error) {
    console.error('[monthly report] audit failed:', error);
    return null;
  }
};
