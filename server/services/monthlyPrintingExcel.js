// Monthly printing report → the printing department's own Excel workbook.
//
// The template is loaded and EDITED, never rebuilt. That is the whole design: it
// carries 466 formulas, 101 merged ranges, grey fills, borders, column widths and the
// rate block itself, none of which we should be recreating. We write quantities and
// header text into empty cells and let Excel do the arithmetic it already knows how to
// do.
//
// Two rules follow from that and are load-bearing:
//   * Never write to an Amount cell (F/H/J/L) — each holds a formula like $D8*E8.
//     Writing a number there replaces the formula with a static value, and the sheet
//     stops reconciling the moment anyone edits a quantity.
//   * Never write to a rate cell (D). The template and the app's rate master come from
//     the same workbook; overwriting D would fork them.

import ExcelJS from 'exceljs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMonthlyReport } from './monthlyPrintingReport.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE = path.join(projectRoot, 'PRINTING ANEXERE_2022 RATE CHANGE1.xlsx');

const SHEET = 'PRINTING_ANNEXURE';
const RATE_FIRST_ROW = 8;
const RATE_LAST_ROW = 48;

// Columns, by the template's own layout.
const COL = { PAPER: 1, TYPE: 2, SIZE: 3, RATE: 4, QTY: 5 }; // E is the first Qty block

const rupees = (paise) => Number(paise || 0) / 100;

/**
 * A month-window boundary as the IST calendar date a printing manager would write.
 *
 * The window is stored as naive UTC and is half-open: July 2026 runs from
 * '2026-06-30 18:30:00' up to but NOT including '2026-07-31 18:30:00'. Converting to
 * IST gives 1 July and 1 August; the close date wants the last day actually covered,
 * hence `minusOneDay` on the exclusive end.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;
export const istDateOf = (naiveUtc, { minusOneDay = false } = {}) => {
  if (!naiveUtc) return '';
  const ms = Date.parse(`${String(naiveUtc).replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + IST_OFFSET_MS - (minusOneDay ? 86400000 : 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

// The sheet writes B&W / Color / B/W / COLOUR in different rows. Reduce to the two
// modes the data actually carries so a lookup does not miss on spelling alone.
const colourKeyOf = (label) => {
  const s = norm(label);
  if (!s) return null;
  if (s.includes('B&W') || s === 'B/W') return s.includes('CLR') || s.includes('COLOR') ? 'ANY' : 'BW';
  if (s.includes('COLOUR') || s.includes('COLOR')) return 'COLOUR';
  return null; // NORMAL, VIP, 100 GSM, Y/W/B/P — not a colour mode at all
};

// GSM as the data records it: '80', '100'. These are the plain-stock rows only.
// Speciality papers — "100 GSM Clr Machine", "PLAIN PAPER", "SCANNING" — carry the same
// GSM and size as a plain row and are told apart by the SERVICE, not the paper columns.
// They are excluded here and matched by label below; folding them in by GSM alone would
// price colour-machine or scanning work at the plain-paper rate.
const gsmKeyOf = (paper) => {
  const s = norm(paper);
  if (/CLR MACHINE|PLAIN|PLAN|CARDBOARD|POUCH|SCANNING|COLOUR CARD|F\/B/.test(s)) return null;
  const m = /^(\d+)\s*GSM$/.exec(s);
  return m ? m[1] : null;
};

// Speciality rows keyed by the template's own paper text, so a service label can find
// them without the row numbers being written down here.
const SPECIALITY = [
  { test: (s) => /COLOUR MACHINE|CLR MACHINE/.test(s), paper: /CLR MACHINE/, needsGsm: true },
  { test: (s) => /SCANNING/.test(s),                   paper: /^SCANNING$/,  needsGsm: false },
  { test: (s) => /PLAIN PAPER|PLAN PAPER/.test(s),     paper: /^PLA[IN]N? PAPER$/, needsGsm: true },
  { test: (s) => /POUCH FLAP/.test(s),                 paper: /POUCH FLAP/,  needsGsm: false },
  { test: (s) => /POUCH/.test(s),                      paper: /^PLASTIK POUCH$/, needsGsm: false },
  { test: (s) => /CARDBOARD/.test(s),                  paper: /CARDBOARD/,   needsGsm: false },
];

/**
 * Read the template's own rate block and build a lookup from the data's aggregation key
 * to a row number. Derived from the sheet rather than hardcoded, so re-ordering a row
 * or adding a paper in the workbook does not silently misfile quantities.
 */
