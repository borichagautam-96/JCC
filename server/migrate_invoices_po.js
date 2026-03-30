
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const migrate = async () => {
    console.log('Starting migration for po_number...');
    const SQL = await initSqlJs();

    if (!fs.existsSync(dbPath)) {
        console.error('Database file not found!');
        process.exit(1);
    }

    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    try {
        // Check if column exists
        const result = db.exec("PRAGMA table_info(invoices)");
        const columns = result[0].values.map(col => col[1]);

        if (columns.includes('po_number')) {
            console.log('Column po_number already exists in invoices table.');
        } else {
            console.log('Adding po_number column to invoices table...');
            db.run("ALTER TABLE invoices ADD COLUMN po_number TEXT");

            // Save changes
            const data = db.export();
            const newBuffer = Buffer.from(data);
            fs.writeFileSync(dbPath, newBuffer);
            console.log('Migration successful: po_number column added.');
        }

        // Verify
        const verify = db.exec("PRAGMA table_info(invoices)");
        console.log('Updated columns:', verify[0].values.map(col => col[1]));

    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        db.close();
    }
};

migrate();
