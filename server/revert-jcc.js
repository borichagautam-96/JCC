import db from './database.js';

async function revertJccNumbers() {
    console.log('Reverting JCC numbers to JCC0001 format...');
    
    const rows = db.prepare(`SELECT id, jcc_number FROM voucher_requests WHERE jcc_number LIKE 'JCC/%'`).all();
    console.log(`Found ${rows.length} vouchers with JCC/YY-YY/NNNN format.`);
    
    for (const row of rows) {
        const jccNum = `JCC${String(row.id).padStart(4, '0')}`;
        db.prepare(`UPDATE voucher_requests SET jcc_number = ? WHERE id = ?`).run(jccNum, row.id);
        console.log(`Reverted voucher ${row.id}: ${row.jcc_number} -> ${jccNum}`);
    }
    
    console.log('Done.');
}

revertJccNumbers().catch(console.error);
