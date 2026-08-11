// Monthly Report preview UI, driven against the running app.
//
// These run the real page against the real API and database rather than a mocked
// component, because the risks worth catching here are integration ones: a filter that
// does not reach the query, a total the UI recomputes differently from the server, a
// month boundary that shifts. A mocked fetch would pass while any of those were broken.
//
// Skipped automatically when the dev server is not up, so `npm test` stays runnable
// without one.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../middleware/auth.js';

// These drive the RUNNING app, so they must read and write the database that app is
// using — not the throwaway one `npm test` points DB_PATH at for the isolated suites.
// Seeding into the test database would leave the browser showing an empty month while
// the fixtures sat somewhere the server never looks.
const appDbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../database.db');
const db = new Database(appDbPath);

const UI = process.env.UI_BASE || 'http://localhost:8033';
const PW = 'file:///C:/Users/admin/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';

const up = await fetch(UI, { signal: AbortSignal.timeout(2500) }).then(() => true).catch(() => false);
const chromium = up ? (await import(PW)).chromium : null;

const uniq = () => `ui-${process.pid}-${Number(process.hrtime.bigint() % 1000000n)}`;
const JULY = '2026-07-15 06:00:00';
const AUGUST = '2026-08-15 06:00:00';

const mkUser = (name, { role = 'user', managerId = null, coordinator = false } = {}) => {
  const ref = `${uniq()}-${name}`;
  const id = Number(db.prepare(
    `INSERT INTO users (ps_number, name, email, password, role, manager_id,
                        is_printer_coordinator, profile_completed, profile_verified_at)
     VALUES (?, ?, ?, 'x', ?, ?, ?, 1, datetime('now'))`
  ).run(ref, name, `${ref}@example.test`, role, managerId, coordinator ? 1 : 0).lastInsertRowid);
  // profile_completed / profile_verified_at must be on the object too: ProtectedRoute
  // reads them from the stored user, and without them every route redirects to
  // /complete-profile — so the page under test never renders at all.
  return {
    id, name, role, ps_number: ref,
    is_printer_coordinator: coordinator ? 1 : 0,
    is_printer_operator: 0,
    profile_completed: 1,
    profile_verified_at: new Date().toISOString(),
  };
};

const mkJob = (requestor, manager, o = {}) => {
  const ref = uniq();
  const jobId = Number(db.prepare(
    `INSERT INTO print_jobs (request_id, job_number, status, created_by, completed_at,
                             manager_id_at_submit, manager_name_at_submit, manager_ps_at_submit,
                             project_name, department_name, debit_code, number_of_pages)
     VALUES (?, ?, 'completed', ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)`
  ).run(`REQ-${ref}`, `JOB-${ref}`, requestor.id, manager.id, manager.name, manager.ps_number,
        o.project ?? 'Alpha', o.department ?? 'Engineering', o.debit ?? '3559', o.pages ?? 250).lastInsertRowid);

  const pr = o.printing ?? 100000, bi = o.binding ?? 17500, fi = o.finishing ?? 0;
  const aid = Number(db.prepare(
    `INSERT INTO cost_annexures (annexure_no, job_id, version, status, approved_at,
                                 printing_paise, binding_paise, finishing_paise,
                                 basic_paise, grand_total_paise, line_count)
     VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, 1)`
  ).run(`PCA-${ref}`, jobId, o.approvedAt, pr, bi, fi, pr + bi + fi, pr + bi + fi).lastInsertRowid);

  db.prepare(
    `INSERT INTO job_cost_lines (job_id, service_code, label, cost_group, quantity, uom,
                                 rate_milli, amount_paise, rate_status, paper_size, paper_gsm,
                                 colour_mode, annexure_id)
     VALUES (?, 'PRINT', 'Printing', 'printing', ?, 'page', 1150, ?, 'priced', ?, ?, ?, ?)`
  ).run(jobId, o.qty ?? 100, pr, o.size ?? 'A4', o.gsm ?? '80', o.colour ?? 'BW', aid);

  db.prepare("UPDATE cost_annexures SET status='approved' WHERE id=?").run(aid);
  return { jobId, jobNumber: `JOB-${ref}` };
};

