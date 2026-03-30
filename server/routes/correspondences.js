import express from 'express';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { generateCorrespondenceQR, generateDigitalSignature } from '../utils/qrGenerator.js';

const router = express.Router();

// Get all correspondences
router.get('/', authenticateToken, (req, res) => {
    try {
        const { search, project_id, customer_id, status, limit = 50, offset = 0 } = req.query;

        let query = `
      SELECT c.*, p.project_name, p.project_code,
             cu.customer_name, u.name as created_by_name
      FROM correspondences c
      LEFT JOIN projects p ON c.project_id = p.id
      JOIN customers cu ON c.customer_id = cu.id
      JOIN users u ON c.created_by = u.id
      WHERE 1=1
    `;
        let params = [];

        if (search) {
            query += ' AND (c.subject LIKE ? OR c.correspondence_number LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }

        if (project_id) {
            query += ' AND c.project_id = ?';
            params.push(project_id);
        }

        if (customer_id) {
            query += ' AND c.customer_id = ?';
            params.push(customer_id);
        }

        if (status) {
            query += ' AND c.status = ?';
            params.push(status);
        }

        query += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const correspondences = db.prepare(query).all(...params);
        const total = db.prepare('SELECT COUNT(*) as count FROM correspondences').get();

        res.json({
            correspondences,
            total: total.count
        });
    } catch (error) {
        console.error('Error fetching correspondences:', error);
        res.status(500).json({ error: 'Failed to fetch correspondences' });
    }
});

// Get correspondence by ID with trail
router.get('/:id', authenticateToken, (req, res) => {
    try {
        const correspondence = db.prepare(`
      SELECT c.*, p.project_name, cu.customer_name, u.name as created_by_name
      FROM correspondences c
      LEFT JOIN projects p ON c.project_id = p.id
      JOIN customers cu ON c.customer_id = cu.id
      JOIN users u ON c.created_by = u.id
      WHERE c.id = ?
    `).get(req.params.id);

        if (!correspondence) {
            return res.status(404).json({ error: 'Correspondence not found' });
        }

        // Get trail
        const trail = db.prepare(`
      SELECT ct.*, u.name as action_by_name
      FROM correspondence_trail ct
      JOIN users u ON ct.action_by = u.id
      WHERE ct.correspondence_id = ?
      ORDER BY ct.action_date DESC
    `).all(req.params.id);

        res.json({ ...correspondence, trail });
    } catch (error) {
        console.error('Error fetching correspondence:', error);
        res.status(500).json({ error: 'Failed to fetch correspondence' });
    }
});

// Create correspondence
router.post('/', authenticateToken, async (req, res) => {
    try {
        const {
            customer_id,
            project_id,
            milestone_id,
            subject,
            content,
            correspondence_type,
            direction
        } = req.body;

        if (!customer_id || !subject) {
            return res.status(400).json({ error: 'Customer and subject are required' });
        }

        // Generate correspondence number
        const count = db.prepare('SELECT COUNT(*) as count FROM correspondences').get();
        const correspondenceNumber = `CORR${String(count.count + 1).padStart(6, '0')}`;

        // Generate QR code and digital signature
        const qrInfo = await generateCorrespondenceQR(count.count + 1, correspondenceNumber);
        const signature = generateDigitalSignature(req.user.id, req.user.name, correspondenceNumber);

        const result = db.prepare(`
      INSERT INTO correspondences (
        correspondence_number, customer_id, project_id, milestone_id,
        subject, content, correspondence_type, direction, qr_code,
        digital_signature, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            correspondenceNumber,
            customer_id,
            project_id || null,
            milestone_id || null,
            subject,
            content,
            correspondence_type || 'letter',
            direction || 'outgoing',
            qrInfo.qrCode,
            JSON.stringify(signature),
            req.user.id
        );

        // Add trail entry
        db.prepare(`
      INSERT INTO correspondence_trail (correspondence_id, action, action_by, remarks)
      VALUES (?, ?, ?, ?)
    `).run(result.lastInsertRowid, 'created', req.user.id, 'Correspondence created');

        res.json({
            message: 'Correspondence created successfully',
            correspondenceId: result.lastInsertRowid,
            correspondenceNumber,
            qrDataURL: qrInfo.qrDataURL
        });
    } catch (error) {
        console.error('Error creating correspondence:', error);
        res.status(500).json({ error: 'Failed to create correspondence' });
    }
});

// Send correspondence
router.post('/:id/send', authenticateToken, (req, res) => {
    try {
        const correspondence = db.prepare('SELECT id, status FROM correspondences WHERE id = ?').get(req.params.id);

        if (!correspondence) {
            return res.status(404).json({ error: 'Correspondence not found' });
        }

        db.prepare(`
      UPDATE correspondences SET
        status = 'sent',
        sent_date = datetime('now')
      WHERE id = ?
    `).run(req.params.id);

        // Add trail entry
        db.prepare(`
      INSERT INTO correspondence_trail (correspondence_id, action, action_by, remarks)
      VALUES (?, ?, ?, ?)
    `).run(req.params.id, 'sent', req.user.id, req.body.remarks || 'Correspondence sent');

        res.json({ message: 'Correspondence marked as sent' });
    } catch (error) {
        console.error('Error sending correspondence:', error);
        res.status(500).json({ error: 'Failed to send correspondence' });
    }
});

// Acknowledge correspondence
router.post('/:id/acknowledge', authenticateToken, (req, res) => {
    try {
        db.prepare(`
      UPDATE correspondences SET
        status = 'acknowledged',
        received_date = datetime('now')
      WHERE id = ?
    `).run(req.params.id);

        // Add trail entry
        db.prepare(`
      INSERT INTO correspondence_trail (correspondence_id, action, action_by, remarks)
      VALUES (?, ?, ?, ?)
    `).run(req.params.id, 'acknowledged', req.user.id, req.body.remarks || 'Correspondence acknowledged');

        res.json({ message: 'Correspondence acknowledged' });
    } catch (error) {
        console.error('Error acknowledging correspondence:', error);
        res.status(500).json({ error: 'Failed to acknowledge correspondence' });
    }
});

// Get correspondences by project
router.get('/project/:projectId', authenticateToken, (req, res) => {
    try {
        const correspondences = db.prepare(`
      SELECT c.*, u.name as created_by_name
      FROM correspondences c
      JOIN users u ON c.created_by = u.id
      WHERE c.project_id = ?
      ORDER BY c.created_at DESC
    `).all(req.params.projectId);

        res.json({ correspondences });
    } catch (error) {
        console.error('Error fetching project correspondences:', error);
        res.status(500).json({ error: 'Failed to fetch correspondences' });
    }
});

export default router;
