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

// Get all tables except 'users'
const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name != 'users'");
if (result.length > 0) {
    const tableNames = result[0].values.map(r => r[0]);
    console.log('Tables to clear (keeping users):', tableNames);

    tableNames.forEach(t => {
        db.run(`DELETE FROM ${t}`);
        console.log(`  Cleared: ${t}`);
    });

    const buf = Buffer.from(db.export());
    fs.writeFileSync(dbPath, buf);
    console.log('\nDone! All data cleared except users.');
} else {
    console.log('No tables found to clear.');
}
db.close();