export const buildRowIndex = (ws) => {
  const index = new Map();
  const rows = [];
  let paper = '';
  let type = '';
  for (let r = RATE_FIRST_ROW; r <= RATE_LAST_ROW; r += 1) {
    const p = ws.getCell(r, COL.PAPER).value;
    const t = ws.getCell(r, COL.TYPE).value;
    const size = ws.getCell(r, COL.SIZE).value;
    // Paper and type are written once and apply down the merged block beneath them.
    if (p != null && String(p).trim()) paper = String(p);
    if (t != null && String(t).trim()) type = String(t);
    if (size == null || !String(size).trim()) continue;

    const gsm = gsmKeyOf(paper);
    const colour = colourKeyOf(type);
    const entry = { row: r, paper: String(paper).trim(), type: String(type).replace(/\s+/g, ' ').trim(),
                    size: norm(size), gsm, colour };
    rows.push(entry);
    if (gsm && colour) index.set(`${gsm}|${colour}|${norm(size)}`, r);
  }
  return { index, rows };
};

/**
 * Which template row a monthly paper row belongs on, or null if none matches.
 *
 * Speciality services are resolved first, by label: "Plain paper" A3/100 and plain
 * "Printing" A3/100 look identical in the paper columns but belong on different rate
 * rows, and only the service says which.
 *
 * A row whose colour_mode is not recorded is NOT assumed to be B&W — the two modes are
 * priced differently, so a guess silently misprices. It goes to `unmapped` instead.
 */
const rowFor = (index, rows, paperRow) => {
  const gsm = String(paperRow.paper_gsm ?? '').trim();
  const size = norm(paperRow.paper_size);
  const label = norm(paperRow.label);

  const spec = SPECIALITY.find((s) => s.test(label));
  if (spec) {
    // The GSM sits in the Paper column for "100 GSM Clr Machine" but in the Type column
    // for "PLAIN PAPER" / "100 GSM". Check both rather than assuming a layout.
    const hit = rows.find((r) => spec.paper.test(norm(r.paper)) && r.size === size
      && (!spec.needsGsm || !gsm
        || norm(r.paper).startsWith(gsm) || norm(r.type).startsWith(gsm)));
    return hit ? hit.row : null;
  }

  const mode = norm(paperRow.colour_mode);
  if (mode !== 'COLOUR' && mode !== 'BW') return null; // unrecorded — never guessed
  return index.get(`${gsm}|${mode}|${size}`)
    // A row priced for either mode ("B&W or Clr") takes both.
    ?? index.get(`${gsm}|ANY|${size}`)
    ?? null;
};

// The template is a file on disk that does not change between requests, so its row
// index is read once and reused. Keeps the preview cheap enough to call on every
// filter change.
let cachedIndex = null;
const templateIndex = async () => {
  if (!cachedIndex) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(TEMPLATE);
    cachedIndex = buildRowIndex(wb.getWorksheet(SHEET));
  }
  return cachedIndex;
};

/**
 * Split a month's paper rows into those the template can price and those it cannot.
 *
 * Exported so the preview, the Excel and the audit trail all answer this question the
 * same way. A row here is "unmapped" because the TEMPLATE has no row for it — the job
 * itself may well be priced. It carries no template rate, so it must not be presented
 * as a priced line, and the sheet's Grand Total cannot include it.
 */
export const classifyPaperRows = async (paperRows = []) => {
  const { index, rows } = await templateIndex();
  const mapped = [];
  const unmapped = [];
  for (const p of paperRows) {
    const row = rowFor(index, rows, p);
    (row ? mapped : unmapped).push(row ? { ...p, template_row: row } : { ...p, template_row: null });
  }
  return { mapped, unmapped };
};

