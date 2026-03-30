import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(path.join(__dirname, 'jcc.db'));

console.log('Adding missing columns to invoices table...\n');

try {
    // Check if assigned_to column exists
    const columns = db.prepare("PRAGMA table_info(invoices)").all();
    const hasAssignedTo = columns.some(col => col.name === 'assigned_to');
    const hasPoNumber = columns.some(col => col.name === 'po_number');

    if (!hasAssignedTo) {
        console.log('Adding assigned_to column...');
        db.prepare('ALTER TABLE invoices ADD COLUMN assigned_to TEXT').run();
        console.log('✓ assigned_to column added');
    } else {
        console.log('✓ assigned_to column already exists');
    }

    if (!hasPoNumber) {
        console.log('Adding po_number column...');
        db.prepare('ALTER TABLE invoices ADD COLUMN po_number TEXT').run();
        console.log('✓ po_number column added');
    } else {
        console.log('✓ po_number column already exists');
    }

    console.log('\nUpdated invoice table schema:');
    const updatedColumns = db.prepare("PRAGMA table_info(invoices)").all();
    updatedColumns.forEach(col => {
        console.log(`  - ${col.name}: ${col.type}${col.notnull ? ' NOT NULL' : ''}${col.dflt_value ? ' DEFAULT ' + col.dflt_value : ''}`);
    });

} catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
}

db.close();
console.log('\n✅ Database schema updated successfully!');
