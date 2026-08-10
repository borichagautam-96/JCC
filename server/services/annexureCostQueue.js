// Which cost annexures are still outstanding, and whose desk each one is on.
//
// Read-only: this drives the coordinator's "Awaiting approval" queue. There is no
// chasing or reminding — an annexure moves only when someone acts on it.

import db from '../database.js';

const paiseToRupees = (paise) =>
  `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The clock runs from the last time the figures moved, not from when the annexure was
// first issued: a coordinator correcting it re-opens the question, so counting from v1
// would report an age that has nothing to do with who is now sitting on it.
//
// Timestamps are naive UTC (`datetime('now')`), so the age is computed in SQL. Parsing
// them in JS would read them as local time and skew every figure here.
const PENDING_SQL = `
  SELECT
    a.id, a.annexure_no, a.job_id, a.version, a.grand_total_paise, a.issued_at, a.status,
    j.job_number, j.request_id, j.project_name, j.department_name,
    j.created_by AS requestor_id,
    r.name AS requestor_name, r.email AS requestor_email, r.manager_id,
    m.name AS manager_name, m.email AS manager_email,
    MAX(a.issued_at, COALESCE((SELECT MAX(l.accrued_at) FROM job_cost_lines l
                                WHERE l.annexure_id = a.id), a.issued_at)) AS waiting_since
  FROM cost_annexures a
  JOIN print_jobs j ON j.id = a.job_id
  LEFT JOIN users r ON r.id = j.created_by
  LEFT JOIN users m ON m.id = r.manager_id
  -- Both states are outstanding work, but they sit on different desks: a draft is with
  -- the printing team, an under_review is with the requestor.
  WHERE a.status IN ('draft', 'under_review')
`;

export const getPendingAnnexures = () => db.prepare(`
  SELECT *, CAST(julianday('now') - julianday(waiting_since) AS REAL) AS waiting_days_exact
    FROM (${PENDING_SQL})
   ORDER BY waiting_since ASC
`).all().map((row) => ({
  ...row,
  waiting_days: Math.floor(row.waiting_days_exact),
  grand_total_display: paiseToRupees(row.grand_total_paise),
  with_requestor: row.status === 'under_review',
}));