/** One-line description of an unmapped row, for headers, the UI and the audit trail. */
export const describeUnmapped = (u) =>
  `${u.label || 'Printing'} — ${u.paper_gsm ?? '?'} GSM / `
  + `${u.colour_label || u.colour_mode || '?'} / ${u.paper_size ?? '?'} (qty ${u.quantity})`;

const HEADER_ROWS = { LEAD: 1, PROJECT_NAME: 2, PROJECT_NO: 3, REQUEST_IDS: 4, START: 5, CLOSE: 6 };
const HEADER_VALUE_COL = 5; // E — the first job block's header cells

// K5 and K6 are the only free cells in the template's header block — masters of empty
// merges, clear of the E/G/I job blocks and of the K1:L4 "TOTAL PRINT / OR / AMOUNT /
// po no" label stack. K5 names the month the sheet covers (START/CLOSE DATE hold real
// dates and cannot say "July 2026"); K6 carries the unpriced-item warning when there
// is one.
const MONTH_CELL = 'K5';
const WARNING_CELL = 'K6';

const styleFrom = (ws, addr) => {
  const c = ws.getCell(addr);
  return { font: c.font, border: c.border, alignment: c.alignment, fill: c.fill };
};

const addSheet = (wb, name, columns, rows, { widths } = {}) => {
  const ws = wb.addWorksheet(name);
  ws.addRow(columns);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  rows.forEach((r) => ws.addRow(r));
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = widths?.[i] ?? Math.max(12, String(c).length + 4); });
  return ws;
};

/**
 * Build the workbook for one month.
 *
 * `report` must come from buildMonthlyReport — the same call the preview makes — so the
 * file and the screen can never disagree.
 */
