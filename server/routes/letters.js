import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { processLetter } from '../utils/ocrProcessor.js';
import { generateCorrespondenceQR, generateDigitalSignature } from '../utils/qrGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configure multer for letter uploads  
const uploadDir = path.join(path.dirname(__dirname), '..', 'uploads', 'letters');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Preserve the original file extension
        const ext = path.extname(file.originalname);
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`;
        cb(null, filename);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPG, PNG, and PDF are allowed.'));
        }
    }
});

// ==================== INCOMING LETTERS ====================

// Upload incoming letter
router.post('/incoming/upload', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Generate unique reference number
        const referenceNumber = `IN-${Date.now()}`;

        // Insert incoming letter record
        const result = db.prepare(`
            INSERT INTO incoming_letters (
                reference_number, original_file_path, status, created_at
            ) VALUES (?, ?, 'pending', datetime('now'))
        `).run(referenceNumber, `/uploads/letters/${req.file.filename}`);

        res.json({
            message: 'Letter uploaded successfully',
            letterId: result.lastInsertRowid,
            referenceNumber
        });
    } catch (error) {
        console.error('Upload error:', error);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Failed to upload letter' });
    }
});

// Process OCR on uploaded letter
router.post('/incoming/:id/ocr', authenticateToken, async (req, res) => {
    try {
        const letter = db.prepare('SELECT * FROM incoming_letters WHERE id = ?').get(req.params.id);

        if (!letter) {
            return res.status(404).json({ error: 'Letter not found' });
        }

        // Update status to processing
        db.prepare('UPDATE incoming_letters SET status = ? WHERE id = ?').run('processing', req.params.id);

        // Get file path
        const filePath = path.join(path.dirname(__dirname), '..', letter.original_file_path);

        // Detect file type
        const fileExt = path.extname(filePath).toLowerCase();
        const fileType = fileExt === '.pdf' ? 'application/pdf' : 'image';

        // Process OCR
        const ocrResult = await processLetter(filePath, fileType);

        // Update letter with OCR results
        db.prepare(`
            UPDATE incoming_letters 
            SET ocr_text = ?, 
                ocr_confidence = ?,
                status = 'read',
                processed_at = datetime('now')
            WHERE id = ?
        `).run(ocrResult.text, ocrResult.confidence, req.params.id);

        res.json({
            message: 'OCR processing complete',
            text: ocrResult.text,
            confidence: ocrResult.confidence,
            entities: ocrResult.entities
        });
    } catch (error) {
        console.error('OCR processing error:', error);
        db.prepare('UPDATE incoming_letters SET status = ? WHERE id = ?').run('pending', req.params.id);
        res.status(500).json({ error: 'Failed to process OCR' });
    }
});

// Get all incoming letters
router.get('/incoming', authenticateToken, (req, res) => {
    try {
        const { status, search } = req.query;
        let query = `
            SELECT il.*, 
                   u.name as assigned_user_name,
                   p.project_name,
                   c.customer_name
            FROM incoming_letters il
            LEFT JOIN users u ON il.assigned_to = u.id
            LEFT JOIN projects p ON il.project_id = p.id
            LEFT JOIN customers c ON il.customer_id = c.id
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            query += ' AND il.status = ?';
            params.push(status);
        }

        if (search) {
            query += ' AND (il.reference_number LIKE ? OR il.subject LIKE ? OR il.sender_name LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY il.created_at DESC';

        const letters = db.prepare(query).all(...params);
        res.json(letters);
    } catch (error) {
        console.error('Error fetching incoming letters:', error);
        res.status(500).json({ error: 'Failed to fetch letters' });
    }
});

// Get single incoming letter
router.get('/incoming/:id', authenticateToken, (req, res) => {
    try {
        const letter = db.prepare(`
            SELECT il.*, 
                   u.name as assigned_user_name,
                   p.project_name,
                   c.customer_name
            FROM incoming_letters il
            LEFT JOIN users u ON il.assigned_to = u.id
            LEFT JOIN projects p ON il.project_id = p.id
            LEFT JOIN customers c ON il.customer_id = c.id
            WHERE il.id = ?
        `).get(req.params.id);

        if (!letter) {
            return res.status(404).json({ error: 'Letter not found' });
        }

        res.json(letter);
    } catch (error) {
        console.error('Error fetching letter:', error);
        res.status(500).json({ error: 'Failed to fetch letter' });
    }
});

