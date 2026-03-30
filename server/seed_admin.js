import initSqlJs from 'sql.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../database.db');

const data = fs.readFileSync(dbPath);
const SQL = await initSqlJs();
const db = new SQL.Database(data);

// Clear all users
db.run("DELETE FROM users");
console.log('Cleared all users.');

// Hash the password
const hashedPassword = bcrypt.hashSync('Admin@123', 10);

// Insert admin user — only use columns that exist in the schema
db.run(
    `INSERT INTO users (ps_number, name, email, password, role, must_change_password) VALUES (?, ?, ?, ?, ?, ?)`,
    ['123456789', 'Admin', 'admin@jcc.com', hashedPassword, 'admin', 0]
);
console.log('Created admin user:');
console.log('  PS Number: 123456789');
console.log('  Password:  Admin@123');
console.log('  Role:      admin');

// Save
const buf = Buffer.from(db.export());
fs.writeFileSync(dbPath, buf);
console.log('\nDone! Database saved.');
db.close();
