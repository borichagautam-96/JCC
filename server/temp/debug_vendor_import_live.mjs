import jwt from 'jsonwebtoken';
import * as XLSX from 'xlsx';
import db from '../database.js';

const jwtSecret = 'When-Gautam-Is-Here-Nothing-To-Fear';

const user = db.prepare("SELECT id, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
if (!user) throw new Error('No admin user found');

const sessionToken = `debug-session-${Date.now()}`;
const deviceId = 'debug-device-id';

try {
  db.prepare('DELETE FROM active_sessions WHERE session_token LIKE ?').run('debug-session-%');
} catch {}

db.prepare(`
  INSERT INTO active_sessions (user_id, device_id, session_token, user_agent, ip_address, expires_at)
  VALUES (?, ?, ?, ?, ?, datetime('now', '+2 hours'))
`).run(user.id, deviceId, sessionToken, 'debug-agent', '127.0.0.1');

const token = jwt.sign({ id: user.id, role: user.role, session_token: sessionToken }, jwtSecret, { expiresIn: '2h' });

const rows = [
  [
    'BP ID','BP Name','City','Country','Date of NDA','Expiry date of NDA','Period Of NDA in Year','Project Name','Signed Hard Copy Depository Location','Signed Hard Copy Depository Location FP','Item Type','Path'
  ],
  [
    'BP-1001',`Debug Vendor ${Date.now()}`,'Pune','India','2026-04-01','2027-04-01','1','Project A','Shelf A','Folder 1','Vendor','/uploads/vendor/doc.pdf'
  ]
];

const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

const form = new FormData();
const fileBlob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
form.append('vendorFile', fileBlob, 'vendors.xlsx');

const response = await fetch('http://localhost:8032/api/vendors/import', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Device-ID': deviceId,
  },
  body: form,
});

let body;
const text = await response.text();
try { body = JSON.parse(text); } catch { body = text; }

console.log('status:', response.status);
console.log('body:', body);
