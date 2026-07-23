import express from 'express';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

const normalizeVendorKey = (value) => String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();


// Get all POs
// Accessible by: Admin, Manager, Coordinator
router.get('/', authenticateToken, authorizeRoles('admin', 'manager', 'coordinator'), (req, res) => {
    try {
        const sql = `
            SELECT po.*, u.name as creator_name 
            FROM purchase_orders po
            LEFT JOIN users u ON po.created_by = u.id
            ORDER BY po.created_at DESC
        `;
        const pos = db.prepare(sql).all();
        res.json(pos);
    } catch (error) {
        console.error('Error fetching POs:', error);
        res.status(500).json({ error: 'Failed to fetch purchase orders' });
    }
});

// Get POs for a vendor (for claim form dropdowns)
router.get('/by-vendor', authenticateToken, (req, res) => {
    try {
        const rawVendor = String(req.query.vendor || '').trim();
        if (!rawVendor) {
            return res.status(400).json({ error: 'vendor query param is required' });
        }

        const baseQuery = `
            SELECT
                po_number,
                vendor_name,
                buyer_name,
                buyer_email,
                supplier_code,
                supplier_address,
                total_budget,
                po_date
            FROM purchase_orders
            WHERE vendor_name IS NOT NULL AND TRIM(vendor_name) != ''
            ORDER BY po_number ASC
        `;

        const exactRows = db.prepare(`
            ${baseQuery}
        `).all().filter((row) => String(row.vendor_name || '').trim().toLowerCase() === rawVendor.toLowerCase());

        if (exactRows.length > 0) {
            return res.json(exactRows);
        }

        const vendorKey = normalizeVendorKey(rawVendor);
        const fuzzyRows = db.prepare(baseQuery)
            .all()
            .filter((row) => {
                const rowKey = normalizeVendorKey(row.vendor_name);
                return rowKey && vendorKey && (rowKey.includes(vendorKey) || vendorKey.includes(rowKey));
            });

        return res.json(fuzzyRows);
    } catch (error) {
        console.error('Error fetching POs by vendor:', error);
        return res.status(500).json({ error: 'Failed to fetch purchase orders for vendor' });
    }
});

// Create new PO
// Accessible by: Admin only
router.post('/', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const { poNumber, supplierCode, supplierAddress, vendorName, buyerName, buyerEmail, totalBudget, poDate } = req.body;

        if (!poNumber || !totalBudget) {
            return res.status(400).json({ error: 'PO Number and Total Budget are required' });
        }

        const result = db.prepare(`
            INSERT INTO purchase_orders (po_number, supplier_code, supplier_address, vendor_name, buyer_name, buyer_email, total_budget, po_date, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(poNumber, supplierCode, supplierAddress, vendorName, buyerName, buyerEmail, totalBudget, poDate, req.user.id);

        res.status(201).json({
            message: 'Purchase Order created successfully',
            id: result.lastInsertRowid
        });
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'PO Number already exists' });
        }
        console.error('Error creating PO:', error);
        res.status(500).json({ error: 'Failed to create purchase order' });
    }
});

// Update PO
router.put('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const { poNumber, supplierCode, supplierAddress, vendorName, buyerName, buyerEmail, totalBudget, status, poDate } = req.body;
        const { id } = req.params;

        // COALESCE(?, status): when the caller omits status, keep the existing
        // value instead of nulling it — otherwise editing (e.g.) a PO's budget
        // would silently un-close a closed PO and let it accept claims again.
        db.prepare(`
            UPDATE purchase_orders
            SET po_number = ?, supplier_code = ?, supplier_address = ?, vendor_name = ?, buyer_name = ?, buyer_email = ?, total_budget = ?, status = COALESCE(?, status), po_date = ?
            WHERE id = ?
        `).run(poNumber, supplierCode, supplierAddress, vendorName, buyerName, buyerEmail, totalBudget, status, poDate, id);

        res.json({ message: 'Purchase Order updated successfully' });
    } catch (error) {
        console.error('Error updating PO:', error);
        res.status(500).json({ error: 'Failed to update purchase order' });
    }
});

// Delete PO
router.delete('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        // Check if used in vouchers? Ideally yes, but basic implementation for now.
        db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
        res.json({ message: 'Purchase Order deleted successfully' });
    } catch (error) {
        console.error('Error deleting PO:', error);
        res.status(500).json({ error: 'Failed to delete purchase order' });
    }
});

export default router;