export const generateMonthlyWorkbook = async (report) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);

  // exceljs does not evaluate formulas. Without this the file opens showing the cached
  // zeros the template was saved with, and every Amount reads 0 until someone edits a
  // cell. This tells Excel to recalculate the whole book on open.
  wb.calcProperties.fullCalcOnLoad = true;

  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error(`Template is missing the ${SHEET} sheet`);
  const { index, rows: templateRows } = buildRowIndex(ws);

  // ── Header ──
  // A monthly report spans many jobs, so a field that cannot describe the whole month
  // says so and defers to Detailed Jobs rather than naming one job arbitrarily.
  //
  // Each row holds what its own label promises. START DATE and CLOSE DATE are dates —
  // they carry the reporting window, not a month name and not a person. The manager
  // belongs on the D&T LEAD row beside the initiator, which is what "D&T LEAD /
  // INITIATOR" asks for.
  const members = [...new Set(report.managers.flatMap((m) => m.members.map((x) => x.requestor_name)))];
  const managerNames = [...new Set(report.managers.map((m) => m.manager_name).filter(Boolean))];
  const set = (row, value) => {
    const cell = ws.getCell(row, HEADER_VALUE_COL);
    cell.value = value;
  };

  // "Manager / Initiator" — both sides named when each is unambiguous.
  const leadPart = managerNames.length === 1 ? managerNames[0]
    : `${managerNames.length} Managers - See Detailed Jobs`;
  const initiatorPart = members.length === 1 ? members[0]
    : `${members.length} Team Members - See Detailed Jobs`;
  set(HEADER_ROWS.LEAD, `${leadPart} / ${initiatorPart}`);

  set(HEADER_ROWS.PROJECT_NAME, report.projects.length === 1
    ? report.projects[0] : 'Multiple Projects - See Detailed Jobs');
  set(HEADER_ROWS.PROJECT_NO, report.projects.length === 1
    ? (report.managers[0]?.members[0]?.jobs[0]?.project_no || '') : 'Multiple Projects');
  set(HEADER_ROWS.REQUEST_IDS, report.request_ids.length === 1
    ? report.request_ids[0] : 'Multiple - See Detailed Jobs');

  // The reporting window as real dates: the first and last IST day the month covers.
  // end_utc is the exclusive boundary — the instant the next month begins — so the
  // close date is the day before it, otherwise July would close on 1 August.
  set(HEADER_ROWS.START, istDateOf(report.month.start_utc));
  set(HEADER_ROWS.CLOSE, istDateOf(report.month.end_utc, { minusOneDay: true }));

  // The dates above give the window but not its name. Stated once, in the one free
  // header cell, so the sheet identifies its own month without a date field having to
  // carry text.
  const monthCell = ws.getCell(MONTH_CELL);
  monthCell.value = `Monthly Report: ${report.month.label}`;
  monthCell.font = { bold: true };

  // ── Quantities into column E only ──
  const unmapped = [];
  for (const p of report.paper_rows) {
    const row = rowFor(index, templateRows, p);
    if (!row) { unmapped.push(p); continue; }
    // Accumulate: two data rows can legitimately land on one template row (a size the
    // sheet prices together), and overwriting would drop the first one's quantity.
    const cell = ws.getCell(row, COL.QTY);
    cell.value = Number(cell.value || 0) + Number(p.quantity || 0);
  }

  // ── Detailed Jobs: the audit trail behind every figure above ──
  const jobRows = [];
  for (const mgr of report.managers) {
    for (const member of mgr.members) {
      for (const job of member.jobs) {
        const printLines = job.lines.filter((l) => l.cost_group === 'printing');
        const qty = printLines.reduce((n, l) => n + Number(l.quantity || 0), 0);
        const spec = (pick) => [...new Set(printLines.map(pick).filter(Boolean))].join(', ');
        jobRows.push([
          job.job_number, job.annexure_no,
          mgr.manager_name, mgr.manager_ps || '',
          member.requestor_name, member.requestor_ps || '',
          job.department_name || '', job.debit_code || '',
          job.project_name || '', job.project_no || '', job.project_no || '',
          spec((l) => l.label), '',
          job.pages, qty, '',
          spec((l) => l.paper_size), spec((l) => l.paper_gsm), spec((l) => l.colour_mode),
          [...new Set(job.lines.filter((l) => l.cost_group === 'binding').map((l) => l.label))].join(', '),
          [...new Set(job.lines.filter((l) => l.cost_group === 'finishing').map((l) => l.label))].join(', '),
          job.approved_at ? String(job.approved_at).slice(0, 10) : '',
          member.requestor_name,
          rupees(job.printing_paise), rupees(job.binding_paise),
          rupees(job.finishing_paise), rupees(job.grand_total_paise),
        ]);
      }
    }
  }
  const detail = addSheet(wb, 'Detailed Jobs', [
    'Job Number', 'Annexure Number', 'Manager', 'Manager PS', 'Team Member', 'Requestor PS',
    'Department', 'Debit Code', 'Project Name', 'Project Number', 'DT Number',
    'Document Name', 'PDF File Name', 'Pages', 'Quantity', 'Print Side',
    'Paper Size', 'GSM', 'Colour Mode', 'Binding Type', 'Finishing',
    'Approval Date', 'Approved By',
    'Printing Cost', 'Binding Cost', 'Finishing Cost', 'Grand Total',
  ], jobRows, { widths: [18, 20, 16, 12, 16, 13, 16, 11, 18, 14, 12, 24, 18, 8, 10, 12, 11, 8, 12, 16, 18, 13, 16, 13, 12, 13, 13] });
  [24, 25, 26, 27].forEach((c) => { detail.getColumn(c).numFmt = '#,##0.00'; });

  // ── Manager / team summary ──
  const summaryRows = [];
  for (const mgr of report.managers) {
    for (const member of mgr.members) {
      summaryRows.push([
        mgr.manager_name, member.requestor_name, member.totals.jobs, member.totals.pages,
        rupees(member.totals.printing_paise), rupees(member.totals.binding_paise),
        rupees(member.totals.finishing_paise), rupees(member.totals.grand_total_paise),
      ]);
    }
    summaryRows.push([
      `${mgr.manager_name} — total`, '', mgr.totals.jobs, mgr.totals.pages,
      rupees(mgr.totals.printing_paise), rupees(mgr.totals.binding_paise),
      rupees(mgr.totals.finishing_paise), rupees(mgr.totals.grand_total_paise),
    ]);
  }
  summaryRows.push([
    `${report.month.label} — grand total`, '', report.totals.jobs, report.totals.pages,
    rupees(report.totals.printing_paise), rupees(report.totals.binding_paise),
    rupees(report.totals.finishing_paise), rupees(report.totals.grand_total_paise),
  ]);
  const mgrSheet = addSheet(wb, 'Manager Summary',
    ['Manager', 'Team Member', 'Jobs', 'Pages', 'Printing', 'Binding', 'Finishing', 'Total'],
    summaryRows, { widths: [26, 20, 8, 10, 13, 12, 13, 14] });
  [5, 6, 7, 8].forEach((c) => { mgrSheet.getColumn(c).numFmt = '#,##0.00'; });

  // ── Cost breakdown ──
  const costRows = jobRows.map((r) => [r[0], r[1], r[23], r[24], r[25], r[26]]);
  const costSheet = addSheet(wb, 'Cost Breakdown',
    ['Job Number', 'Annexure Number', 'Printing Cost', 'Binding Cost', 'Finishing Cost', 'Grand Total'],
    costRows, { widths: [18, 20, 14, 13, 14, 14] });
  [3, 4, 5, 6].forEach((c) => { costSheet.getColumn(c).numFmt = '#,##0.00'; });

  // ── Unmapped items ──
  //
  // A paper/service the template has no row for cannot be priced by this sheet. It is
  // neither guessed at nor dropped: it gets its own sheet, and the annexure sheet says
  // so in the header, because a quantity that is simply absent looks like a month in
  // which that work never happened.
  //
  // No amount is written. The rate column says RATE NOT CONFIGURED, so nothing here can
  // be mistaken for a priced line or read into the Grand Total.
  if (unmapped.length) {
    const sheet = addSheet(wb, 'Unmapped Items', [
      'Service', 'Paper (GSM)', 'Type', 'Size', 'Quantity', 'Rate', 'Amount', 'Status',
    ], unmapped.map((u) => [
      u.label || 'Printing', u.paper_gsm ?? '', u.colour_label || u.colour_mode || '',
      u.paper_size ?? '', Number(u.quantity || 0),
      'RATE NOT CONFIGURED', 'NOT INCLUDED IN TOTAL', 'UNMAPPED',
    ]), { widths: [26, 12, 10, 10, 10, 22, 24, 12] });

    const note = sheet.addRow([]);
    sheet.addRow(['These items are NOT included in the Grand Total.']);
    sheet.addRow(['The current rate template has no row for them, so no rate can be applied.']);
    sheet.addRow(['They are listed here rather than priced by analogy with another paper.']);
    for (let r = note.number + 1; r <= sheet.rowCount; r += 1) {
      sheet.getRow(r).getCell(1).font = { bold: true, color: { argb: 'FFB00020' } };
    }
    sheet.eachRow((row, i) => {
      if (i === 1 || i > note.number) return;
      ['F', 'G', 'H'].forEach((c) => {
        row.getCell(c).font = { bold: true, color: { argb: 'FFB00020' } };
      });
    });

    // And on the sheet a printing manager actually reads. K5/K6 are the master cells of
    // their own merges and are empty in the template — F6 would land inside the E6
    // merge and be dropped.
    const warn = ws.getCell(WARNING_CELL);
    warn.value = `⚠ ${unmapped.length} unpriced item(s) EXCLUDED from this sheet `
      + '— see the Unmapped Items tab';
    warn.font = { bold: true, color: { argb: 'FFB00020' } };
  }

  return { workbook: wb, unmapped, jobCount: jobRows.length };
};

/** Safe, descriptive filename: Printing_Annexure_July_2026_Gautam.xlsx */
export const workbookFilename = (report, { managerName, memberName } = {}) => {
  const clean = (s) => String(s ?? '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const parts = ['Printing_Annexure', clean(report.month.label)];
  if (memberName) parts.push(clean(memberName));
  else if (managerName) parts.push(clean(managerName));
  return `${parts.filter(Boolean).join('_')}.xlsx`;
};

export { TEMPLATE, SHEET, COL, RATE_FIRST_ROW, RATE_LAST_ROW, rowFor };
