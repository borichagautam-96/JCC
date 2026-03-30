import db from './database.js';

const voucherId = 21;

db.prepare(`
    UPDATE voucher_requests SET
    approver2_status = 'approved',
    approver2_remark = 'Manual approval fix via support',
    approver2_date = datetime('now'),
    current_approval_level = NULL,
    status = 'approved'
    WHERE id = ?
`).run(voucherId);

console.log(`Voucher ${voucherId} manually updated to approved.`);
