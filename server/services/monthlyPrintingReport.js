// Monthly printing report — what was approved, in one IST calendar month.
//
// Scope rules, all deliberate:
//   * The month comes from cost_annexures.approved_at, never from when the job was
//     raised, printed or completed. The cost belongs to the month it was agreed in.
//   * Only status='approved' counts. A draft, an under_review, a rejected-and-returned
//     one and a superseded older version are all excluded — a superseded version can
//     still carry its own approved_at from before it was replaced, so filtering on the
//     date alone would double-count the job.
//   * The manager is the one stamped at submission, so a reorg does not silently move
//     historical work between teams.
//
// The approved annexure's own totals are the source of truth for money. Cost lines are
// read only to aggregate QUANTITIES by paper/type/size for the Excel rate block; their
// amounts are never re-summed into a job total.

import db from '../database.js';
import { parseMonthKey } from '../utils/reportingMonth.js';

// A5/B5 is the only size the report sheet prices on a single row; A4, A3, A2, A1 and
// 12X18 each get their own. rateImport expands "A5/B5" into two rate rows on the way
// in, so this folds an A5 job and a B5 job back onto the one row the template has.
//
// "A4/A3" appears in the rate data but is NOT a row on this sheet — folding it would
// merge two separately-reported sizes into a row that does not exist, and the A4 and A3
// quantities would vanish from the report. Read off the template's Size column
// (rows 8–48), not assumed from the rate master's groupings.
const TEMPLATE_SIZE_GROUPS = ['A5/B5'];
const templateSizeOf = (size) => {
  const s = String(size ?? '').trim().toUpperCase();
  if (!s) return null;
  const group = TEMPLATE_SIZE_GROUPS.find((g) => g.split('/').includes(s));
  return group || s;
};

// 'BW' / 'COLOUR' as stored; the sheet writes them as B&W / Color. Kept as a label only
// — the aggregation key stays the stored code so nothing depends on display text.
const COLOUR_LABEL = { BW: 'B&W', COLOUR: 'Color' };

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * Every approved annexure in the month, one row per annexure, with its job and the
 * manager stamped at submit. This is the spine — the detailed sheet, the summary
 * rollups and the quantity aggregation all derive from the same set, so a figure on
 * one sheet can always be traced to a job on another.
 */
const approvedAnnexuresFor = (window, filters, scope) => {
  const where = [
    "a.status = 'approved'",
    'a.approved_at IS NOT NULL',
    'a.approved_at >= ?',
    'a.approved_at < ?',
    // Belt and braces alongside status: a cancelled job must never be billed even if an
    // annexure was approved before it was cancelled.
    "COALESCE(j.status,'') != 'cancelled'",
  ];
  const args = [window.startUtc, window.endUtc];

  // Scope is a permission, applied before any filter, so clearing filters can never
  // widen what a manager sees.
  if (scope?.managerId != null) {
    where.push('COALESCE(j.manager_id_at_submit, mgr.id) = ?');
    args.push(scope.managerId);
  }
  if (!blank(filters.manager) && scope?.managerId == null) {
    where.push('COALESCE(j.manager_id_at_submit, mgr.id) = ?');
    args.push(Number(filters.manager));
  }
  if (!blank(filters.member)) { where.push('u.id = ?'); args.push(Number(filters.member)); }
  if (!blank(filters.department)) { where.push('j.department_name = ?'); args.push(String(filters.department)); }
  if (!blank(filters.debit_code)) { where.push('j.debit_code = ?'); args.push(String(filters.debit_code)); }
  if (!blank(filters.project)) { where.push('j.project_name = ?'); args.push(String(filters.project)); }

  return db.prepare(`
    SELECT a.id AS annexure_id, a.annexure_no, a.version, a.approved_at,
           a.printing_paise, a.binding_paise, a.finishing_paise, a.misc_paise,
           a.rework_paise, a.basic_paise, a.grand_total_paise,
           j.id AS job_id, j.job_number, j.request_id, j.project_name, j.dt_number,
           j.department_name, j.debit_code, j.completed_at, j.lead_name, j.number_of_pages,
           u.id AS requestor_id, u.name AS requestor_name, u.ps_number AS requestor_ps,
           COALESCE(j.manager_id_at_submit,   mgr.id)        AS manager_id,
           COALESCE(j.manager_name_at_submit, mgr.name)      AS manager_name,
           COALESCE(j.manager_ps_at_submit,   mgr.ps_number) AS manager_ps
      FROM cost_annexures a
      JOIN print_jobs j ON j.id = a.job_id
      LEFT JOIN users u   ON u.id = j.created_by
      LEFT JOIN users mgr ON mgr.id = u.manager_id
     WHERE ${where.join(' AND ')}
     ORDER BY (manager_name IS NULL), manager_name,
              (requestor_name IS NULL), requestor_name,
              COALESCE(j.job_number, j.request_id)
  `).all(...args);
};

