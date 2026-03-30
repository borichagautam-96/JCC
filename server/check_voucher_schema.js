
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const checkVoucherSchema = async () => {
    const SQL = await initSqlJs();
    if (!fs.existsSync(dbPath)) {
        console.error('Database file not found');
        return;
    }
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    const result = db.exec("PRAGMA table_info(voucher_requests)");
    console.log("Voucher Requests Columns:");
    result[0].values.forEach(col => console.log(col[1], col[2]));
};

checkVoucherSchema();
