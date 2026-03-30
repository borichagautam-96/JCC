import db from './database.js';

const users = db.prepare('SELECT id, name, role FROM users WHERE name LIKE "%Girish%"').all();
console.log('Users:', JSON.stringify(users, null, 2));

const vouchers = db.prepare('SELECT id, status, current_approval_level, approver1_status, approver2_status FROM voucher_requests WHERE id = 21').all();
console.log('Voucher 21:', JSON.stringify(vouchers, null, 2));
