import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as XLSX from 'xlsx';
import app from '../index.js';
import db from '../database.js';
import { env } from '../config/env.js';

const user = db.prepare("SELECT id, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
if (!user) {
  throw new Error('No admin user found');
}

const sessionToken = `debug-session-${Date.now()}`;
const deviceId = 'debug-device-id';

// Ensure previous debug session rows are removed
try {
  db.prepare('DELETE FROM active_sessions WHERE session_token LIKE ?').run('debug-session-%');
} catch {}

db.prepare(`
  INSERT INTO active_sessions (user_id, device_id, session_token, user_agent, ip_address, expires_at)
  VALUES (?, ?, ?, ?, ?, datetime('now', '+2 hours'))
`).run(user.id, deviceId, sessionToken, 'debug-agent', '127.0.0.1');

const token = jwt.sign(
  { id: user.id, role: user.role, session_token: sessionToken },
  env.jwtSecret,
  { expiresIn: '2h' }
);

const rows = [
  [
    'BP ID',
    'BP Name',
    'City',
    'Country',
    'Date of NDA',
    'Expiry date of NDA',
    'Period Of NDA in Year',
    'Project Name',
    'Signed Hard Copy Depository Location',
    'Signed Hard Copy Depository Location FP',
    'Item Type',
    'Path'
  ],
  [
    'BP-1001',
    `Debug Vendor ${Date.now()}`,
    'Pune',
    'India',
    '2026-04-01',
    '2027-04-01',
    '1',
    'Project A',
    'Shelf A',
    'Folder 1',
    'Vendor',
    '/uploads/vendor/doc.pdf'
  ]
];

const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

const response = await request(app)
  .post('/api/vendors/import')
  .set('Authorization', `Bearer ${token}`)
  .set('X-Device-ID', deviceId)
  .attach('vendorFile', buffer, 'vendors.xlsx');

console.log('status:', response.status);
console.log('body:', JSON.stringify(response.body));