// Always paired with a try/finally at the call site: a failing assertion must not
// leave fixtures behind for the next run — or for whoever opens the app next.
const cleanup = (jobIds, userIds) => {
  jobIds.forEach((id) => {
    try {
      // Unlock before deleting: the approved-annexure triggers refuse to drop its lines.
      db.prepare("UPDATE cost_annexures SET status='superseded' WHERE job_id=?").run(id);
      db.prepare('DELETE FROM annexure_approvals WHERE annexure_id IN (SELECT id FROM cost_annexures WHERE job_id=?)').run(id);
      db.prepare('DELETE FROM job_cost_lines WHERE job_id=?').run(id);
      db.prepare('DELETE FROM cost_annexures WHERE job_id=?').run(id);
      db.prepare('DELETE FROM print_jobs WHERE id=?').run(id);
    } catch (e) { console.warn('[ui-tests] could not clean job', id, e.message); }
  });
  userIds.forEach((id) => {
    try {
      db.prepare('DELETE FROM notifications WHERE user_id=?').run(id);
      db.prepare('DELETE FROM audit_logs WHERE user_id=?').run(id);
      db.prepare('DELETE FROM user_activity_logs WHERE user_id=?').run(id);
      // A fixture manager is referenced by its own reports; clear that before deleting.
      db.prepare('UPDATE users SET manager_id=NULL WHERE manager_id=?').run(id);
      db.prepare('DELETE FROM users WHERE id=?').run(id);
    } catch (e) { console.warn('[ui-tests] could not clean user', id, e.message); }
  });
};

// One browser for the whole file. Launching per test loaded the full page each time
// and exhausted the API rate limiter (600 requests / 15 min, shared), after which every
// remaining test failed with 429s that looked like UI bugs.
let sharedBrowser = null;
const getBrowser = async () => {
  if (!sharedBrowser) sharedBrowser = await chromium.launch();
  return sharedBrowser;
};
// Sweep anything this file created, whatever happened during the run.
//
// These write to the LIVE database — that is the point, since they drive the running
// app — so a crashed or interrupted run must not leave fixtures behind for the next
// person who opens the page. Every row is prefixed 'ui-', so the sweep is exact.
const sweepFixtures = () => {
  const jobs = db.prepare(
    "SELECT id FROM print_jobs WHERE job_number LIKE 'JOB-ui-%' OR request_id LIKE 'REQ-ui-%'"
  ).all().map((r) => r.id);
  cleanup(jobs, db.prepare("SELECT id FROM users WHERE ps_number LIKE 'ui-%'").all().map((r) => r.id));
  return jobs.length;
};

test.after(async () => {
  await sharedBrowser?.close();
  const left = sweepFixtures();
  if (left) console.log(`[ui-tests] swept ${left} leftover fixture job(s)`);
});

/** Opens the Monthly Report tab signed in as `user`, and hands the page to `fn`. */
const onPanel = async (user, fn, { route = '/print-cost' } = {}) => {
  const browser = await getBrowser();
  let page = null;
  try {
    page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET);
    await page.addInitScript(([t, u]) => {
      localStorage.setItem('token', t);
      localStorage.setItem('user', u);
      localStorage.setItem('sessionExpiry', String(Date.now() + 8 * 3600 * 1000));
      localStorage.setItem('deviceId', 'ui-test');
    }, [token, JSON.stringify(user)]);
    await page.goto(UI + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const tab = page.getByRole('button', { name: /^Monthly Report$/ });
    if (await tab.count()) { await tab.click(); await page.waitForTimeout(1400); }
    return await fn(page, errors);
  } finally {
    await page?.close();
  }
};

const pickMonth = async (page, key) => {
  await page.locator('select[aria-label="Month"]').selectOption(key);
  await page.waitForTimeout(1600);
};
const bodyText = (page) => page.locator('body').innerText();

// ── 1–3, 15, 19: month selection, hierarchy, formatting ─────────────────────────

