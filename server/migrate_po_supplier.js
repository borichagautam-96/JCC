import db from './database.js';

// Migration: Add supplier_code and supplier_address to purchase_orders,
// and remove (by effectively ignoring) the old description column.

try {
    // Check existing columns
    const cols = db.prepare("PRAGMA table_info(purchase_orders)").all();
    const colNames = cols.map(c => c.name);

    if (!colNames.includes('supplier_code')) {
        db.prepare("ALTER TABLE purchase_orders ADD COLUMN supplier_code TEXT").run();
        console.log('✅ Added supplier_code to purchase_orders');
    } else {
        console.log('ℹ️  supplier_code already exists');
    }

    if (!colNames.includes('supplier_address')) {
        db.prepare("ALTER TABLE purchase_orders ADD COLUMN supplier_address TEXT").run();
        console.log('✅ Added supplier_address to purchase_orders');
    } else {
        console.log('ℹ️  supplier_address already exists');
    }

    console.log('Migration complete.');
} catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
}
