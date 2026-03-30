
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const migrate = async () => {
    console.log('Starting migration...');
    const SQL = await initSqlJs();

    if (!fs.existsSync(dbPath)) {
        console.error('Database file not found at:', dbPath);
        process.exit(1);
    }

    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    try {
        // Check current schema
        const result = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
        const currentSql = result[0].values[0][0];
        console.log('Current Schema:', currentSql);

        if (currentSql.includes('initiator')) {
            console.log('Migration already applied.');
            return;
        }

        console.log('Applying migration...');

        // Create new table
        db.exec(`
            CREATE TABLE users_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ps_number TEXT UNIQUE,
              name TEXT NOT NULL,
              email TEXT UNIQUE NOT NULL,
              password TEXT NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('vendor', 'coordinator', 'admin', 'manager', 'initiator', 'user', 'final_approver')),
              manager_id INTEGER,
              must_change_password INTEGER DEFAULT 1,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (manager_id) REFERENCES users(id)
            )
        `);

        // Copy data
        // Note: We need to handle the case where 'manager_id' column might not exist in old table if that migration also failed,
        // but based on "manager" role existing, it probably exists.
        // Let's check headers first to be safe.
        const columns = db.exec("PRAGMA table_info(users)")[0].values.map(c => c[1]);
        const hasManagerId = columns.includes('manager_id');
        const hasPsNumber = columns.includes('ps_number');
        const hasMustChange = columns.includes('must_change_password');

        console.log('Existing columns:', columns);

        let selectFields = ['id', 'name', 'email', 'password', 'role', 'created_at'];
        if (hasPsNumber) selectFields.push('ps_number');
        if (hasManagerId) selectFields.push('manager_id');
        if (hasMustChange) selectFields.push('must_change_password');

        let insertFields = [...selectFields];
        // if migrating vendor->initiator, we handle role in select

        const selectStmt = `
            SELECT 
                id, 
                ${hasPsNumber ? 'ps_number' : 'NULL as ps_number'},
                name, 
                email, 
                password, 
                CASE WHEN role = 'vendor' THEN 'initiator' ELSE role END as role,
                ${hasManagerId ? 'manager_id' : 'NULL as manager_id'},
                ${hasMustChange ? 'must_change_password' : '1 as must_change_password'},
                created_at
            FROM users
        `;

        db.exec(`
            INSERT INTO users_new (id, ps_number, name, email, password, role, manager_id, must_change_password, created_at)
            ${selectStmt}
        `);

        db.exec('DROP TABLE users');
        db.exec('ALTER TABLE users_new RENAME TO users');

        // Verify result
        const newResult = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
        console.log('New Schema:', newResult[0].values[0][0]);

        // Save
        const data = db.export();
        const outBuffer = Buffer.from(data);
        fs.writeFileSync(dbPath, outBuffer);
        console.log('Migration successful and saved.');

    } catch (err) {
        console.error('Migration failed:', err);
    }
};

migrate();
