import express from 'express';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// Get all projects
router.get('/', authenticateToken, (req, res) => {
    try {
        const { search, customer_id, status, debit_code, limit = 100, offset = 0 } = req.query;

        let query = `
      SELECT p.*, c.customer_name, c.customer_code,
             u.name as created_by_name
      FROM projects p
      JOIN customers c ON p.customer_id = c.id
      JOIN users u ON p.created_by = u.id
      WHERE 1=1
    `;
        let params = [];

        if (search) {
            query += ' AND (p.project_name LIKE ? OR p.project_code LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }

        if (customer_id) {
            query += ' AND p.customer_id = ?';
            params.push(customer_id);
        }

        if (status) {
            query += ' AND p.status = ?';
            params.push(status);
        }

        if (debit_code) {
            query += ' AND p.debit_code = ?';
            params.push(debit_code);
        }

        query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const projects = db.prepare(query).all(...params);
        const total = db.prepare('SELECT COUNT(*) as count FROM projects').get();

        res.json({
            projects,
            total: total.count,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error('Error fetching projects:', error);
        res.status(500).json({ error: 'Failed to fetch projects' });
    }
});

// Distinct debit codes (for the printing-request Phase 1 dropdown).
// Declared BEFORE '/:id' so it isn't captured as an id.
router.get('/meta/debit-codes', authenticateToken, (req, res) => {
    try {
        const rows = db
            .prepare(
                `SELECT DISTINCT debit_code FROM projects
                 WHERE debit_code IS NOT NULL AND TRIM(debit_code) != ''
                 ORDER BY debit_code`
            )
            .all();
        res.json(rows.map((r) => r.debit_code));
    } catch (error) {
        console.error('Error fetching debit codes:', error);
        res.status(500).json({ error: 'Failed to fetch debit codes' });
    }
});

// Get project by ID with full details
router.get('/:id', authenticateToken, (req, res) => {
    try {
        const project = db.prepare(`
      SELECT p.*, c.customer_name, c.customer_code, c.contact_person,
             c.email, c.phone, u.name as created_by_name
      FROM projects p
      JOIN customers c ON p.customer_id = c.id
      JOIN users u ON p.created_by = u.id
      WHERE p.id = ?
    `).get(req.params.id);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Get project milestones
        const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY target_date').all(req.params.id);

        // Get project correspondences
        const correspondences = db.prepare('SELECT * FROM correspondences WHERE project_id = ? ORDER BY created_at DESC LIMIT 10').all(req.params.id);

        res.json({
            ...project,
            milestones,
            correspondences
        });
    } catch (error) {
        console.error('Error fetching project:', error);
        res.status(500).json({ error: 'Failed to fetch project' });
    }
});

// Get projects by customer
router.get('/customer/:customerId', authenticateToken, (req, res) => {
    try {
        const projects = db.prepare(`
      SELECT p.*, u.name as created_by_name
      FROM projects p
      JOIN users u ON p.created_by = u.id
      WHERE p.customer_id = ?
      ORDER BY p.created_at DESC
    `).all(req.params.customerId);

        res.json({ projects });
    } catch (error) {
        console.error('Error fetching customer projects:', error);
        res.status(500).json({ error: 'Failed to fetch customer projects' });
    }
});

// Create project
router.post('/', authenticateToken, authorizeRoles('admin', 'coordinator', 'manager'), (req, res) => {
    try {
        const {
            project_code,
            project_name,
            customer_id,
            contract_number,
            contract_date,
            contract_value,
            start_date,
            end_date,
            status,
            debit_code
        } = req.body;

        if (!project_code || !project_name || !customer_id) {
            return res.status(400).json({ error: 'Project code, name, and customer are required' });
        }

        // Check if project code already exists
        const existing = db.prepare('SELECT id FROM projects WHERE project_code = ?').get(project_code);
        if (existing) {
            return res.status(400).json({ error: 'Project code already exists' });
        }

        // Verify customer exists
        const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customer_id);
        if (!customer) {
            return res.status(400).json({ error: 'Customer not found' });
        }

        const result = db.prepare(`
      INSERT INTO projects (
        project_code, project_name, customer_id, contract_number,
        contract_date, contract_value, start_date, end_date, status, debit_code, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            project_code,
            project_name,
            customer_id,
            contract_number || null,
            contract_date || null,
            contract_value || null,
            start_date || null,
            end_date || null,
            status || 'active',
            debit_code || null,
            req.user.id
        );

        res.json({
            message: 'Project created successfully',
            projectId: result.lastInsertRowid
        });
    } catch (error) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: 'Failed to create project' });
    }
});

// Update project
router.put('/:id', authenticateToken, authorizeRoles('admin', 'coordinator', 'manager'), (req, res) => {
    try {
        const {
            project_code,
            project_name,
            customer_id,
            contract_number,
            contract_date,
            contract_value,
            start_date,
            end_date,
            status,
            debit_code
        } = req.body;

        const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        db.prepare(`
      UPDATE projects SET
        project_code = ?,
        project_name = ?,
        customer_id = ?,
        contract_number = ?,
        contract_date = ?,
        contract_value = ?,
        start_date = ?,
        end_date = ?,
        status = ?,
        debit_code = COALESCE(?, debit_code)
      WHERE id = ?
    `).run(
            project_code,
            project_name,
            customer_id,
            contract_number,
            contract_date,
            contract_value,
            start_date,
            end_date,
            status,
            debit_code ?? null,
            req.params.id
        );

        res.json({ message: 'Project updated successfully' });
    } catch (error) {
        console.error('Error updating project:', error);
        res.status(500).json({ error: 'Failed to update project' });
    }
});

// Delete project
router.delete('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        // Check if project has milestones or correspondences
        const milestones = db.prepare('SELECT COUNT(*) as count FROM milestones WHERE project_id = ?').get(req.params.id);
        const correspondences = db.prepare('SELECT COUNT(*) as count FROM correspondences WHERE project_id = ?').get(req.params.id);

        if (milestones.count > 0 || correspondences.count > 0) {
            return res.status(400).json({ error: 'Cannot delete project with existing milestones or correspondences' });
        }

        db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);

        res.json({ message: 'Project deleted successfully' });
    } catch (error) {
        console.error('Error deleting project:', error);
        res.status(500).json({ error: 'Failed to delete project' });
    }
});

// Get project statistics
router.get('/:id/stats', authenticateToken, (req, res) => {
    try {
        const milestoneStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'in-progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM milestones
      WHERE project_id = ?
    `).get(req.params.id);

        const correspondenceStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as outgoing,
        SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming
      FROM correspondences
      WHERE project_id = ?
    `).get(req.params.id);

        res.json({
            milestones: milestoneStats,
            correspondences: correspondenceStats
        });
    } catch (error) {
        console.error('Error fetching project stats:', error);
        res.status(500).json({ error: 'Failed to fetch project statistics' });
    }
});

export default router;