test('the default month is the current IST month, and switching months reloads', { skip: !up && 'dev server not running' }, async () => {
  const coord = mkUser('UiCoord', { coordinator: true });
  const mgr = mkUser('UiGautam', { role: 'manager' });
  const rahul = mkUser('UiRahul', { managerId: mgr.id });
  const july = Array.from({ length: 5 }, () => mkJob(rahul, mgr, { approvedAt: JULY }));
  const august = Array.from({ length: 3 }, () => mkJob(rahul, mgr, { approvedAt: AUGUST }));

  try {
  await onPanel(coord, async (page, errors) => {
    // 1. default = current IST month, not the browser's month
    const istKey = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);
    assert.equal(await page.locator('select[aria-label="Month"]').inputValue(), istKey);

    // 2. July
    await pickMonth(page, '2026-07');
    let text = await bodyText(page);
    assert.match(text, /July 2026/);
    assert.match(text, /UiGautam/, '15: manager hierarchy is shown');
    assert.match(text, /UiRahul/);
    // 19: INR formatting with thousands separators and two decimals
    assert.match(text, /₹[\d,]+\.\d{2}/);

    // 3. August — and July's jobs must not linger
    await pickMonth(page, '2026-08');
    text = await bodyText(page);
    assert.match(text, /August 2026/);
    for (const j of july) assert.equal(text.includes(j.jobNumber), false, 'no July job in August');
    assert.ok(august.some((j) => text.includes(j.jobNumber)), 'August jobs are listed');

    assert.deepEqual(errors, [], 'no uncaught page errors');
  });

  } finally {
  cleanup([...july, ...august].map((j) => j.jobId), [coord.id, mgr.id, rahul.id]);
  }
});

// ── 4–10: filters ───────────────────────────────────────────────────────────────

test('manager, member, department, debit code and project filters each narrow the report', { skip: !up && 'dev server not running' }, async () => {
  const coord = mkUser('FilCoord', { coordinator: true });
  const g = mkUser('FilGautam', { role: 'manager' });
  const p = mkUser('FilPriyaMgr', { role: 'manager' });
  const rahul = mkUser('FilRahul', { managerId: g.id });
  const amit = mkUser('FilAmit', { managerId: p.id });

  const a = mkJob(rahul, g, { approvedAt: JULY, project: 'Alpha', department: 'Engineering', debit: '3559' });
  const b = mkJob(amit, p, { approvedAt: JULY, project: 'Beta', department: 'Quality', debit: '4001' });

  try {
  await onPanel(coord, async (page) => {
    await pickMonth(page, '2026-07');
    const sel = async (label, value) => {
      await page.locator(`select[aria-label="${label}"]`).selectOption(String(value));
      await page.waitForTimeout(1500);
    };

    // 4 + 10: manager filter, and the member list follows the chosen manager
    await sel('Manager', g.id);
    let text = await bodyText(page);
    assert.ok(text.includes(a.jobNumber) && !text.includes(b.jobNumber), '4: manager filter');
    const members = await page.locator('select[aria-label="Team member"] option').allInnerTexts();
    assert.ok(members.some((m) => m.includes('FilRahul')), '10: own team listed');
    assert.equal(members.some((m) => m.includes('FilAmit')), false, '10: other team excluded');

    // 5: member filter
    await sel('Team member', rahul.id);
    assert.match(await bodyText(page), new RegExp(a.jobNumber));

    // 9: reset restores everything for the month
    await page.getByRole('button', { name: /Reset filters/ }).click();
    await page.waitForTimeout(1600);
    text = await bodyText(page);
    assert.ok(text.includes(a.jobNumber) && text.includes(b.jobNumber), '9: reset filters');

    // 6: department
    await sel('Department', 'Quality');
    text = await bodyText(page);
    assert.ok(!text.includes(a.jobNumber) && text.includes(b.jobNumber), '6: department filter');

    await page.getByRole('button', { name: /Reset filters/ }).click();
    await page.waitForTimeout(1600);

    // 7: debit code
    await sel('Debit code', '4001');
    text = await bodyText(page);
    assert.ok(!text.includes(a.jobNumber) && text.includes(b.jobNumber), '7: debit code filter');

    await page.getByRole('button', { name: /Reset filters/ }).click();
    await page.waitForTimeout(1600);

    // 8: project
    await sel('Project', 'Alpha');
    text = await bodyText(page);
    assert.ok(text.includes(a.jobNumber) && !text.includes(b.jobNumber), '8: project filter');
  });

  } finally {
  cleanup([a.jobId, b.jobId], [coord.id, g.id, p.id, rahul.id, amit.id]);
  }
});

// ── 11: multiple projects ───────────────────────────────────────────────────────

