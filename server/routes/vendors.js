import express from 'express';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// Get all vendors
// Accessible by: Admin only
router.get('/', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const sql = `SELECT * FROM vendors ORDER BY created_at DESC`;
        const vendors = db.prepare(sql).all();
        res.json(vendors);
    } catch (error) {
        console.error('Error fetching vendors:', error);
        res.status(500).json({ error: 'Failed to fetch vendors' });
    }
});

// Create new vendor
// Accessible by: Admin only
router.post('/', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const { vendorCode, vendorName, address, contactNumber, mailId } = req.body;
        const normalizedVendorName = String(vendorName || '').trim();

        if (!normalizedVendorName) {
            return res.status(400).json({ error: 'Vendor Name is required' });
        }

        const existingByName = db.prepare(`
            SELECT id, vendor_name
            FROM vendors
            WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))
            LIMIT 1
        `).get(normalizedVendorName);

        if (existingByName) {
            return res.status(400).json({ error: 'Vendor Name already exists' });
        }

        let finalVendorCode = String(vendorCode || '').trim();
        if (!finalVendorCode) {
            // Auto-generate code when admin only provides vendor name.
            let attempts = 0;
            do {
                const suffix = String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
                finalVendorCode = `V${suffix}`;
                const existingByCode = db.prepare('SELECT id FROM vendors WHERE vendor_code = ?').get(finalVendorCode);
                if (!existingByCode) break;
                attempts += 1;
            } while (attempts < 5);
        }

        if (!finalVendorCode) {
            return res.status(500).json({ error: 'Failed to generate vendor code' });
        }

        const result = db.prepare(`
            INSERT INTO vendors (vendor_code, vendor_name, address, contact_number, mail_id)
            VALUES (?, ?, ?, ?, ?)
        `).run(finalVendorCode, normalizedVendorName, address, contactNumber, mailId);

        res.status(201).json({
            message: 'Vendor created successfully',
            id: result.lastInsertRowid,
            vendorCode: finalVendorCode,
            vendorName: normalizedVendorName
        });
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Vendor already exists' });
        }
        console.error('Error creating vendor:', error);
        res.status(500).json({ error: 'Failed to create vendor' });
    }
});

// Update vendor
router.put('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const { vendorCode, vendorName, address, contactNumber, mailId } = req.body;
        const { id } = req.params;

        db.prepare(`
            UPDATE vendors
            SET vendor_code = ?, vendor_name = ?, address = ?, contact_number = ?, mail_id = ?
            WHERE id = ?
        `).run(vendorCode, vendorName, address, contactNumber, mailId, id);

        res.json({ message: 'Vendor updated successfully' });
    } catch (error) {
        console.error('Error updating vendor:', error);
        res.status(500).json({ error: 'Failed to update vendor' });
    }
});

// Delete vendor
router.delete('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        db.prepare('DELETE FROM vendors WHERE id = ?').run(req.params.id);
        res.json({ message: 'Vendor deleted successfully' });
    } catch (error) {
        console.error('Error deleting vendor:', error);
        res.status(500).json({ error: 'Failed to delete vendor' });
    }
});

export default router;