// Update incoming letter details
router.put('/incoming/:id', authenticateToken, (req, res) => {
    try {
        const { subject, sender_name, sender_address, received_date, assigned_to, project_id, customer_id, ocr_text } = req.body;

        db.prepare(`
            UPDATE incoming_letters 
            SET subject = ?,
                sender_name = ?,
                sender_address = ?,
                received_date = ?,
                assigned_to = ?,
                project_id = ?,
                customer_id = ?,
                ocr_text = ?
            WHERE id = ?
        `).run(subject, sender_name, sender_address, received_date, assigned_to, project_id, customer_id, ocr_text, req.params.id);

        res.json({ message: 'Letter updated successfully' });
    } catch (error) {
        console.error('Error updating letter:', error);
        res.status(500).json({ error: 'Failed to update letter' });
    }
});

// Create response to incoming letter
router.post('/incoming/:id/respond', authenticateToken, async (req, res) => {
    try {
        const { template_id, subject, recipient_name, recipient_address, content } = req.body;
        const incomingLetter = db.prepare('SELECT * FROM incoming_letters WHERE id = ?').get(req.params.id);

        if (!incomingLetter) {
            return res.status(404).json({ error: 'Incoming letter not found' });
        }

        // Generate letter number
        const letterNumber = `OUT-${Date.now()}`;

        // Generate QR code
        const qrData = await generateCorrespondenceQR(letterNumber, letterNumber);

        // Create generated letter
        const result = db.prepare(`
            INSERT INTO generated_letters (
                template_id, letter_number, subject, recipient_name, recipient_address,
                in_response_to, generated_content, qr_code, verification_token,
                status, generated_by, generated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, datetime('now'))
        `).run(
            template_id || null,
            letterNumber,
            subject,
            recipient_name,
            recipient_address,
            req.params.id,
            content,
            qrData.qrCode,
            qrData.verificationToken,
            req.user.id
        );

        // Update incoming letter with response link
        db.prepare('UPDATE incoming_letters SET response_letter_id = ?, status = ? WHERE id = ?')
            .run(result.lastInsertRowid, 'responded', req.params.id);

        res.json({
            message: 'Response created successfully',
            letterId: result.lastInsertRowid,
            letterNumber,
            qrDataURL: qrData.qrDataURL
        });
    } catch (error) {
        console.error('Error creating response:', error);
        res.status(500).json({ error: 'Failed to create response' });
    }
});

// Release incoming letter
router.post('/incoming/:id/release', authenticateToken, authorizeRoles('admin', 'coordinator', 'manager'), (req, res) => {
    try {
        db.prepare('UPDATE incoming_letters SET status = ? WHERE id = ?').run('released', req.params.id);
        res.json({ message: 'Letter released successfully' });
    } catch (error) {
        console.error('Error releasing letter:', error);
        res.status(500).json({ error: 'Failed to release letter' });
    }
});

// ==================== LETTER TEMPLATES ====================

// Get all templates
router.get('/templates', authenticateToken, (req, res) => {
    try {
        const templates = db.prepare(`
            SELECT t.*, u.name as created_by_name
            FROM letter_templates t
            LEFT JOIN users u ON t.created_by = u.id
            ORDER BY t.created_at DESC
        `).all();

        res.json(templates);
    } catch (error) {
        console.error('Error fetching templates:', error);
        res.status(500).json({ error: 'Failed to fetch templates' });
    }
});

