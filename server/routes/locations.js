import express from 'express';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

const cleanStr = (v) => {
    const s = String(v ?? '').trim();
    return s === '' ? null : s;
};

// List locations. All authenticated users (needed for the dropdowns). By default
// only active ones; admins can pass ?all=1 to include inactive.
router.get('/', authenticateToken, (req, res) => {
    try {
        const includeInactive = req.query.all === '1' && req.user.role === 'admin';
        const rows = includeInactive
            ? db.prepare('SELECT * FROM locations ORDER BY name').all()
            : db.prepare('SELECT * FROM locations WHERE active = 1 ORDER BY name').all();
        res.json(rows);
    } catch (error) {
        console.error('Error fetching locations:', error);
        res.status(500).json({ error: 'Failed to fetch locations' });
    }
});

// Create a location (admin).
router.post('/', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const name = cleanStr(req.body?.name);
        if (!name) return res.status(400).json({ error: 'Location name is required' });
        const code = cleanStr(req.body?.code);
        const result = db.prepare('INSERT INTO locations (name, code) VALUES (?, ?)').run(name, code);
        res.json({ id: result.lastInsertRowid, message: `Location "${name}" added` });
    } catch (error) {
        console.error('Error creating location:', error);
        res.status(500).json({ error: 'Failed to create location' });
    }
});

// Update a location (admin) — name, code, active.
router.put('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
        if (!loc) return res.status(404).json({ error: 'Location not found' });
        const name = cleanStr(req.body?.name) || loc.name;
        const code = req.body?.code !== undefined ? cleanStr(req.body.code) : loc.code;
        const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : loc.active;
        db.prepare('UPDATE locations SET name = ?, code = ?, active = ? WHERE id = ?').run(name, code, active, loc.id);
        res.json({ message: 'Location updated' });
    } catch (error) {
        console.error('Error updating location:', error);
        res.status(500).json({ error: 'Failed to update location' });
    }
});

// Deactivate a location (admin). Soft-delete so historical jobs keep their site.
router.delete('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const loc = db.prepare('SELECT id FROM locations WHERE id = ?').get(req.params.id);
        if (!loc) return res.status(404).json({ error: 'Location not found' });
        db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(req.params.id);
        res.json({ message: 'Location deactivated' });
    } catch (error) {
        console.error('Error deactivating location:', error);
        res.status(500).json({ error: 'Failed to deactivate location' });
    }
});

export default router;
