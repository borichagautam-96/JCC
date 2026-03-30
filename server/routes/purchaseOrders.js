import express from 'express';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();


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

// Create new PO
// Accessible by: Admin only
router.post('/', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const { poNumber, supplierCode, supplierAddress, vendorName, totalBudget, poDate } = req.body;

        if (!poNumber || !totalBudget) {
            return res.status(400).json({ error: 'PO Number and Total Budget are required' });
        }

        const result = db.prepare(`
            INSERT INTO purchase_orders (po_number, supplier_code, supplier_address, vendor_name, total_budget, po_date, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(poNumber, supplierCode, supplierAddress, vendorName, totalBudget, poDate, req.user.id);

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
        const { poNumber, supplierCode, supplierAddress, vendorName, totalBudget, status, poDate } = req.body;
        const { id } = req.params;

        db.prepare(`
            UPDATE purchase_orders 
            SET po_number = ?, supplier_code = ?, supplier_address = ?, vendor_name = ?, total_budget = ?, status = ?, po_date = ?
            WHERE id = ?
        `).run(poNumber, supplierCode, supplierAddress, vendorName, totalBudget, status, poDate, id);

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