test('a month spanning several projects says so instead of naming one', { skip: !up && 'dev server not running' }, async () => {
  const coord = mkUser('ProjCoord', { coordinator: true });
  const mgr = mkUser('ProjMgr', { role: 'manager' });
  const user = mkUser('ProjUser', { managerId: mgr.id });
  const one = mkJob(user, mgr, { approvedAt: JULY, project: 'Alpha' });

  let two = null;
  try {
  await onPanel(coord, async (page) => {
    await pickMonth(page, '2026-07');
    assert.match(await bodyText(page), /Project:\s*Alpha/, 'a single project is named');
  });

  two = mkJob(user, mgr, { approvedAt: JULY, project: 'Beta' });
  await onPanel(coord, async (page) => {
    await pickMonth(page, '2026-07');
    // Naming one project for a mixed month would misattribute the whole month's cost.
    assert.match(await bodyText(page), /Multiple Projects/);
  });

  } finally {
  cleanup([one.jobId, two?.jobId].filter(Boolean), [coord.id, mgr.id, user.id]);
  }
});

// ── 12: no data ─────────────────────────────────────────────────────────────────

test('an empty month says so rather than showing a confident zero', { skip: !up && 'dev server not running' }, async () => {
  const coord = mkUser('EmptyCoord', { coordinator: true });
  try {
  await onPanel(coord, async (page) => {
    // Must be a month the picker actually offers — it spans 18 months back, so a date
    // far in the past would hang waiting for an option that is never rendered. The
    // oldest offered month is reliably empty for a freshly created coordinator.
    const oldest = await page.locator('select[aria-label="Month"] option').last().getAttribute('value');
    const label = await page.locator('select[aria-label="Month"] option').last().innerText();
    await pickMonth(page, oldest);
    const text = await bodyText(page);
    assert.match(text, new RegExp(`No approved printing jobs found for ${label.trim()}`));
    // A grid of ₹0.00 tiles reads as "the month cost nothing", not "nothing qualified".
    assert.equal(/Grand total/i.test(text), false, 'summary tiles are hidden when empty');
  });
  } finally {
  cleanup([], [coord.id]);
  }
});

// ── 16–18: the printing summary ─────────────────────────────────────────────────

test('paper rows aggregate, A5/B5 stays combined and A4/A3 stay separate', { skip: !up && 'dev server not running' }, async () => {
  const coord = mkUser('PaperCoord', { coordinator: true });
  const mgr = mkUser('PaperMgr', { role: 'manager' });
  const user = mkUser('PaperUser', { managerId: mgr.id });
  const jobs = [
    mkJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 500 }),
    mkJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A4', qty: 300 }),
    mkJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A3', qty: 80 }),
    mkJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'COLOUR', size: 'A4', qty: 200 }),
    mkJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'A5', qty: 25 }),
    mkJob(user, mgr, { approvedAt: JULY, gsm: '80', colour: 'BW', size: 'B5', qty: 15 }),
  ];

  try {
  await onPanel(coord, async (page) => {
    await pickMonth(page, '2026-07');
    await page.locator('select[aria-label="Team member"]').selectOption(String(user.id));
    await page.waitForTimeout(1600);

    // Read the cells by their column heading rather than by position: the table has
    // gained a column before now, and an index-based read fails as a wrong quantity
    // rather than as a missing column, which is far harder to place.
    const table = page.locator('table').filter({ hasText: 'Paper' }).first();
    const headers = (await table.locator('thead th').allTextContents()).map((h) => h.trim());
    const rows = await table.locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())));
    const col = (r, name) => r[headers.indexOf(name)];
    const find = (gsm, type, size) => rows.find((r) =>
      col(r, 'Paper') === `${gsm} GSM` && col(r, 'Type') === type && col(r, 'Size') === size);
    const qty = (gsm, type, size) => col(find(gsm, type, size), 'Quantity');

    // 16 + 17: aggregated, and the combined row is preserved
    assert.equal(qty('80', 'B&W', 'A4'), '800', '500 + 300 aggregated into one row');
    assert.ok(find('80', 'B&W', 'A5/B5'), '17: A5 and B5 share the template row');
    assert.equal(qty('80', 'B&W', 'A5/B5'), '40', '25 + 15');
    // 18: A4 and A3 must never be merged — the template reports them separately
    assert.equal(qty('80', 'B&W', 'A3'), '80');
    assert.ok(find('80', 'Color', 'A4'), 'colour stays its own row');
    assert.equal(rows.some((r) => col(r, 'Size') === 'A4/A3'), false, '18: no folded A4/A3 row');
  });

  } finally {
  cleanup(jobs.map((j) => j.jobId), [coord.id, mgr.id, user.id]);
  }
});

