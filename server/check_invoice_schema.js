
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const check = async () => {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    const result = db.exec("PRAGMA table_info(invoices)");
    const columns = result[0].values.map(col => col[1]);
    console.log('Columns:', columns);

    if (columns.includes('po_number')) {
        console.log('po_number exists');
    } else {
        console.log('po_number MISSING');
    }
};
check();
