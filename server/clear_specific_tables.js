import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const data = fs.readFileSync(dbPath);
const SQL = await initSqlJs();
const db = new SQL.Database(data);

const tables = ['active_sessions', 'audit_logs', 'device_bind_audit', 'notifications', 'voucher_materials', 'voucher_requests'];

for (const table of tables) {
    const exists = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
    if (exists.length > 0 && exists[0].values.length > 0) {
        const countRes = db.exec(`SELECT COUNT(*) FROM ${table}`);
        const count = countRes[0].values[0][0];
        db.run(`DELETE FROM ${table}`);
        console.log(`Cleared: ${table} (${count} rows deleted)`);
    } else {
        console.log(`Skipped: ${table} (table does not exist)`);
    }
}

const buf = Buffer.from(db.export());
fs.writeFileSync(dbPath, buf);
console.log('\nDone! Selected tables cleared.');
db.close();
