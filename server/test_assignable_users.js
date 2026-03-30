import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const db = new Database(path.join(__dirname, 'jcc.db'));

console.log('Testing /api/users/assignable endpoint query...\n');

try {
    const users = db.prepare(`
        SELECT id, ps_number, name, email, role
        FROM users 
        WHERE role IN ('user', 'initiator', 'manager', 'coordinator', 'admin')
        ORDER BY name ASC
    `).all();

    console.log(`Found ${users.length} assignable users:\n`);
    users.forEach(user => {
        console.log(`- ${user.name} (${user.ps_number || 'no PS number'}) - Role: ${user.role}`);
    });

    console.log('\nJSON output:');
    console.log(JSON.stringify(users, null, 2));
} catch (error) {
    console.error('Error:', error.message);
}

db.close();
