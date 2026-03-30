import express from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configure multer for Excel uploads with absolute path
const uploadDir = path.join(path.dirname(__dirname), '..', 'uploads', 'temp');

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Get all customers
router.get('/', authenticateToken, (req, res) => {
    try {
        const { search } = req.query;
        let query = 'SELECT * FROM customers WHERE 1=1';
        let params = [];

        if (search) {
            query += ' AND (customer_name LIKE ? OR customer_code LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY created_at DESC';
        const customers = db.prepare(query).all(...params);
        res.json(customers);
    } catch (error) {
        console.error('Error fetching customers:', error);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// Add new customer
router.post('/', authenticateToken, authorizeRoles('admin', 'coordinator'), (req, res) => {
    try {
        const {
            customer_code,
            customer_name,
            contact_person,
            email,
            phone,
            address,
            city,
            state,
            pincode,
            gst_number,
            pan_number
        } = req.body;

        if (!customer_name) {
            return res.status(400).json({ error: 'Customer name is required' });
        }

        const result = db.prepare(`
      INSERT INTO customers (
        customer_code, customer_name, contact_person, email, phone,
        address, city, state, pincode, gst_number, pan_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            customer_code || `CUST${Date.now()}`,
            customer_name,
            contact_person || '',
            email || '',
            phone || '',
            address || '',
            city || '',
            state || '',
            pincode || '',
            gst_number || '',
            pan_number || ''
        );

        res.json({ message: 'Customer added successfully', id: result.lastInsertRowid });
    } catch (error) {
        console.error('Error adding customer:', error);
        res.status(500).json({ error: 'Failed to add customer' });
    }
});

// Update customer
router.put('/:id', authenticateToken, authorizeRoles('admin', 'coordinator'), (req, res) => {
    try {
        const {
            customer_code,
            customer_name,
            contact_person,
            email,
            phone,
            address,
            city,
            state,
            pincode,
            gst_number,
            pan_number
        } = req.body;

        db.prepare(`
      UPDATE customers SET
        customer_code = ?,
        customer_name = ?,
        contact_person = ?,
        email = ?,
        phone = ?,
        address = ?,
        city = ?,
        state = ?,
        pincode = ?,
        gst_number = ?,
        pan_number = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
            customer_code,
            customer_name,
            contact_person,
            email,
            phone,
            address,
            city,
            state,
            pincode,
            gst_number,
            pan_number,
            req.params.id
        );

        res.json({ message: 'Customer updated successfully' });
    } catch (error) {
        console.error('Error updating customer:', error);
        res.status(500).json({ error: 'Failed to update customer' });
    }
});

// Delete customer
router.delete('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        // Check for associated projects first
        const projects = db.prepare('SELECT id FROM projects WHERE customer_id = ?').all(req.params.id);
        if (projects.length > 0) {
            return res.status(400).json({ error: 'Cannot delete customer with associated projects' });
        }

        db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
        res.json({ message: 'Customer deleted successfully' });
    } catch (error) {
        console.error('Error deleting customer:', error);
        res.status(500).json({ error: 'Failed to delete customer' });
    }
});

// Bulk import from Excel (Concerto format)
router.post('/upload-excel', authenticateToken, authorizeRoles('admin', 'coordinator'), upload.single('file'), (req, res) => {
    console.log('=== EXCEL UPLOAD START ===');
    try {
        if (!req.file) {
            console.log('ERROR: No file uploaded');
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log('File received:', req.file.path);
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        console.log('Sheet name:', sheetName);
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);
        console.log('Rows to import:', data.length);

        let imported = 0;
        let errors = [];

        const insertStmt = db.prepare(`
      INSERT INTO customers (
        customer_code, customer_name, contact_person, email, phone,
        address, city, state, pincode, gst_number, pan_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        console.log('Starting transaction...');
        db.transaction(() => {
            for (const row of data) {
                try {
                    // Map Excel columns to database fields
                    // concerto columns: 'Customer Code', 'Customer Name', 'Address', etc.
                    insertStmt.run(
                        row['Customer Code'] || row['Code'] || `CUST${Date.now()}${imported}`,
                        row['Customer Name'] || row['Name'],
                        row['Contact Person'] || '',
                        row['Email'] || '',
                        row['Phone'] || '',
                        row['Address'] || '',
                        row['City'] || '',
                        row['State'] || '',
                        row['Pincode'] || '',
                        row['GST No'] || '',
                        row['PAN No'] || ''
                    );
                    imported++;
                } catch (err) {
                    console.error('Row error:', err);
                    errors.push(`Row ${imported + 1}: ${err.message}`);
                }
            }
        })();
        console.log('Transaction complete. Imported:', imported);

        // Cleanup
        fs.unlinkSync(req.file.path);

        res.json({
            message: `Successfully imported ${imported} customers`,
            imported,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error('=== EXCEL UPLOAD ERROR ===');
        console.error('Error type:', error.constructor.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        if (req.file) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (e) {
                console.error('Failed to cleanup file:', e.message);
            }
        }
        res.status(500).json({ error: 'Failed to import customers' });
    }
});

export default router;
