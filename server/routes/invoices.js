import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import db from '../database.js';
import { authenticateToken } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import { extractInvoiceData } from '../utils/ocrProcessor.js';
import {
    assignedInvoicesSchema,
    invoiceIdSchema,
    uploadInvoiceSchema,
} from '../validation/invoiceSchemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const execFileAsync = promisify(execFile);

const ALLOWED_UPLOAD_TYPES = {
    'application/pdf': ['.pdf'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
};

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:latest';
const MAX_AI_PAGES = 4;

const parseJsonObject = (text) => {
    if (!text || typeof text !== 'string') {
        throw new Error('Empty AI response');
    }

    const fencedMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
    const candidate = fencedMatch?.[1] || text;

    try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {
        // Try object slicing fallback.
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        const sliced = text.slice(start, end + 1);
        const parsed = JSON.parse(sliced);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }

    throw new Error('AI response is not a valid JSON object');
};

const toDateOnly = (value) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toISOString().split('T')[0];
};

const toAmountString = (value) => {
    if (value === undefined || value === null) return '';
    const text = String(value).replaceAll(',', '').trim();
    const numberMatch = /\d+(?:\.\d{1,2})?/.exec(text);
    return numberMatch ? numberMatch[0] : text;
};

const imageFileToBase64 = async (imagePath) => {
    const buffer = await fsp.readFile(imagePath);
    return buffer.toString('base64');
};

const pdfToBase64Pages = async (pdfPath) => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jcc-ai-'));
    const outputPrefix = path.join(tempDir, 'page');

    try {
        await execFileAsync('pdftoppm', [
            '-png',
            '-r',
            '150',
            '-f',
            '1',
            '-l',
            String(MAX_AI_PAGES),
            pdfPath,
            outputPrefix,
        ]);

        const files = await fsp.readdir(tempDir);
        const pageFiles = files
            .filter((name) => name.startsWith('page-') && name.endsWith('.png'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .slice(0, MAX_AI_PAGES)
            .map((name) => path.join(tempDir, name));

        const base64Pages = [];
        for (const pageFile of pageFiles) {
            base64Pages.push(await imageFileToBase64(pageFile));
        }

        return base64Pages;
    } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
    }
};

const prepareAiImages = async (filePath, fileType) => {
    if (fileType === 'application/pdf') {
        return await pdfToBase64Pages(filePath);
    }

    if (fileType.startsWith('image/')) {
        return [await imageFileToBase64(filePath)];
    }

    return [];
};

