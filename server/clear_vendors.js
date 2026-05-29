import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

if (!fs.existsSync(dbPath)) {
    console.error('Database file not found:', dbPath);
    process.exit(1);
}

const data = fs.readFileSync(dbPath);
const SQL = await initSqlJs();
const db = new SQL.Database(data);

const result = db.exec("SELECT COUNT(*) FROM vendors");
const beforeCount = result?.[0]?.values?.[0]?.[0] ?? 0;

const deleteResult = db.exec('DELETE FROM vendors');

const buf = Buffer.from(db.export());
fs.writeFileSync(dbPath, buf);

console.log(`Deleted ${beforeCount} vendors.`);

db.close();
