import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

if (!fs.existsSync(dbPath)) {
    console.error('Database file not found');
    process.exit(1);
}

const data = fs.readFileSync(dbPath);
const SQL = await initSqlJs();
const db = new SQL.Database(data);

const result = db.exec(`SELECT name FROM sqlite_master WHERE type='table'`);
if (result.length > 0) {
    const tableNames = result[0].values.map(r => r[0]);
    for(const t of tableNames) {
        const countRes = db.exec(`SELECT COUNT(*) FROM ${t}`);
        if(countRes.length > 0) {
            console.log(`${t}: ${countRes[0].values[0][0]}`);
        }
    }
}
db.close();
