
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const checkSchema = async () => {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    const result = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
    console.log("Current Users Table Schema:");
    console.log(result[0].values[0][0]);

    // Check for 'initiator' existence
    if (result[0].values[0][0].includes('initiator')) {
        console.log("\nSUCCESS: 'initiator' role is present in CHECK constraint.");
    } else {
        console.log("\nFAILURE: 'initiator' role is MISSING from CHECK constraint.");
    }
};

checkSchema();