/**
 * Quantities by paper / type / size, across every approved annexure in the month.
 *
 * Scoped by annexure_id rather than job_id: a job can own lines from a superseded
 * version too, and joining on the job would pull those back in.
 */
const paperAggregation = (annexureIds) => {
  if (!annexureIds.length) return [];
  const placeholders = annexureIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT l.paper_gsm, l.colour_mode, l.paper_size, l.uom, l.cost_group,
           l.service_code, l.label,
           SUM(l.quantity)     AS quantity,
           SUM(l.amount_paise) AS amount_paise,
           COUNT(DISTINCT l.job_id) AS job_count,
           MIN(l.rate_milli)   AS rate_milli,
           SUM(CASE WHEN l.rate_status = 'not_configured' THEN 1 ELSE 0 END) AS unpriced_lines
      FROM job_cost_lines l
     WHERE l.annexure_id IN (${placeholders})
       AND l.cost_group = 'printing'
     GROUP BY l.paper_gsm, l.colour_mode, l.paper_size, l.uom, l.cost_group,
              l.service_code, l.label
  `).all(...annexureIds);

  // Fold A5 and B5 onto the sheet's single A5/B5 row. Done here rather than in SQL
  // because the grouping is a property of the template, not of the data.
  //
  // The service is part of the key: "Plain paper" A3/100 GSM and ordinary printing on
  // A3/100 GSM are indistinguishable in the paper columns but are separate rows on the
  // sheet at different rates. Merging them here would put a combined quantity on
  // whichever row matched first.
  const folded = new Map();
  for (const r of rows) {
    const size = templateSizeOf(r.paper_size);
    const key = `${r.service_code ?? ''}|${r.label ?? ''}|${r.paper_gsm ?? ''}|${r.colour_mode ?? ''}|${size ?? ''}`;
    const hit = folded.get(key);
    if (hit) {
      hit.quantity += Number(r.quantity || 0);
      hit.amount_paise += Number(r.amount_paise || 0);
      hit.unpriced_lines += Number(r.unpriced_lines || 0);
    } else {
      folded.set(key, {
        key,
        service_code: r.service_code,
        label: r.label,
        paper_gsm: r.paper_gsm,
        colour_mode: r.colour_mode,
        colour_label: COLOUR_LABEL[r.colour_mode] || r.colour_mode || null,
        paper_size: size,
        uom: r.uom,
        quantity: Number(r.quantity || 0),
        amount_paise: Number(r.amount_paise || 0),
        rate_milli: r.rate_milli,
        unpriced_lines: Number(r.unpriced_lines || 0),
      });
    }
  }
  return [...folded.values()].sort((a, b) =>
    String(a.paper_gsm).localeCompare(String(b.paper_gsm))
    || String(a.colour_mode).localeCompare(String(b.colour_mode))
    || String(a.paper_size).localeCompare(String(b.paper_size)));
};

/** Per-job quantities, so the detailed sheet can show what each job contributed. */
const linesByAnnexure = (annexureIds) => {
  if (!annexureIds.length) return new Map();
  const placeholders = annexureIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT l.annexure_id, l.service_code, l.label, l.cost_group, l.quantity, l.uom,
           l.paper_size, l.paper_gsm, l.colour_mode, l.variant,
           l.rate_milli, l.amount_paise, l.rate_status
      FROM job_cost_lines l
     WHERE l.annexure_id IN (${placeholders})
     ORDER BY l.annexure_id, l.cost_group, l.id
  `).all(...annexureIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.annexure_id)) map.set(r.annexure_id, []);
    map.get(r.annexure_id).push(r);
  }
  return map;
};

const zeroTotals = () => ({
  jobs: 0, printing_paise: 0, binding_paise: 0, finishing_paise: 0,
  misc_paise: 0, rework_paise: 0, grand_total_paise: 0, pages: 0, print_quantity: 0,
});

const addInto = (t, row) => {
  t.jobs += 1;
  // Straight from the approved annexure — the signed figure, never re-derived.
  t.printing_paise += Number(row.printing_paise || 0);
  t.binding_paise += Number(row.binding_paise || 0);
  t.finishing_paise += Number(row.finishing_paise || 0);
  t.misc_paise += Number(row.misc_paise || 0);
  t.rework_paise += Number(row.rework_paise || 0);
  t.grand_total_paise += Number(row.grand_total_paise || 0);
  t.pages += Number(row.number_of_pages || 0);
};

/**
 * The whole report for one month, in one deterministic shape used by both the preview
 * and the Excel writer — so what someone checks on screen is what the file contains.
 */
