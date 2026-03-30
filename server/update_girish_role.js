
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const updateRole = async () => {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    console.log("Updating Girish Pakhode to 'final_approver'...");

    db.exec(`UPDATE users SET role = 'final_approver' WHERE name LIKE '%Girish Pakhode%'`);

    // Verify
    const result = db.exec("SELECT id, name, role FROM users WHERE name LIKE '%Girish Pakhode%'");
    if (result.length > 0) {
        console.log("Updated User:", result[0].values[0]);
    } else {
        console.log("User not found.");
    }

    const data = db.export();
    const outBuffer = Buffer.from(data);
    fs.writeFileSync(dbPath, outBuffer);
    console.log("Database saved.");
};

updateRole();