const analyzeInvoiceWithOllama = async (extraction, images = []) => {
    const lineItems = Array.isArray(extraction.lineItems) ? extraction.lineItems : [];

    const prompt = [
        'You are an expert invoice extraction assistant.',
        'Analyze the invoice image(s) and OCR context to extract fields.',
        'Return ONLY valid JSON object with keys: vendorName, invoiceNumber, amount, date, poNumber.',
        'Rules:',
        '- amount: numeric string only, no commas and no currency symbols',
        '- date: yyyy-mm-dd when possible',
        '- unknown values: empty string',
        '',
        'OCR text context:',
        extraction.text || '',
        '',
        'OCR line items context:',
        JSON.stringify(lineItems),
    ].join('\n');

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: OLLAMA_MODEL,
            stream: false,
            format: 'json',
            options: {
                temperature: 0,
            },
            messages: [
                {
                    role: 'user',
                    content: prompt,
                    images,
                },
            ],
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Ollama request failed (${response.status}): ${errorBody}`);
    }

    const payload = await response.json();
    const content = payload?.message?.content || '';
    const parsed = parseJsonObject(content);

    return {
        vendorName: String(parsed.vendorName || ''),
        invoiceNumber: String(parsed.invoiceNumber || ''),
        amount: toAmountString(parsed.amount),
        date: toDateOnly(parsed.date || ''),
        poNumber: String(parsed.poNumber || ''),
    };
};

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const extname = path.extname(file.originalname).toLowerCase();
        const allowedExts = ALLOWED_UPLOAD_TYPES[file.mimetype];

        if (Array.isArray(allowedExts) && allowedExts.includes(extname)) {
            return cb(null, true);
        }

        cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed with valid MIME type'));
    },
});

// Upload invoice
router.post('/upload', authenticateToken, uploadLimiter, upload.single('invoice'), validateRequest(uploadInvoiceSchema), async (req, res) => {
    try {
        const { vendorName, amount, invoiceNumber, invoiceDate, assignedTo, poNumber } = req.body;
        const filePath = req.file ? req.file.filename : null;

        // Validate that assignedTo is provided
        if (!assignedTo) {
            return res.status(400).json({ error: 'Please select a user to assign this invoice to' });
        }

        // Find the assigned user to send notification
        const assignedUser = db.prepare('SELECT id, name, email FROM users WHERE ps_number = ? OR name = ?').get(assignedTo, assignedTo);

        // Insert invoice with status 'assigned' and full assignment audit fields
        const result = db.prepare(`
            INSERT INTO invoices (
                user_id, vendor_name, invoice_number, amount, invoice_date, file_path,
                assigned_to, assigned_to_user_id, assigned_to_name,
                assigned_by_user_id, assigned_by_name, assigned_at,
                po_number, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'assigned')
        `).run(
            req.user.id,
            vendorName,
            invoiceNumber,
            amount,
            invoiceDate,
            filePath,
            assignedTo,
            assignedUser ? assignedUser.id : null,
            assignedUser ? assignedUser.name : assignedTo,
            req.user.id,
            req.user.name,
            poNumber || null
        );

        db.prepare(`
            INSERT INTO invoice_assignment_history (
                invoice_id, action_type, action_by_user_id, action_by_name,
                assigned_to_user_id, assigned_to_name, notes
            ) VALUES (?, 'assigned', ?, ?, ?, ?, ?)
        `).run(
            result.lastInsertRowid,
            req.user.id,
            req.user.name,
            assignedUser ? assignedUser.id : null,
            assignedUser ? assignedUser.name : assignedTo,
            `Invoice assigned by ${req.user.name}`
        );

        if (assignedUser) {
            // Create notification for the assigned user
            db.prepare(`
                INSERT INTO notifications (user_id, title, message, type)
                VALUES (?, ?, ?, ?)
            `).run(
                assignedUser.id,
                '📧 New Invoice Assigned',
                `Invoice ${invoiceNumber} from ${vendorName} (₹${amount}) has been assigned to you`,
                'info'
            );
        }

        // Create audit log for invoice assignment
        db.prepare(`
            INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, details)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            req.user.id,
            req.user.name,
            'ASSIGN_INVOICE',
            'invoice',
            result.lastInsertRowid,
            `Invoice ${invoiceNumber} from ${vendorName} (₹${amount}) assigned to ${assignedUser ? assignedUser.name : assignedTo} by ${req.user.name} on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
        );

        res.json({
            message: 'Invoice assigned successfully! User will be notified.',
            invoiceId: result.lastInsertRowid,
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
});

// Extract core invoice fields from PDF/image (Invoice No, Amount, Date, PO No)
router.post('/extract', authenticateToken, uploadLimiter, upload.single('invoice'), async (req, res) => {
    let uploadedPath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Invoice file is required' });
        }

        uploadedPath = req.file.path;
        const fileType = req.file.mimetype || '';
        const extraction = await extractInvoiceData(uploadedPath, fileType);

        return res.json({
            invoiceNumber: extraction.invoiceNumber || '',
            amount: extraction.amount || '',
            date: extraction.date || '',
            poNumber: extraction.poNumber || '',
            rawText: extraction.text || ''
        });
    } catch (error) {
        console.error('Invoice extraction API error:', error);
        return res.status(500).json({ error: 'Failed to extract invoice data' });
    } finally {
        // Remove temporary file after extraction API call.
        if (uploadedPath && fs.existsSync(uploadedPath)) {
            try {
                fs.unlinkSync(uploadedPath);
            } catch (cleanupError) {
                console.warn('Failed to clean up extracted temp file:', cleanupError.message);
            }
        }
    }
});

// TaxHacker-style AI analysis endpoint using uploaded invoice and local Ollama.
router.post('/extract-ai', authenticateToken, uploadLimiter, upload.single('invoice'), async (req, res) => {
    let uploadedPath = null;

    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Invoice file is required' });
        }

        uploadedPath = req.file.path;
        const fileType = req.file.mimetype || '';
        const extraction = await extractInvoiceData(uploadedPath, fileType);

        let aiData = null;
        let aiError = null;

        try {
            const images = await prepareAiImages(uploadedPath, fileType);
            aiData = await analyzeInvoiceWithOllama(extraction, images);
        } catch (error) {
            aiError = error instanceof Error ? error.message : String(error);
            console.error('Invoice AI extraction error:', aiError);
        }

        const fallbackData = {
            vendorName: extraction.entities?.organizations?.[0] || '',
            invoiceNumber: extraction.invoiceNumber || '',
            amount: extraction.amount || '',
            date: extraction.date || '',
            poNumber: extraction.poNumber || '',
            rawText: extraction.text || '',
            lineItems: extraction.lineItems || [],
            entities: extraction.entities || {},
        };

        const data = aiData
            ? {
                ...fallbackData,
                ...aiData,
                usedAI: true,
                aiError,
            }
            : {
                ...fallbackData,
                usedAI: false,
                aiError,
            };

        return res.json(data);
    } catch (error) {
        console.error('Invoice AI extract API error:', error);
        return res.status(500).json({ error: 'Failed to analyze invoice with AI' });
    } finally {
        if (uploadedPath && fs.existsSync(uploadedPath)) {
            try {
                fs.unlinkSync(uploadedPath);
            } catch (cleanupError) {
                console.warn('Failed to clean up extracted temp file:', cleanupError.message);
            }
        }
    }
});

// Get assigned invoices for current user
router.get('/assigned', authenticateToken, validateRequest(assignedInvoicesSchema), (req, res) => {
    try {
                const scope = req.query.scope || 'assigned';
                let invoices;

                if (scope === 'dashboard') {
                        // Dashboard: assignee can see own assigned items; assigner can track items they assigned.
                        invoices = db.prepare(`
                SELECT i.*, u.name as uploader_name
                FROM invoices i
                JOIN users u ON i.user_id = u.id
                WHERE i.status IN ('assigned', 'pending', 'voucher_created')
                AND (
                    i.user_id = ?
                    OR i.assigned_to_user_id = ?
                    OR i.assigned_to = ?
                    OR i.assigned_to = ?
                )
                ORDER BY COALESCE(i.assigned_at, i.created_at) DESC
            `).all(req.user.id, req.user.id, req.user.ps_number || '', req.user.name || '');
                } else {
                        // Assigned Invoices page: only assignee should see the record.
                        invoices = db.prepare(`
                SELECT i.*, u.name as uploader_name
                FROM invoices i
                JOIN users u ON i.user_id = u.id
                WHERE i.status IN ('assigned', 'pending', 'voucher_created')
                AND (
                    i.assigned_to_user_id = ?
                    OR i.assigned_to = ?
                    OR i.assigned_to = ?
                )
                ORDER BY COALESCE(i.assigned_at, i.created_at) DESC
            `).all(req.user.id, req.user.ps_number || '', req.user.name || '');
                }

        res.json(invoices);
    } catch (error) {
        console.error('Error fetching assigned invoices:', error);
        res.status(500).json({ error: 'Failed to fetch assigned invoices' });
    }
});

// Accept an assigned invoice (marks when user has accepted the assignment)
router.post('/:id/accept', authenticateToken, validateRequest(invoiceIdSchema), (req, res) => {
    try {
        const invoiceId = req.params.id;

        const invoice = db.prepare(`
            SELECT * FROM invoices
            WHERE id = ?
              AND status IN ('assigned', 'pending')
              AND (assigned_to_user_id = ? OR assigned_to = ? OR assigned_to = ?)
        `).get(invoiceId, req.user.id, req.user.ps_number || '', req.user.name || '');

        if (!invoice) {
            return res.status(404).json({ error: 'Assigned invoice not found' });
        }

        if (invoice.accepted_at) {
            return res.json({ message: 'Invoice already accepted', acceptedAt: invoice.accepted_at });
        }

        db.prepare(`
            UPDATE invoices
            SET accepted_by_user_id = ?,
                accepted_by_name = ?,
                accepted_at = datetime('now')
            WHERE id = ?
        `).run(req.user.id, req.user.name, invoiceId);

        db.prepare(`
            INSERT INTO invoice_assignment_history (
                invoice_id, action_type, action_by_user_id, action_by_name,
                assigned_to_user_id, assigned_to_name, notes
            ) VALUES (?, 'accepted', ?, ?, ?, ?, ?)
        `).run(
            invoiceId,
            req.user.id,
            req.user.name,
            req.user.id,
            req.user.name,
            `Invoice accepted by ${req.user.name}`
        );

        res.json({ message: 'Invoice accepted successfully' });
    } catch (error) {
        console.error('Error accepting assigned invoice:', error);
        res.status(500).json({ error: 'Failed to accept assigned invoice' });
    }
});

// Get full lifecycle history for an invoice
router.get('/:id/history', authenticateToken, validateRequest(invoiceIdSchema), (req, res) => {
    try {
        const invoiceId = req.params.id;
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);

        if (!invoice) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const isAssignedUser = invoice.assigned_to_user_id === req.user.id || invoice.assigned_to === req.user.ps_number || invoice.assigned_to === req.user.name;
        const isUploader = invoice.user_id === req.user.id;
        const isPrivileged = ['admin', 'coordinator', 'manager', 'final_approver'].includes(req.user.role);

        if (!isAssignedUser && !isUploader && !isPrivileged) {
            return res.status(403).json({ error: 'Not authorized to view this history' });
        }

        const history = db.prepare(`
            SELECT id, invoice_id, action_type, action_by_name, assigned_to_name, voucher_id, notes, action_at
            FROM invoice_assignment_history
            WHERE invoice_id = ?
            ORDER BY action_at ASC, id ASC
        `).all(invoiceId);

        res.json({
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoice_number,
            lifecycle: {
                assignedBy: invoice.assigned_by_name,
                assignedTo: invoice.assigned_to_name || invoice.assigned_to,
                assignedAt: invoice.assigned_at,
                acceptedBy: invoice.accepted_by_name,
                acceptedAt: invoice.accepted_at,
                voucherSubmittedAt: invoice.voucher_submitted_at,
                completedAt: invoice.completed_at
            },
            history
        });
    } catch (error) {
        console.error('Error fetching invoice history:', error);
        res.status(500).json({ error: 'Failed to fetch invoice history' });
    }
});

// Get pending invoices
router.get('/pending', authenticateToken, (req, res) => {
    try {
        const invoices = db.prepare(`
      SELECT i.*, u.name as uploader_name
      FROM invoices i
      JOIN users u ON i.user_id = u.id
      WHERE i.status = 'pending'
      ORDER BY i.created_at DESC
    `).all();

        res.json(invoices);
    } catch (error) {
        console.error('Error fetching invoices:', error);
        res.status(500).json({ error: 'Failed to fetch invoices' });
    }
});

// Get invoice file
router.get('/file/:id', authenticateToken, validateRequest(invoiceIdSchema), (req, res) => {
    try {
        const invoice = db.prepare('SELECT file_path FROM invoices WHERE id = ?').get(req.params.id);

        if (!invoice?.file_path) {
            return res.status(404).json({ error: 'File not found' });
        }

        const filePath = path.join(__dirname, '../../uploads', invoice.file_path);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found on disk' });
        }

        res.sendFile(filePath);
    } catch (error) {
        console.error('Error fetching file:', error);
        res.status(500).json({ error: 'Failed to fetch file' });
    }
});

// Reject invoice
router.post('/:id/reject', authenticateToken, validateRequest(invoiceIdSchema), (req, res) => {
    try {
        db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run('rejected', req.params.id);
        res.json({ message: 'Invoice rejected' });
    } catch (error) {
        console.error('Error rejecting invoice:', error);
        res.status(500).json({ error: 'Failed to reject invoice' });
    }
});

export default router;