export const buildMonthlyReport = ({ monthKey, filters = {}, scope = null } = {}) => {
  const window = parseMonthKey(monthKey);
  if (!window) return { error: 'Provide a month as YYYY-MM.' };

  const rows = approvedAnnexuresFor(window, filters, scope);
  const annexureIds = rows.map((r) => r.annexure_id);
  const perJobLines = linesByAnnexure(annexureIds);
  const paperRows = paperAggregation(annexureIds);
  const printQuantity = paperRows.reduce((n, r) => n + r.quantity, 0);

  const managers = new Map();
  const totals = zeroTotals();

  for (const row of rows) {
    addInto(totals, row);

    const mKey = row.manager_id != null ? `m${row.manager_id}` : 'unassigned';
    if (!managers.has(mKey)) {
      managers.set(mKey, {
        manager_id: row.manager_id ?? null,
        manager_name: row.manager_name || 'Unassigned',
        manager_ps: row.manager_ps || null,
        members: new Map(),
        totals: zeroTotals(),
      });
    }
    const mgr = managers.get(mKey);
    addInto(mgr.totals, row);

    const uKey = row.requestor_id != null ? `u${row.requestor_id}` : `n${row.requestor_name || 'unknown'}`;
    if (!mgr.members.has(uKey)) {
      mgr.members.set(uKey, {
        requestor_id: row.requestor_id ?? null,
        requestor_name: row.requestor_name || 'Unknown',
        requestor_ps: row.requestor_ps || null,
        jobs: [],
        totals: zeroTotals(),
      });
    }
    const member = mgr.members.get(uKey);
    addInto(member.totals, row);

    member.jobs.push({
      job_id: row.job_id,
      job_number: row.job_number || row.request_id,
      request_id: row.request_id,
      annexure_no: row.annexure_no,
      version: row.version,
      approved_at: row.approved_at,
      project_name: row.project_name,
      project_no: row.dt_number,
      department_name: row.department_name,
      debit_code: row.debit_code,
      completed_at: row.completed_at,
      lead_name: row.lead_name,
      pages: Number(row.number_of_pages || 0),
      printing_paise: Number(row.printing_paise || 0),
      binding_paise: Number(row.binding_paise || 0),
      finishing_paise: Number(row.finishing_paise || 0),
      misc_paise: Number(row.misc_paise || 0),
      rework_paise: Number(row.rework_paise || 0),
      grand_total_paise: Number(row.grand_total_paise || 0),
      lines: perJobLines.get(row.annexure_id) || [],
    });
  }

  totals.print_quantity = printQuantity;

  // Distinct projects and request ids decide whether the Excel header can name one
  // project or must say "multiple" and defer to the detailed sheet.
  const projects = [...new Set(rows.map((r) => r.project_name).filter(Boolean))];
  const requestIds = [...new Set(rows.map((r) => r.job_number || r.request_id).filter(Boolean))];

  // Dropdown options for the month, derived from everything in scope BEFORE the other
  // filters are applied — otherwise choosing one manager empties the manager list and
  // there is no way back without a reset. Members carry their manager so the UI can
  // narrow the member list when a manager is picked, without another request.
  const scopeRows = approvedAnnexuresFor(window, {}, scope);
  const uniqueBy = (pick) => [...new Map(
    scopeRows.map(pick).filter((x) => x && x.value != null && String(x.value).trim() !== '')
      .map((x) => [String(x.value), x])).values()];

  return {
    month: { key: `${window.year}-${String(window.month).padStart(2, '0')}`, label: window.label,
             start_utc: window.startUtc, end_utc: window.endUtc },
    filters,
    options: {
      managers: uniqueBy((r) => ({ value: r.manager_id, label: r.manager_name, ps: r.manager_ps })),
      members: uniqueBy((r) => ({ value: r.requestor_id, label: r.requestor_name,
                                  ps: r.requestor_ps, manager_id: r.manager_id })),
      departments: uniqueBy((r) => ({ value: r.department_name, label: r.department_name })),
      debit_codes: uniqueBy((r) => ({ value: r.debit_code, label: r.debit_code })),
      projects: uniqueBy((r) => ({ value: r.project_name, label: r.project_name })),
    },
    totals,
    counts: {
      jobs: rows.length,
      managers: managers.size,
      members: [...managers.values()].reduce((n, m) => n + m.members.size, 0),
      projects: projects.length,
    },
    projects,
    request_ids: requestIds,
    // The Excel rate block: monthly cumulative quantity per paper/type/size.
    paper_rows: paperRows,
    managers: [...managers.values()].map((m) => ({
      ...m, members: [...m.members.values()],
    })),
  };
};

export { templateSizeOf, COLOUR_LABEL };
