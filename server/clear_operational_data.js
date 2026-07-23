// Clean-slate for production deployment.
// KEEPS: users, vendors, purchase_orders, app_settings (admin config).
// DELETES all rows from every other table (JCCs, invoices, drafts, notifications,
// reminders, logs, sessions, …) and resets their AUTOINCREMENT counters so new
// records start from 1.
//
// Usage:  DB_PATH=./database.clean.db node server/clear_operational_data.js
// (Run against a COPY, or with the app stopped. Always back up first.)

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '../database.db');

const KEEP = new Set(['users', 'vendors', 'purchase_orders', 'app_settings']);

const db = new Database(dbPath);
db.pragma('foreign_keys = OFF');

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((r) => r.name);

const toClear = tables.filter((t) => !KEEP.has(t));

console.log(`DB: ${dbPath}`);
console.log(`Keeping: ${[...KEEP].join(', ')}`);
console.log(`Clearing ${toClear.length} tables...`);

const clearAll = db.transaction(() => {
  for (const t of toClear) {
    const before = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    db.prepare(`DELETE FROM "${t}"`).run();
    // reset AUTOINCREMENT so new ids start at 1
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t);
    if (before > 0) console.log(`  cleared ${String(before).padStart(5)} rows  ${t}`);
  }
});
clearAll();

// Unbind every account's device registration so a fresh deploy doesn't inherit
// dev-machine bindings (otherwise users hit "this browser is already registered
// to another account" and can't log in).
db.prepare(`
  UPDATE users SET
    registered_device_id = NULL,
    device_bound_at = NULL,
    device_user_agent = NULL,
    device_bound_ip = NULL
`).run();
console.log('Unbound all user devices.');

// reclaim space
db.exec('VACUUM');

console.log('\nDone. Kept:');
for (const t of KEEP) {
  const c = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
  console.log(`  ${String(c).padStart(5)} rows  ${t}`);
}
db.close();
