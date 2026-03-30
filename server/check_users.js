
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const checkUsers = async () => {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    const result = db.exec("SELECT * FROM users WHERE role = 'final_approver'");
    console.log("Final Approvers in DB:");
    if (result.length > 0) {
        result[0].values.forEach(row => console.log(row));
    } else {
        console.log("No users found with role 'final_approver'");
    }

    const allUsers = db.exec("SELECT id, name, role FROM users");
    console.log("\nAll Users Role Summary:");
    allUsers[0].values.forEach(r => console.log(`${r[1]}: ${r[2]}`));
};

checkUsers();
