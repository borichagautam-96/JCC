
const db = require('./database.js');

try {
    console.log('Verifying PO Date Refactor...');

    // 1. Verify Column Exists
    const tableInfo = db.prepare("PRAGMA table_info(purchase_orders)").all();
    const hasPoDate = tableInfo.some(col => col.name === 'po_date');

    if (!hasPoDate) {
        throw new Error('FAILED: po_date column does not exist in purchase_orders table.');
    }
    console.log('✓ po_date column exists.');

    // 2. Create PO with Date
    const testPO = {
        po_number: 'TEST-PO-' + Date.now(),
        description: 'Test PO Date',
        vendor_name: 'Test Vendor',
        total_budget: 50000,
        po_date: '2025-01-30', // YYYY-MM-DD
        created_by: 1 // Assuming admin exists
    };

    const insertResult = db.prepare(`
        INSERT INTO purchase_orders (po_number, description, vendor_name, total_budget, po_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(testPO.po_number, testPO.description, testPO.vendor_name, testPO.total_budget, testPO.po_date, testPO.created_by);

    console.log('✓ PO created with date:', testPO.po_date);

    // 3. Fetch and Verify
    const fetchedPO = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(insertResult.lastInsertRowid);

    if (fetchedPO.po_date !== testPO.po_date) {
        throw new Error(`FAILED: Date mismatch. Expected ${testPO.po_date}, got ${fetchedPO.po_date}`);
    }
    console.log('✓ PO fetch verified date match.');

    // 4. Update PO Date
    const newDate = '2025-02-15';
    db.prepare("UPDATE purchase_orders SET po_date = ? WHERE id = ?").run(newDate, fetchedPO.id);

    const updatedPO = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(fetchedPO.id);
    if (updatedPO.po_date !== newDate) {
        throw new Error(`FAILED: Update mismatch. Expected ${newDate}, got ${updatedPO.po_date}`);
    }
    console.log('✓ PO update verified new date:', updatedPO.po_date);

    // Cleanup
    db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(fetchedPO.id);
    console.log('✓ Test data cleaned up.');
    console.log('SUCCESS: PO Date Refactor verified.');

} catch (error) {
    console.error('VERIFICATION FAILED:', error.message);
    process.exit(1);
}
