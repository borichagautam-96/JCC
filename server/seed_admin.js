// Emergency admin recovery.
//
// Run this only when nobody can sign in as an administrator. It creates an admin
// account, or resets the password of an existing one — it does NOT touch any other
// user. (The previous version of this script opened with `DELETE FROM users`, wiping
// every account in the database, and then created an admin with a hardcoded password.
// Both are gone.)
//
// Usage:
//   node --env-file=.env server/seed_admin.js --confirm
//   ADMIN_SEED_PASSWORD='...' node --env-file=.env server/seed_admin.js --confirm
//
// Without --confirm it prints what it would do and exits, so an accidental run is
// harmless. The password comes from ADMIN_SEED_PASSWORD when set, otherwise a random
// one is generated and printed once. Either way the account is flagged
// must_change_password, so the bootstrap credential only works long enough to replace it.

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '../database.db');

const psNumber = process.env.ADMIN_SEED_PS_NUMBER || '123456789';
const email = process.env.ADMIN_SEED_EMAIL || 'admin@jcc.com';
const confirmed = process.argv.includes('--confirm');

const db = new Database(dbPath);
const existing = db.prepare('SELECT id, name, role FROM users WHERE ps_number = ?').get(psNumber);

if (!confirmed) {
  console.log(`Database : ${dbPath}`);
  console.log(existing
    ? `Would RESET the password for existing user ${psNumber} (${existing.name}, role ${existing.role}).`
    : `Would CREATE a new admin user ${psNumber} <${email}>.`);
  console.log('\nNo changes made. Re-run with --confirm to proceed.');
  process.exit(0);
}

const supplied = process.env.ADMIN_SEED_PASSWORD;
const password = supplied || `${crypto.randomBytes(18).toString('base64url')}aA1!`;
const hash = bcrypt.hashSync(password, 10);

if (existing) {
  db.prepare(`UPDATE users SET password = ?, must_change_password = 1, role = 'admin',
              failed_login_attempts = 0, locked_until = NULL, deleted_at = NULL WHERE id = ?`)
    .run(hash, existing.id);
  console.log(`Reset password for ${psNumber} (${existing.name}).`);
} else {
  db.prepare(`INSERT INTO users (ps_number, name, email, password, role, must_change_password)
              VALUES (?, 'Admin', ?, ?, 'admin', 1)`).run(psNumber, email, hash);
  console.log(`Created admin ${psNumber} <${email}>.`);
}

console.log(`  PS Number: ${psNumber}`);
console.log(supplied ? '  Password : (from ADMIN_SEED_PASSWORD)' : `  Password : ${password}`);
console.log('  This account must change its password at next sign-in.');
db.close();
