
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const checkVouchers = async () => {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    const result = db.exec(`
        SELECT id, 
               status, 
               current_approval_level,
               approver1_name, 
               approver1_status, 
               approver2_name, 
               approver2_status 
        FROM voucher_requests 
        ORDER BY id DESC 
        LIMIT 5
    `);

    console.log("Recent Vouchers:");
    if (result.length > 0) {
        // Get column names
        const columns = result[0].columns;
        const values = result[0].values;

        console.log(JSON.stringify(values.map(row => {
            let obj = {};
            columns.forEach((col, i) => {
                obj[col] = row[i];
            });
            return obj;
        }), null, 2));
    } else {
        console.log("No vouchers found");
    }
};

checkVouchers();
