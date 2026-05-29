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

const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('users','vendors')");
if (result.length > 0) {
    const tableNames = result[0].values.map(r => r[0]);
    console.log('Tables to clear (keeping users + vendors):', tableNames);

    tableNames.forEach(t => {
        db.run(`DELETE FROM ${t}`);
        console.log(`  Cleared: ${t}`);
    });

    const buf = Buffer.from(db.export());
    fs.writeFileSync(dbPath, buf);
    console.log('\nDone! All data cleared except users and vendors.');
} else {
    console.log('No tables found to clear.');
}

db.close();