// Create new template
router.post('/templates', authenticateToken, authorizeRoles('admin', 'coordinator'), (req, res) => {
    try {
        const { name, description, template_type, html_content, variables, header_content, footer_content } = req.body;

        if (!name || !html_content) {
            return res.status(400).json({ error: 'Name and content are required' });
        }

        const result = db.prepare(`
            INSERT INTO letter_templates (
                name, description, template_type, html_content, variables,
                header_content, footer_content, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            name,
            description || '',
            template_type || 'general',
            html_content,
            variables ? JSON.stringify(variables) : null,
            header_content || '',
            footer_content || '',
            req.user.id
        );

        res.json({
            message: 'Template created successfully',
            id: result.lastInsertRowid
        });
    } catch (error) {
        console.error('Error creating template:', error);
        res.status(500).json({ error: 'Failed to create template' });
    }
});

// Update template
router.put('/templates/:id', authenticateToken, authorizeRoles('admin', 'coordinator'), (req, res) => {
    try {
        const { name, description, template_type, html_content, variables, header_content, footer_content } = req.body;

        db.prepare(`
            UPDATE letter_templates 
            SET name = ?, description = ?, template_type = ?, html_content = ?,
                variables = ?, header_content = ?, footer_content = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(
            name,
            description,
            template_type,
            html_content,
            variables ? JSON.stringify(variables) : null,
            header_content,
            footer_content,
            req.params.id
        );

        res.json({ message: 'Template updated successfully' });
    } catch (error) {
        console.error('Error updating template:', error);
        res.status(500).json({ error: 'Failed to update template' });
    }
});

// Delete template
router.delete('/templates/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        db.prepare('DELETE FROM letter_templates WHERE id = ?').run(req.params.id);
        res.json({ message: 'Template deleted successfully' });
    } catch (error) {
        console.error('Error deleting template:', error);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// ==================== GENERATED LETTERS ====================

// Get all generated letters
router.get('/', authenticateToken, (req, res) => {
    try {
        const letters = db.prepare(`
            SELECT gl.*,
                   u.name as generated_by_name,
                   t.name as template_name,
                   p.project_name,
                   c.customer_name
            FROM generated_letters gl
            LEFT JOIN users u ON gl.generated_by = u.id
            LEFT JOIN letter_templates t ON gl.template_id = t.id
            LEFT JOIN projects p ON gl.project_id = p.id
            LEFT JOIN customers c ON gl.customer_id = c.id
            ORDER BY gl.generated_at DESC
        `).all();

        res.json(letters);
    } catch (error) {
        console.error('Error fetching generated letters:', error);
        res.status(500).json({ error: 'Failed to fetch letters' });
    }
});

// Get single generated letter
router.get('/:id', authenticateToken, (req, res) => {
    try {
        const letter = db.prepare(`
            SELECT gl.*,
                   u.name as generated_by_name,
                   t.name as template_name,
                   p.project_name,
                   c.customer_name
            FROM generated_letters gl
            LEFT JOIN users u ON gl.generated_by = u.id
            LEFT JOIN letter_templates t ON gl.template_id = t.id
            LEFT JOIN projects p ON gl.project_id = p.id
            LEFT JOIN customers c ON gl.customer_id = c.id
            WHERE gl.id = ?
        `).get(req.params.id);

        if (!letter) {
            return res.status(404).json({ error: 'Letter not found' });
        }

        res.json(letter);
    } catch (error) {
        console.error('Error fetching letter:', error);
        res.status(500).json({ error: 'Failed to fetch letter' });
    }
});

// Update generated letter
router.put('/:id', authenticateToken, (req, res) => {
    try {
        const { subject, recipient_name, recipient_address, generated_content, status } = req.body;

        db.prepare(`
            UPDATE generated_letters 
            SET subject = ?, recipient_name = ?, recipient_address = ?, 
                generated_content = ?, status = ?
            WHERE id = ?
        `).run(subject, recipient_name, recipient_address, generated_content, status, req.params.id);

        res.json({ message: 'Letter updated successfully' });
    } catch (error) {
        console.error('Error updating letter:', error);
        res.status(500).json({ error: 'Failed to update letter' });
    }
});

// Add signature to letter
router.post('/:id/sign', authenticateToken, (req, res) => {
    try {
        const letter = db.prepare('SELECT * FROM generated_letters WHERE id = ?').get(req.params.id);

        if (!letter) {
            return res.status(404).json({ error: 'Letter not found' });
        }

        // Generate digital signature
        const signature = generateDigitalSignature(req.user.id, req.user.name, req.params.id);

        // Store signature
        db.prepare(`
            INSERT INTO letter_signatures (
                letter_id, user_id, signature_hash, signature_id, signed_at
            ) VALUES (?, ?, ?, ?, datetime('now'))
        `).run(req.params.id, req.user.id, signature.signature, signature.signatureId);

        // Update letter status
        db.prepare('UPDATE generated_letters SET status = ? WHERE id = ?').run('signed', req.params.id);

        res.json({
            message: 'Letter signed successfully',
            signature
        });
    } catch (error) {
        console.error('Error signing letter:', error);
        res.status(500).json({ error: 'Failed to sign letter' });
    }
});

// Release letter
router.post('/:id/release', authenticateToken, authorizeRoles('admin', 'coordinator', 'manager'), (req, res) => {
    try {
        db.prepare(`
            UPDATE generated_letters 
            SET status = 'released', released_at = datetime('now')
            WHERE id = ?
        `).run(req.params.id);

        res.json({ message: 'Letter released successfully' });
    } catch (error) {
        console.error('Error releasing letter:', error);
        res.status(500).json({ error: 'Failed to release letter' });
    }
});

export default router;