// ── 14, 20: errors never leave stale figures on screen ──────────────────────────

test('a failed reload clears the previous month rather than showing it under a new heading', { skip: !up && 'dev server not running' }, async () => {
  const coord = mkUser('ErrCoord', { coordinator: true });
  const mgr = mkUser('ErrMgr', { role: 'manager' });
  const user = mkUser('ErrUser', { managerId: mgr.id });
  const job = mkJob(user, mgr, { approvedAt: JULY });

  try {
  await onPanel(coord, async (page) => {
    await pickMonth(page, '2026-07');
    assert.match(await bodyText(page), new RegExp(job.jobNumber), 'July loaded');

    // Break the endpoint, then change month.
    await page.route('**/api/annexures/monthly-report*', (r) => r.abort());
    await pickMonth(page, '2026-08');

    const text = await bodyText(page);
    assert.match(text, /Unable to load the monthly report/, '14: error state');
    assert.ok(await page.getByRole('button', { name: /Retry/ }).count(), '14: retry offered');
    assert.equal(text.includes(job.jobNumber), false, '20: stale figures are cleared');
  });

  } finally {
  cleanup([job.jobId], [coord.id, mgr.id, user.id]);
  }
});

// ── 21: RBAC ────────────────────────────────────────────────────────────────────

test('a manager sees only their own team in the preview', { skip: !up && 'dev server not running' }, async () => {
  const mine = mkUser('RbacMine', { role: 'manager' });
  const theirs = mkUser('RbacTheirs', { role: 'manager' });
  const myMember = mkUser('RbacMember', { managerId: mine.id });
  const theirMember = mkUser('RbacOther', { managerId: theirs.id });
  const a = mkJob(myMember, mine, { approvedAt: JULY });
  const b = mkJob(theirMember, theirs, { approvedAt: JULY });

  try {
  await onPanel(mine, async (page) => {
    await pickMonth(page, '2026-07');
    const text = await bodyText(page);
    assert.ok(text.includes(a.jobNumber), 'own team is visible');
    assert.equal(text.includes(b.jobNumber), false, 'another team is not');
    assert.equal(text.includes('RbacTheirs'), false, 'and is not even named');
  });

  } finally {
  cleanup([a.jobId, b.jobId], [mine.id, theirs.id, myMember.id, theirMember.id]);
  }
});

// ── Totals come from the API, not from the browser ──────────────────────────────

test('the totals on screen match the API exactly', { skip: !up && 'dev server not running' }, async () => {
  const coord = mkUser('SumCoord', { coordinator: true });
  const mgr = mkUser('SumMgr', { role: 'manager' });
  const rahul = mkUser('SumRahul', { managerId: mgr.id });
  const priya = mkUser('SumPriya', { managerId: mgr.id });
  const jobs = [
    mkJob(rahul, mgr, { approvedAt: JULY, printing: 100000, binding: 17500, finishing: 0 }),
    mkJob(rahul, mgr, { approvedAt: JULY, printing: 150000, binding: 0, finishing: 4200 }),
    mkJob(priya, mgr, { approvedAt: JULY, printing: 300000, binding: 52500, finishing: 20000 }),
  ];

  const token = jwt.sign({ id: coord.id, name: coord.name, role: coord.role }, JWT_SECRET);
  const api = await fetch(`http://localhost:8032/api/annexures/monthly-report?month=2026-07&manager=${mgr.id}`,
    { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  const expected = `₹${(api.totals.grand_total_paise / 100).toLocaleString('en-IN',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  try {
  await onPanel(coord, async (page) => {
    await pickMonth(page, '2026-07');
    await page.locator('select[aria-label="Manager"]').selectOption(String(mgr.id));
    await page.waitForTimeout(1600);
    // If the UI ever recomputed totals itself, this is where the two would diverge.
    assert.match(await bodyText(page), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  } finally {
  cleanup(jobs.map((j) => j.jobId), [coord.id, mgr.id, rahul.id, priya.id]);
  }
});
