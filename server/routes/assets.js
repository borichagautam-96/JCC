import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { extractInvoiceData } from '../utils/ocrProcessor.js';
import { getBoolSetting } from '../utils/appSettings.js';

const router = express.Router();
const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRACKING_ROLES = ['admin', 'manager', 'coordinator', 'final_approver', 'initiator', 'user'];
const RETURN_APPROVER_ROLES = ['admin', 'manager', 'coordinator', 'final_approver'];
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:latest';
const MAX_AI_PAGES = 2;

const toIsoDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

const toNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const safeJson = (value) => {
  try {
    return JSON.stringify(value || {});
  } catch {
    return '{}';
  }
};

const monthBounds = (monthText) => {
  const isValid = /^\d{4}-\d{2}$/.test(monthText || '');
  if (!isValid) return null;
  const [year, month] = monthText.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    daysInMonth: end.getUTCDate(),
  };
};

const generateAssetUid = () => {
  const year = new Date().getFullYear();
  const row = db.prepare('SELECT COUNT(*) AS count FROM assets').get();
  const next = (row?.count || 0) + 1;
  return `AST-${year}-${String(next).padStart(6, '0')}`;
};

const parseJsonObject = (text) => {
  if (!text || typeof text !== 'string') {
    throw new Error('Empty AI response');
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidate = fencedMatch?.[1] || text;

  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // fallback
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }

  throw new Error('AI response is not valid JSON');
};

const toDateOnly = (value) => {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().slice(0, 10);
};

const toIsoDateLoose = (value) => {
  if (value === undefined || value === null || value === '') return '';

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsedCode = xlsx.SSF?.parse_date_code?.(value);
    if (parsedCode?.y && parsedCode?.m && parsedCode?.d) {
      return `${String(parsedCode.y).padStart(4, '0')}-${String(parsedCode.m).padStart(2, '0')}-${String(parsedCode.d).padStart(2, '0')}`;
    }
  }

  const text = String(value).trim();
  if (!text) return '';
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return '';
};

const findValueByHeaderHint = (row, hints = []) => {
  if (!row || typeof row !== 'object') return '';
  const entries = Object.entries(row);
  for (const [header, rawValue] of entries) {
    const normalizedHeader = String(header || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalizedHeader) continue;
    const matched = hints.some((hint) => normalizedHeader.includes(hint));
    if (!matched) continue;
    const value = String(rawValue ?? '').trim();
    if (value) return value;
  }
  return '';
};

const extractAssetDataFromSpreadsheet = (filePath) => {
  const workbook = xlsx.readFile(filePath, { cellDates: true });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) {
    return { text: '', lineItems: [], entities: {} };
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const firstRow = rows[0] || {};

  const asText = rows
    .slice(0, 40)
    .map((row) => Object.values(row).map((value) => String(value || '').trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n');

  const lineItems = rows.slice(0, 20).map((row) => ({
    assetNumber: findValueByHeaderHint(row, ['assetnumber', 'serialnumber', 'serialno', 'assetid']),
    assetType: findValueByHeaderHint(row, ['assettype', 'type', 'category']),
    assetName: findValueByHeaderHint(row, ['assetname', 'description', 'itemname', 'item']),
    quantity: findValueByHeaderHint(row, ['quantity', 'qty']),
    dailyRate: findValueByHeaderHint(row, ['dailyrate', 'dayrate']),
    monthlyRate: findValueByHeaderHint(row, ['monthlyrate', 'monthrate']),
  }));

  const poNo = findValueByHeaderHint(firstRow, ['ponumber', 'pono', 'poref']);
  const poDate = findValueByHeaderHint(firstRow, ['podate', 'purchaseorderdate']);
  const expectedReturnDate = findValueByHeaderHint(firstRow, ['expectedreturndate', 'returndate', 'validtill', 'validity', 'enddate', 'validupto']);
  const assignedToName = findValueByHeaderHint(firstRow, ['assignedto', 'assignee', 'employee', 'issuedto', 'user']);
  const startDate = findValueByHeaderHint(firstRow, ['startdate', 'issuedate', 'issuedon', 'takendate', 'assignmentdate']);

  return {
    text: asText,
    lineItems,
    entities: {
      organizations: [findValueByHeaderHint(firstRow, ['vendor', 'supplier'])].filter(Boolean),
      referenceNumbers: [poNo].filter(Boolean),
      dates: [poDate, expectedReturnDate].filter(Boolean),
    },
    poNumber: poNo,
    poDate,
    expectedReturnDate,
    assignedToName,
    startDate,
  };
};

const normalizeSpreadsheetRows = (filePath) => {
  const workbook = xlsx.readFile(filePath, { cellDates: true });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) return [];

  const sheet = workbook.Sheets[firstSheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });

  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const vendorName = findValueByHeaderHint(row, ['vendor', 'supplier', 'vendorname']);
    const assetName = findValueByHeaderHint(row, ['assetname', 'description', 'itemname', 'item']);
    const assetNumber = findValueByHeaderHint(row, ['assetnumber', 'serialnumber', 'serialno', 'assetid']);
    const rawCategory = findValueByHeaderHint(row, ['category', 'assettype', 'type']);
    const dailyRate = findValueByHeaderHint(row, ['dailyrate', 'dayrate']);
    const monthlyRate = findValueByHeaderHint(row, ['monthlyrate', 'monthrate']);
    const rate = findValueByHeaderHint(row, ['rate', 'billingrate']);
    const fixedCharge = findValueByHeaderHint(row, ['fixedcharge', 'fixedamount', 'lumpsum']);
    const assignedToName = findValueByHeaderHint(row, ['assignedto', 'assignee', 'employee', 'issuedto', 'user']);
    const startDate = toIsoDateLoose(findValueByHeaderHint(row, ['startdate', 'issuedate', 'issuedon', 'takendate', 'assignmentdate']));
    const expectedReturnDate = toIsoDateLoose(findValueByHeaderHint(row, ['expectedreturndate', 'returndate', 'validtill', 'validity', 'enddate', 'validupto']));
    const explicitChargeType = String(findValueByHeaderHint(row, ['chargetype', 'billingcycle', 'cycle']) || '').trim().toLowerCase();

    let chargeType = explicitChargeType;
    if (!chargeType) {
      if (String(fixedCharge || '').trim()) chargeType = 'fixed';
      else if (String(dailyRate || '').trim()) chargeType = 'daily';
      else chargeType = 'monthly';
    }

    const errors = [];
    if (!String(vendorName || '').trim()) errors.push('Vendor Name is required');
    if (!String(assetName || '').trim()) errors.push('Asset Name is required');
    if (assignedToName && !startDate) errors.push('Issue Date is required when Assigned To is provided');
    if (assignedToName && !['daily', 'monthly', 'fixed'].includes(chargeType)) {
      errors.push('Charge Type must be daily, monthly, or fixed');
    }

    return {
      rowNumber,
      isValid: errors.length === 0,
      errors,
      assetData: {
        assetUid: findValueByHeaderHint(row, ['assetuid', 'uniqueid', 'uid', 'assetcode']),
        vendorName: String(vendorName || '').trim(),
        category: inferCategory(rawCategory || assetName),
        assetName: String(assetName || '').trim(),
        serialNumber: String(assetNumber || '').trim(),
        model: findValueByHeaderHint(row, ['model']),
        dailyRate: String(dailyRate || '').trim(),
        monthlyRate: String(monthlyRate || '').trim(),
        remarks: findValueByHeaderHint(row, ['remarks', 'note', 'comment']),
      },
      issueData: {
        assignedToName: String(assignedToName || '').trim(),
        assignedToType: String(findValueByHeaderHint(row, ['assignedtotype', 'persontype']) || 'employee').trim() || 'employee',
        projectCode: findValueByHeaderHint(row, ['projectcode', 'project']),
        location: findValueByHeaderHint(row, ['location', 'site']),
        startDate,
        expectedReturnDate,
        chargeType,
        rate: String(rate || monthlyRate || dailyRate || '').trim(),
        fixedCharge: String(fixedCharge || '').trim(),
        remarks: findValueByHeaderHint(row, ['issueremarks', 'assignmentremarks']),
      },
    };
  });
};

const createAssetRecord = ({ assetData, userId }) => {
  const finalAssetUid = String(assetData.assetUid || '').trim() || generateAssetUid();
  const result = db.prepare(`
    INSERT INTO assets (
      asset_uid, vendor_name, category, asset_name, serial_number, model,
      daily_rate, monthly_rate, remarks, created_by, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', datetime('now'))
  `).run(
    finalAssetUid,
    String(assetData.vendorName || '').trim(),
    String(assetData.category || '').trim() || null,
    String(assetData.assetName || '').trim(),
    String(assetData.serialNumber || '').trim() || null,
    String(assetData.model || '').trim() || null,
    toNumber(assetData.dailyRate),
    toNumber(assetData.monthlyRate),
    String(assetData.remarks || '').trim() || null,
    userId
  );

  const assetId = result.lastInsertRowid;
  db.prepare(`
    INSERT INTO asset_events (asset_id, event_type, performed_by, details)
    VALUES (?, 'created', ?, ?)
  `).run(assetId, userId, safeJson({ vendorName: assetData.vendorName, assetName: assetData.assetName, assetUid: finalAssetUid }));

  return { assetId, assetUid: finalAssetUid };
};

const issueAssetRecord = ({ assetId, issueData, userId }) => {
  if (!issueData.assignedToName || !issueData.startDate) return { issued: false };

  const chargeType = ['daily', 'monthly', 'fixed'].includes(String(issueData.chargeType || '').trim())
    ? String(issueData.chargeType || '').trim()
    : 'monthly';

  const start = toIsoDate(issueData.startDate);
  if (!start) return { issued: false };

  const expectedReturn = toIsoDate(issueData.expectedReturnDate);
  const issueResult = db.prepare(`
    INSERT INTO asset_assignments (
      asset_id, assigned_to_name, assigned_to_type, project_code, location,
      start_date, expected_return_date, charge_type, rate, fixed_charge,
      remarks, created_by, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'))
  `).run(
    assetId,
    String(issueData.assignedToName || '').trim(),
    issueData.assignedToType || 'employee',
    issueData.projectCode || null,
    issueData.location || null,
    start,
    expectedReturn,
    chargeType,
    toNumber(issueData.rate),
    toNumber(issueData.fixedCharge),
    issueData.remarks || null,
    userId
  );

  db.prepare(`
    UPDATE assets
    SET status = 'issued', updated_at = datetime('now')
    WHERE id = ?
  `).run(assetId);

  db.prepare(`
    INSERT INTO asset_events (asset_id, assignment_id, event_type, performed_by, details)
    VALUES (?, ?, 'issued', ?, ?)
  `).run(assetId, issueResult.lastInsertRowid, userId, safeJson({
    assignedToName: issueData.assignedToName,
    startDate: start,
    expectedReturnDate: expectedReturn,
    chargeType,
  }));

  return { issued: true, assignmentId: issueResult.lastInsertRowid };
};

const lookupPoEndDate = (poNo) => {
  const normalized = String(poNo || '').trim();
  if (!normalized) return '';

  const row = db.prepare(`
    SELECT end_date
    FROM purchase_orders
    WHERE LOWER(TRIM(po_number)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(normalized);

  return toIsoDateLoose(row?.end_date || '');
};

const imageFileToBase64 = async (imagePath) => {
  const buffer = await fsp.readFile(imagePath);
  return buffer.toString('base64');
};

const pdfToBase64Pages = async (pdfPath) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jcc-asset-ai-'));
  const outputPrefix = path.join(tempDir, 'page');

  try {
    await execFileAsync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', String(MAX_AI_PAGES), pdfPath, outputPrefix]);
    const files = await fsp.readdir(tempDir);
    const pages = files
      .filter((name) => name.startsWith('page-') && name.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, MAX_AI_PAGES)
      .map((name) => path.join(tempDir, name));

    const encoded = [];
    for (const pagePath of pages) {
      encoded.push(await imageFileToBase64(pagePath));
    }

    return encoded;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
};

const prepareAiImages = async (filePath, fileType) => {
  if (fileType === 'application/pdf') return pdfToBase64Pages(filePath);
  if (fileType.startsWith('image/')) return [await imageFileToBase64(filePath)];
  return [];
};

const inferCategory = (value = '') => {
  const text = String(value || '').toLowerCase();
  if (/laptop|notebook|macbook/.test(text)) return 'laptop';
  if (/workstation|desktop|cpu|tower/.test(text)) return 'workstation';
  if (/monitor|display|screen/.test(text)) return 'monitor';
  if (/printer|plotter/.test(text)) return 'printer';
  if (/server/.test(text)) return 'server';
  if (/ups|battery/.test(text)) return 'ups';
  return 'other';
};

const notifyReturnApprovers = (assignment, type = 'pending') => {
  const approvers = db.prepare(`
    SELECT id
    FROM users
    WHERE role IN ('admin', 'manager', 'coordinator', 'final_approver')
  `).all();

  const title = type === 'pending' ? 'Return Approval Needed' : type === 'approved' ? 'Return Approved' : 'Return Rejected';
  const message = type === 'pending'
    ? `Asset ${assignment.asset_uid} return request is pending approval.`
    : type === 'approved'
      ? `Asset ${assignment.asset_uid} return has been approved.`
      : `Asset ${assignment.asset_uid} return request was rejected.`;

  approvers.forEach((user) => {
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, ?)
    `).run(user.id, title, message, type === 'rejected' ? 'error' : type === 'approved' ? 'success' : 'warning');
  });
};

const pickByRegex = (text, regexList) => {
  for (const pattern of regexList) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return '';
};

const truncateText = (value, maxLength) => {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated]`;
};

const buildAssetExtractionPrompt = (extraction, mode = 'normal') => {
  const maxText = mode === 'lite' ? 2500 : 7000;
  const maxItems = mode === 'lite' ? 4 : 10;
  const lineItems = Array.isArray(extraction.lineItems) ? extraction.lineItems.slice(0, maxItems) : [];

  return [
    'You are an expert at extracting data from rental delivery challan and PO documents.',
    'Return ONLY valid JSON object with keys:',
    'dcNo, dcDate, poNo, poDate, vendorName, assetNumber, assetType, assetName, dailyRate, monthlyRate, quantity, expectedReturnDate, assignedToName, startDate, items.',
    'Rules:',
    '- dates must be yyyy-mm-dd when possible',
    '- numeric fields should be plain numbers as string',
    '- items is an array with objects {assetNumber, assetType, assetName, quantity, dailyRate, monthlyRate}',
    '- unknown values should be empty string',
    '',
    'OCR text:',
    truncateText(extraction.text || '', maxText),
    '',
    'OCR line items:',
    JSON.stringify(lineItems),
  ].join('\n');
};

const postToOllama = async ({ prompt, images = [] }) => {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: 'json',
      options: {
        temperature: 0,
        num_ctx: 4096,
        num_keep: 0,
      },
      messages: [{ role: 'user', content: prompt, images }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${body}`);
  }

  return response.json();
};

const analyzeAssetDocWithOllama = async (extraction, images = [], mode = 'normal') => {
  const prompt = buildAssetExtractionPrompt(extraction, mode === 'fast' ? 'lite' : 'normal');
  const safeImages = mode === 'fast' ? [] : images.slice(0, 1);

  try {
    const payload = await postToOllama({ prompt, images: safeImages });
    return parseJsonObject(payload?.message?.content || '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    const shouldRetryLite = /SameBatch|numKeep|sequence|context|too large/i.test(message);

    if (!shouldRetryLite) {
      throw error;
    }

    // Retry with reduced context and no images for stability on larger docs.
    const litePrompt = buildAssetExtractionPrompt(extraction, 'lite');
    const litePayload = await postToOllama({ prompt: litePrompt, images: [] });
    return parseJsonObject(litePayload?.message?.content || '');
  }
};

const hasEnoughFallbackData = (fallback) => {
  const checks = [
    fallback.vendorName,
    fallback.poNo,
    fallback.dcNo,
    fallback.assetNumber || fallback.assetType || fallback.assetName,
  ].filter((v) => String(v || '').trim() !== '');
  return checks.length >= 3;
};

const pickAssetTypeFromText = (text = '') => {
  const value = String(text || '').toLowerCase();
  if (/laptop|notebook|macbook/.test(value)) return 'Laptop';
  if (/workstation|desktop|cpu|tower/.test(value)) return 'Workstation';
  if (/monitor|display|screen/.test(value)) return 'Monitor';
  if (/printer|plotter/.test(value)) return 'Printer';
  if (/server/.test(value)) return 'Server';
  if (/ups|battery/.test(value)) return 'UPS';
  return '';
};

const checkOllamaHealth = async () => {
  const tagsResponse = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!tagsResponse.ok) {
    const body = await tagsResponse.text();
    throw new Error(`Ollama tags API failed (${tagsResponse.status}): ${body}`);
  }

  const tagsPayload = await tagsResponse.json();
  const models = Array.isArray(tagsPayload?.models) ? tagsPayload.models : [];
  const modelNames = models.map((m) => String(m.name || '').trim()).filter(Boolean);
  const hasModel = modelNames.some((name) => name === OLLAMA_MODEL || name.startsWith(`${OLLAMA_MODEL}:`) || OLLAMA_MODEL.startsWith(`${name}:`));

  return {
    baseUrl: OLLAMA_BASE_URL,
    model: OLLAMA_MODEL,
    reachable: true,
    hasModel,
    models: modelNames,
  };
};

const formatAiConnectionError = (error) => {
  const message = error instanceof Error ? error.message : String(error || 'Unknown AI error');
  const code = error?.cause?.code || '';

  if (code === 'ECONNREFUSED' || /fetch failed/i.test(message)) {
    return `Cannot connect to Ollama at ${OLLAMA_BASE_URL}. Start Ollama service (ollama serve) and install model ${OLLAMA_MODEL} (ollama pull ${OLLAMA_MODEL}).`;
  }

  if (code === 'ETIMEDOUT') {
    return `Connection to Ollama at ${OLLAMA_BASE_URL} timed out. Ensure Ollama is running and reachable.`;
  }

  return message;
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/temp');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `asset-doc-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.xls', '.xlsx', '.csv']);
    const allowedMime = /jpeg|jpg|png|pdf|spreadsheet|excel|csv|ms-excel|officedocument/;
    if (allowedExt.has(ext) || allowedMime.test(String(file.mimetype || '').toLowerCase())) return cb(null, true);
    return cb(new Error('Only PDF, image, or Excel/CSV files are allowed'));
  },
});

router.get('/', authenticateToken, authorizeRoles(TRACKING_ROLES), (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    let assets;

    if (status) {
      assets = db.prepare(`
        SELECT
          a.*,
          u.name AS created_by_name,
          aa.assigned_to_name AS current_assigned_to_name,
          aa.assigned_to_type AS current_assigned_to_type,
          aa.start_date AS current_assigned_on,
          aa.expected_return_date AS current_expected_return_date,
          aa.project_code AS current_project_code,
          aa.location AS current_location
        FROM assets a
        LEFT JOIN users u ON u.id = a.created_by
        LEFT JOIN asset_assignments aa ON aa.id = (
          SELECT x.id
          FROM asset_assignments x
          WHERE x.asset_id = a.id AND x.status = 'open'
          ORDER BY x.id DESC
          LIMIT 1
        )
        WHERE a.status = ?
        ORDER BY a.updated_at DESC, a.id DESC
      `).all(status);
    } else {
      assets = db.prepare(`
        SELECT
          a.*,
          u.name AS created_by_name,
          aa.assigned_to_name AS current_assigned_to_name,
          aa.assigned_to_type AS current_assigned_to_type,
          aa.start_date AS current_assigned_on,
          aa.expected_return_date AS current_expected_return_date,
          aa.project_code AS current_project_code,
          aa.location AS current_location
        FROM assets a
        LEFT JOIN users u ON u.id = a.created_by
        LEFT JOIN asset_assignments aa ON aa.id = (
          SELECT x.id
          FROM asset_assignments x
          WHERE x.asset_id = a.id AND x.status = 'open'
          ORDER BY x.id DESC
          LIMIT 1
        )
        ORDER BY a.updated_at DESC, a.id DESC
      `).all();
    }

    return res.json(assets);
  } catch (error) {
    console.error('Error fetching assets:', error);
    return res.status(500).json({ error: 'Failed to fetch assets' });
  }
});

router.get('/ai-health', authenticateToken, authorizeRoles(TRACKING_ROLES), async (req, res) => {
  try {
    const health = await checkOllamaHealth();
    return res.json({
      status: health.hasModel ? 'ready' : 'model_missing',
      ...health,
      message: health.hasModel
        ? `AI service is ready with model ${health.model}`
        : `Ollama is running but model ${health.model} is missing. Run: ollama pull ${health.model}`,
    });
  } catch (error) {
    return res.status(503).json({
      status: 'unreachable',
      baseUrl: OLLAMA_BASE_URL,
      model: OLLAMA_MODEL,
      reachable: false,
      hasModel: false,
      message: formatAiConnectionError(error),
    });
  }
});

router.post('/extract-document', authenticateToken, authorizeRoles(TRACKING_ROLES), upload.single('document'), async (req, res) => {
  let uploadedPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Document file is required' });
    }

    uploadedPath = req.file.path;
    const fileType = req.file.mimetype || '';
    const fileExt = path.extname(req.file.originalname || '').toLowerCase();
    const isSpreadsheet = ['.xls', '.xlsx', '.csv'].includes(fileExt)
      || /spreadsheet|excel|csv|ms-excel|officedocument/i.test(fileType);
    const speedMode = String(req.body.speedMode || 'fast').toLowerCase();
    const extraction = isSpreadsheet
      ? extractAssetDataFromSpreadsheet(uploadedPath)
      : await extractInvoiceData(uploadedPath, fileType);
    const rawText = extraction.text || '';

    const fallback = {
      dcNo: pickByRegex(rawText, [
        /(?:delivery\s*challan|dc)\s*(?:no|number|#)\s*[:-]?\s*([A-Z0-9/-]+)/i,
      ]),
      dcDate: pickByRegex(rawText, [
        /(?:delivery\s*challan|dc)\s*date\s*[:-]?\s*([0-9/-]{8,12})/i,
      ]),
      poNo: extraction.poNumber || pickByRegex(rawText, [/(?:po|p\.o\.|purchase\s*order)\s*(?:no|number|#)\s*[:-]?\s*([A-Z0-9/-]+)/i]),
      poDate: pickByRegex(rawText, [/po\s*date\s*[:-]?\s*([0-9/-]{8,12})/i, /purchase\s*order\s*date\s*[:-]?\s*([0-9/-]{8,12})/i]),
      vendorName: extraction.entities?.organizations?.[0] || '',
      assetNumber: pickByRegex(rawText, [/(?:asset|serial)\s*(?:no|number|#)\s*[:-]?\s*([A-Z0-9/-]+)/i]),
      assetType: pickAssetTypeFromText(rawText),
      assetName: '',
      dailyRate: '',
      monthlyRate: '',
      quantity: '',
      expectedReturnDate: extraction.expectedReturnDate || pickByRegex(rawText, [
        /(?:expected\s*return|return\s*date|valid\s*till|validity\s*date|end\s*date)\s*[:-]?\s*([0-9]{2,4}[./-][0-9]{1,2}[./-][0-9]{1,4})/i,
      ]),
      assignedToName: extraction.assignedToName || pickByRegex(rawText, [
        /(?:assigned\s*to|issued\s*to|employee)\s*[:-]?\s*([A-Za-z][A-Za-z .'-]{2,})/i,
      ]),
      startDate: extraction.startDate || pickByRegex(rawText, [
        /(?:issue\s*date|issued\s*on|start\s*date|taken\s*date)\s*[:-]?\s*([0-9]{2,4}[./-][0-9]{1,2}[./-][0-9]{1,4})/i,
      ]),
      items: [],
    };

    const lineItems = Array.isArray(extraction.lineItems) ? extraction.lineItems : [];
    if (lineItems.length > 0) {
      const first = lineItems[0] || {};
      fallback.assetName = String(first.description || first.item || first.name || '').trim();
      fallback.assetType = pickAssetTypeFromText(fallback.assetName) || fallback.assetType || fallback.assetName;
      fallback.dailyRate = String(first.rate || first.unitRate || '').trim();
      fallback.monthlyRate = String(first.monthlyRate || '').trim();
      fallback.quantity = String(first.quantity || first.qty || '').trim();
      fallback.items = lineItems.slice(0, 10).map((item) => ({
        assetNumber: String(item.assetNumber || item.serial || '').trim(),
        assetType: String(item.assetType || item.category || pickAssetTypeFromText(item.description || item.name || item.item || '') || item.description || '').trim(),
        assetName: String(item.item || item.name || item.description || '').trim(),
        quantity: String(item.quantity || item.qty || '').trim(),
        dailyRate: String(item.rate || item.unitRate || '').trim(),
        monthlyRate: String(item.monthlyRate || '').trim(),
      }));
    }

    if (!fallback.dcDate && Array.isArray(extraction.entities?.dates) && extraction.entities.dates.length > 0) {
      fallback.dcDate = extraction.entities.dates[0];
    }

    if (!fallback.poDate && Array.isArray(extraction.entities?.dates) && extraction.entities.dates.length > 1) {
      fallback.poDate = extraction.entities.dates[1];
    }

    if (!fallback.dcNo && Array.isArray(extraction.entities?.referenceNumbers) && extraction.entities.referenceNumbers.length > 0) {
      fallback.dcNo = extraction.entities.referenceNumbers[0];
    }

    if (!fallback.poNo && Array.isArray(extraction.entities?.referenceNumbers)) {
      const poRef = extraction.entities.referenceNumbers.find((ref) => /po/i.test(String(ref || '')));
      fallback.poNo = poRef || fallback.poNo;
    }

    const poEndDate = lookupPoEndDate(fallback.poNo);

    let aiData = null;
    let aiError = null;
    const shouldSkipAi = isSpreadsheet || (speedMode === 'fast' && hasEnoughFallbackData(fallback));

    if (!shouldSkipAi) {
      try {
        const images = speedMode === 'fast' ? [] : await prepareAiImages(uploadedPath, fileType);
        aiData = await analyzeAssetDocWithOllama(extraction, images, speedMode === 'fast' ? 'fast' : 'normal');
      } catch (error) {
        aiError = formatAiConnectionError(error);
        console.error('Asset doc AI extract error:', aiError);
      }
    } else {
      aiError = isSpreadsheet
        ? 'AI skipped because data was extracted from spreadsheet.'
        : 'AI skipped in fast mode because OCR extracted sufficient fields.';
    }

    const emptyAiButGoodFallback = !aiData && aiError && /empty ai response/i.test(aiError) && hasEnoughFallbackData(fallback);
    if (emptyAiButGoodFallback) {
      aiError = 'AI returned empty output. OCR fallback extracted required fields.';
    }

    const merged = {
      ...fallback,
      ...(aiData || undefined),
      dcDate: toDateOnly(aiData?.dcDate || fallback.dcDate),
      poDate: toDateOnly(aiData?.poDate || fallback.poDate),
      expectedReturnDate: toDateOnly(aiData?.expectedReturnDate || fallback.expectedReturnDate || poEndDate),
      assignedToName: String(aiData?.assignedToName || fallback.assignedToName || '').trim(),
      startDate: toDateOnly(aiData?.startDate || fallback.startDate),
      category: inferCategory((aiData?.assetType || aiData?.assetName || fallback.assetType || fallback.assetName)),
      items: Array.isArray(aiData?.items) && aiData.items.length > 0 ? aiData.items : fallback.items,
      rawText,
      usedAI: Boolean(aiData),
      aiError,
    };

    return res.json(merged);
  } catch (error) {
    console.error('Error extracting asset document:', error);
    return res.status(500).json({ error: 'Failed to extract asset document' });
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try {
        fs.unlinkSync(uploadedPath);
      } catch (cleanupError) {
        console.warn('Failed to cleanup asset extract temp file:', cleanupError.message);
      }
    }
  }
});

router.post('/import-excel/preview', authenticateToken, authorizeRoles(TRACKING_ROLES), upload.single('document'), (req, res) => {
  let uploadedPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Excel file is required' });
    }

    uploadedPath = req.file.path;
    const fileExt = path.extname(req.file.originalname || '').toLowerCase();
    if (!['.xls', '.xlsx', '.csv'].includes(fileExt)) {
      return res.status(400).json({ error: 'Only Excel/CSV files are allowed for preview' });
    }

    const rows = normalizeSpreadsheetRows(uploadedPath);
    const validRows = rows.filter((row) => row.isValid);
    const invalidRows = rows.filter((row) => !row.isValid);
    const firstAutofill = rows[0] || null;

    return res.json({
      totalRows: rows.length,
      validRows: validRows.length,
      invalidRows: invalidRows.length,
      rows,
      firstAutofill,
    });
  } catch (error) {
    console.error('Error previewing Excel import:', error);
    return res.status(500).json({ error: 'Failed to preview Excel import' });
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try {
        fs.unlinkSync(uploadedPath);
      } catch (cleanupError) {
        console.warn('Failed to cleanup Excel preview temp file:', cleanupError.message);
      }
    }
  }
});

router.post('/import-excel/commit', authenticateToken, authorizeRoles(TRACKING_ROLES), upload.single('document'), (req, res) => {
  let uploadedPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Excel file is required' });
    }

    uploadedPath = req.file.path;
    const fileExt = path.extname(req.file.originalname || '').toLowerCase();
    if (!['.xls', '.xlsx', '.csv'].includes(fileExt)) {
      return res.status(400).json({ error: 'Only Excel/CSV files are allowed for bulk import' });
    }

    const autoIssue = String(req.body.autoIssue || 'true').toLowerCase() !== 'false';
    const rows = normalizeSpreadsheetRows(uploadedPath);
    const createdAssets = [];
    const failures = [];
    let issuedCount = 0;

    rows.forEach((row) => {
      if (!row.isValid) {
        failures.push({ rowNumber: row.rowNumber, error: row.errors.join(', ') });
        return;
      }

      try {
        const created = createAssetRecord({ assetData: row.assetData, userId: req.user.id });
        let issued = false;
        if (autoIssue && row.issueData.assignedToName && row.issueData.startDate) {
          const issuedResult = issueAssetRecord({ assetId: created.assetId, issueData: row.issueData, userId: req.user.id });
          issued = issuedResult.issued;
          if (issued) issuedCount += 1;
        }

        createdAssets.push({
          rowNumber: row.rowNumber,
          assetId: created.assetId,
          assetUid: created.assetUid,
          issued,
        });
      } catch (error) {
        failures.push({ rowNumber: row.rowNumber, error: error?.message || 'Failed to import row' });
      }
    });

    return res.json({
      totalRows: rows.length,
      createdCount: createdAssets.length,
      issuedCount,
      failedCount: failures.length,
      failures,
      createdAssets,
    });
  } catch (error) {
    console.error('Error committing Excel import:', error);
    return res.status(500).json({ error: 'Failed to import Excel rows' });
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try {
        fs.unlinkSync(uploadedPath);
      } catch (cleanupError) {
        console.warn('Failed to cleanup Excel import temp file:', cleanupError.message);
      }
    }
  }
});

router.post('/', authenticateToken, authorizeRoles(TRACKING_ROLES), (req, res) => {
  try {
    const {
      assetUid,
      vendorName,
      category,
      assetName,
      serialNumber,
      model,
      dailyRate,
      monthlyRate,
      remarks,
    } = req.body;

    if (!vendorName || !assetName) {
      return res.status(400).json({ error: 'vendorName and assetName are required' });
    }

    const finalAssetUid = String(assetUid || '').trim() || generateAssetUid();

    const insertResult = db.prepare(`
      INSERT INTO assets (
        asset_uid, vendor_name, category, asset_name, serial_number, model,
        daily_rate, monthly_rate, remarks, created_by, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', datetime('now'))
    `).run(
      finalAssetUid,
      String(vendorName).trim(),
      category || null,
      String(assetName).trim(),
      serialNumber || null,
      model || null,
      toNumber(dailyRate),
      toNumber(monthlyRate),
      remarks || null,
      req.user.id
    );

    const assetId = insertResult.lastInsertRowid;

    db.prepare(`
      INSERT INTO asset_events (asset_id, event_type, performed_by, details)
      VALUES (?, 'created', ?, ?)
    `).run(assetId, req.user.id, safeJson({ vendorName, assetName, assetUid: finalAssetUid }));

    return res.status(201).json({ message: 'Asset created successfully', assetId, assetUid: finalAssetUid });
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('unique')) {
      return res.status(400).json({ error: 'assetUid must be unique' });
    }
    console.error('Error creating asset:', error);
    return res.status(500).json({ error: 'Failed to create asset' });
  }
});

router.put('/:id', authenticateToken, authorizeRoles(TRACKING_ROLES), (req, res) => {
  try {
    const assetId = Number(req.params.id);
    const {
      assetUid,
      vendorName,
      category,
      assetName,
      serialNumber,
      model,
      dailyRate,
      monthlyRate,
      remarks,
      currentAssignedToName,
      currentAssignedOn,
      currentExpectedReturnDate,
    } = req.body;

    if (!Number.isFinite(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid asset id' });
    }

    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    if (!vendorName || !assetName) {
      return res.status(400).json({ error: 'vendorName and assetName are required' });
    }

    const nextAssetUid = String(assetUid || '').trim() || asset.asset_uid;

    db.prepare(`
      UPDATE assets
      SET
        asset_uid = ?,
        vendor_name = ?,
        category = ?,
        asset_name = ?,
        serial_number = ?,
        model = ?,
        daily_rate = ?,
        monthly_rate = ?,
        remarks = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      nextAssetUid,
      String(vendorName).trim(),
      String(category || '').trim() || null,
      String(assetName).trim(),
      String(serialNumber || '').trim() || null,
      String(model || '').trim() || null,
      toNumber(dailyRate),
      toNumber(monthlyRate),
      String(remarks || '').trim() || null,
      assetId
    );

    const openAssignment = db.prepare(`
      SELECT *
      FROM asset_assignments
      WHERE asset_id = ? AND status = 'open'
      ORDER BY id DESC
      LIMIT 1
    `).get(assetId);

    if (openAssignment) {
      const nextAssignedTo = String(currentAssignedToName || '').trim() || openAssignment.assigned_to_name;
      const nextAssignedOn = toIsoDate(currentAssignedOn) || openAssignment.start_date;
      const nextExpectedReturn = toIsoDate(currentExpectedReturnDate) || openAssignment.expected_return_date;

      db.prepare(`
        UPDATE asset_assignments
        SET
          assigned_to_name = ?,
          start_date = ?,
          expected_return_date = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(nextAssignedTo, nextAssignedOn, nextExpectedReturn, openAssignment.id);
    }

    db.prepare(`
      INSERT INTO asset_events (asset_id, assignment_id, event_type, performed_by, details)
      VALUES (?, ?, 'updated', ?, ?)
    `).run(
      assetId,
      openAssignment?.id || null,
      req.user.id,
      safeJson({ updatedBy: req.user.name, assetUid: nextAssetUid })
    );

    return res.json({ message: 'Asset updated successfully', assetId });
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('unique')) {
      return res.status(400).json({ error: 'assetUid must be unique' });
    }
    console.error('Error updating asset:', error);
    return res.status(500).json({ error: 'Failed to update asset' });
  }
});

router.get('/return-tracker', authenticateToken, authorizeRoles(TRACKING_ROLES), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        aa.id AS assignment_id,
        aa.asset_id,
        a.asset_uid,
        a.asset_name,
        a.vendor_name,
        a.category,
        aa.assigned_to_name,
        aa.start_date,
        aa.expected_return_date,
        aa.actual_return_date,
        aa.status AS assignment_status,
        COALESCE(aa.return_request_status, 'none') AS return_request_status,
        aa.return_requested_date,
        aa.return_requested_remarks,
        aa.return_requested_by,
        aa.return_approved_by,
        aa.return_approved_at,
        aa.return_rejection_reason,
        aa.remarks AS return_reason,
        aa.updated_at
      FROM asset_assignments aa
      JOIN assets a ON a.id = aa.asset_id
      WHERE aa.status = 'open' OR date(aa.updated_at) >= date('now', '-90 day')
      ORDER BY
        CASE WHEN aa.status = 'open' THEN 0 ELSE 1 END,
        date(COALESCE(aa.expected_return_date, aa.start_date)) ASC,
        aa.id DESC
    `).all();

    return res.json(rows);
  } catch (error) {
    console.error('Error fetching return tracker:', error);
    return res.status(500).json({ error: 'Failed to fetch return tracker' });
  }
});

router.post('/:id/issue', authenticateToken, authorizeRoles(TRACKING_ROLES), (req, res) => {
  try {
    const assetId = Number(req.params.id);
    const {
      assignedToName,
      assignedToType,
      projectCode,
      location,
      startDate,
      expectedReturnDate,
      chargeType,
      rate,
      fixedCharge,
      remarks,
    } = req.body;

    if (!assignedToName || !startDate || !chargeType) {
      return res.status(400).json({ error: 'assignedToName, startDate, and chargeType are required' });
    }

    if (!['daily', 'monthly', 'fixed'].includes(chargeType)) {
      return res.status(400).json({ error: 'chargeType must be daily, monthly, or fixed' });
    }

    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    if (asset.status === 'issued') {
      return res.status(400).json({ error: 'Asset is already issued' });
    }

    const start = toIsoDate(startDate);
    if (!start) {
      return res.status(400).json({ error: 'Invalid startDate' });
    }

    const expectedReturn = toIsoDate(expectedReturnDate);

    const result = db.prepare(`
      INSERT INTO asset_assignments (
        asset_id, assigned_to_name, assigned_to_type, project_code, location,
        start_date, expected_return_date, charge_type, rate, fixed_charge,
        remarks, created_by, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'))
    `).run(
      assetId,
      String(assignedToName).trim(),
      assignedToType || 'employee',
      projectCode || null,
      location || null,
      start,
      expectedReturn,
      chargeType,
      toNumber(rate),
      toNumber(fixedCharge),
      remarks || null,
      req.user.id
    );

    db.prepare(`
      UPDATE assets
      SET status = 'issued', updated_at = datetime('now')
      WHERE id = ?
    `).run(assetId);

    db.prepare(`
      INSERT INTO asset_events (asset_id, assignment_id, event_type, performed_by, details)
      VALUES (?, ?, 'issued', ?, ?)
    `).run(assetId, result.lastInsertRowid, req.user.id, safeJson({ assignedToName, startDate: start, expectedReturnDate: expectedReturn, chargeType }));

    return res.status(201).json({ message: 'Asset issued successfully', assignmentId: result.lastInsertRowid });
  } catch (error) {
    console.error('Error issuing asset:', error);
    return res.status(500).json({ error: 'Failed to issue asset' });
  }
});

router.post('/:id/return', authenticateToken, authorizeRoles(TRACKING_ROLES), (req, res) => {
  try {
    const assetId = Number(req.params.id);
    const { actualReturnDate, remarks } = req.body;
    const makerCheckerEnabled = getBoolSetting('return_maker_checker_enabled', false);

    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const openAssignment = db.prepare(`
      SELECT *
      FROM asset_assignments
      WHERE asset_id = ? AND status = 'open'
      ORDER BY id DESC
      LIMIT 1
    `).get(assetId);

    if (!openAssignment) {
      return res.status(400).json({ error: 'No open assignment found for this asset' });
    }

    const returnDate = toIsoDate(actualReturnDate) || new Date().toISOString().slice(0, 10);

    if (makerCheckerEnabled) {
      if (String(openAssignment.return_request_status || 'none') === 'pending') {
        return res.status(400).json({ error: 'Return request is already pending approval' });
      }

      db.prepare(`
        UPDATE asset_assignments
        SET
          return_request_status = 'pending',
          return_requested_date = ?,
          return_requested_remarks = COALESCE(?, remarks),
          return_requested_by = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(returnDate, remarks || null, req.user.id, openAssignment.id);

      notifyReturnApprovers({ asset_uid: asset.asset_uid }, 'pending');

      return res.json({
        message: 'Return request submitted for approval',
        assignmentId: openAssignment.id,
        actualReturnDate: returnDate,
        pendingApproval: true,
      });
    }

    db.prepare(`
      UPDATE asset_assignments
      SET
        actual_return_date = ?,
        status = 'closed',
        remarks = COALESCE(?, remarks),
        return_request_status = 'approved',
        return_requested_date = COALESCE(return_requested_date, ?),
        return_requested_remarks = COALESCE(return_requested_remarks, ?),
        return_requested_by = COALESCE(return_requested_by, ?),
        return_approved_by = ?,
        return_approved_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(returnDate, remarks || null, returnDate, remarks || null, req.user.id, req.user.id, openAssignment.id);

    db.prepare(`
      UPDATE assets
      SET status = 'returned', updated_at = datetime('now')
      WHERE id = ?
    `).run(assetId);

    db.prepare(`
      INSERT INTO asset_events (asset_id, assignment_id, event_type, performed_by, details)
      VALUES (?, ?, 'returned', ?, ?)
    `).run(assetId, openAssignment.id, req.user.id, safeJson({ actualReturnDate: returnDate, remarks: remarks || null }));

    notifyReturnApprovers({ asset_uid: asset.asset_uid }, 'approved');

    return res.json({ message: 'Asset return captured successfully', assignmentId: openAssignment.id, actualReturnDate: returnDate });
  } catch (error) {
    console.error('Error returning asset:', error);
    return res.status(500).json({ error: 'Failed to return asset' });
  }
});

router.post('/returns/:assignmentId/approve', authenticateToken, authorizeRoles(RETURN_APPROVER_ROLES), (req, res) => {
  try {
    const assignmentId = Number(req.params.assignmentId);
    const { actualReturnDate, remarks } = req.body;

    const assignment = db.prepare(`
      SELECT aa.*, a.asset_uid, a.id AS asset_id
      FROM asset_assignments aa
      JOIN assets a ON a.id = aa.asset_id
      WHERE aa.id = ?
    `).get(assignmentId);

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    if (assignment.status !== 'open') {
      return res.status(400).json({ error: 'Assignment is not open' });
    }

    if (String(assignment.return_request_status || 'none') !== 'pending') {
      return res.status(400).json({ error: 'No pending return request for this assignment' });
    }

    if (Number(assignment.return_requested_by) === Number(req.user.id)) {
      return res.status(403).json({ error: 'Requester cannot approve their own return request' });
    }

    const returnDate = toIsoDate(actualReturnDate) || toIsoDate(assignment.return_requested_date) || new Date().toISOString().slice(0, 10);

    db.prepare(`
      UPDATE asset_assignments
      SET
        actual_return_date = ?,
        status = 'closed',
        remarks = COALESCE(?, remarks),
        return_request_status = 'approved',
        return_approved_by = ?,
        return_approved_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(returnDate, remarks || null, req.user.id, assignmentId);

    db.prepare(`
      UPDATE assets
      SET status = 'returned', updated_at = datetime('now')
      WHERE id = ?
    `).run(assignment.asset_id);

    db.prepare(`
      INSERT INTO asset_events (asset_id, assignment_id, event_type, performed_by, details)
      VALUES (?, ?, 'returned', ?, ?)
    `).run(assignment.asset_id, assignmentId, req.user.id, safeJson({ approvedReturn: true, actualReturnDate: returnDate, remarks: remarks || null }));

    notifyReturnApprovers({ asset_uid: assignment.asset_uid }, 'approved');

    return res.json({ message: 'Return approved and closed successfully', assignmentId, actualReturnDate: returnDate });
  } catch (error) {
    console.error('Error approving return:', error);
    return res.status(500).json({ error: 'Failed to approve return' });
  }
});

router.post('/returns/:assignmentId/reject', authenticateToken, authorizeRoles(RETURN_APPROVER_ROLES), (req, res) => {
  try {
    const assignmentId = Number(req.params.assignmentId);
    const { reason } = req.body;

    const assignment = db.prepare(`
      SELECT aa.*, a.asset_uid
      FROM asset_assignments aa
      JOIN assets a ON a.id = aa.asset_id
      WHERE aa.id = ?
    `).get(assignmentId);

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    if (String(assignment.return_request_status || 'none') !== 'pending') {
      return res.status(400).json({ error: 'No pending return request for this assignment' });
    }

    db.prepare(`
      UPDATE asset_assignments
      SET
        return_request_status = 'rejected',
        return_rejection_reason = ?,
        return_approved_by = ?,
        return_approved_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(reason || null, req.user.id, assignmentId);

    notifyReturnApprovers({ asset_uid: assignment.asset_uid }, 'rejected');

    return res.json({ message: 'Return request rejected', assignmentId });
  } catch (error) {
    console.error('Error rejecting return request:', error);
    return res.status(500).json({ error: 'Failed to reject return request' });
  }
});

router.get('/:id/history', authenticateToken, authorizeRoles(TRACKING_ROLES), (req, res) => {
  try {
    const assetId = Number(req.params.id);
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const assignments = db.prepare(`
      SELECT aa.*, u.name AS created_by_name
      FROM asset_assignments aa
      LEFT JOIN users u ON u.id = aa.created_by
      WHERE aa.asset_id = ?
      ORDER BY aa.id DESC
    `).all(assetId);

    const events = db.prepare(`
      SELECT e.*, u.name AS performed_by_name
      FROM asset_events e
      LEFT JOIN users u ON u.id = e.performed_by
      WHERE e.asset_id = ?
      ORDER BY e.event_at DESC, e.id DESC
    `).all(assetId);

    return res.json({ asset, assignments, events });
  } catch (error) {
    console.error('Error fetching asset history:', error);
    return res.status(500).json({ error: 'Failed to fetch asset history' });
  }
});

router.get('/monthly-vouchers/summary', authenticateToken, authorizeRoles(TRACKING_ROLES), (req, res) => {
  try {
    const month = String(req.query.month || '').trim();

    if (!monthBounds(month)) {
      return res.status(400).json({ error: 'month is required in YYYY-MM format' });
    }

    const vouchers = db.prepare(`
      SELECT mav.*, u.name AS generated_by_name
      FROM monthly_asset_vouchers mav
      LEFT JOIN users u ON u.id = mav.generated_by
      WHERE voucher_month = ?
      ORDER BY mav.vendor_name ASC
    `).all(month);

    const enriched = vouchers.map((voucher) => {
      const items = db.prepare(`
        SELECT mi.*, a.asset_uid, a.asset_name
        FROM monthly_asset_voucher_items mi
        JOIN assets a ON a.id = mi.asset_id
        WHERE mi.voucher_id = ?
        ORDER BY mi.id ASC
      `).all(voucher.id);

      return { ...voucher, items };
    });

    const creators = db.prepare(`
      SELECT
        mav.generated_by AS user_id,
        COALESCE(u.name, 'Unknown User') AS user_name,
        COUNT(mav.id) AS voucher_count,
        ROUND(COALESCE(SUM(mav.total_amount), 0), 2) AS total_amount
      FROM monthly_asset_vouchers mav
      LEFT JOIN users u ON u.id = mav.generated_by
      WHERE mav.voucher_month = ?
      GROUP BY mav.generated_by, u.name
      ORDER BY total_amount DESC, voucher_count DESC
    `).all(month);

    return res.json({ vendors: enriched, creators });
  } catch (error) {
    console.error('Error fetching monthly voucher summary:', error);
    return res.status(500).json({ error: 'Failed to fetch monthly voucher summary' });
  }
});

router.post('/monthly-vouchers/generate', authenticateToken, authorizeRoles(TRACKING_ROLES), (req, res) => {
  try {
    const month = String(req.body.month || '').trim();
    const bounds = monthBounds(month);

    if (!bounds) {
      return res.status(400).json({ error: 'month is required in YYYY-MM format' });
    }

    const rows = db.prepare(`
      SELECT aa.*, a.vendor_name, a.asset_uid, a.asset_name, a.daily_rate, a.monthly_rate
      FROM asset_assignments aa
      JOIN assets a ON a.id = aa.asset_id
      WHERE date(aa.start_date) <= date(?)
        AND date(COALESCE(aa.actual_return_date, aa.expected_return_date, ?)) >= date(?)
    `).all(bounds.end, bounds.end, bounds.start);

    const byVendor = new Map();

    for (const row of rows) {
      const effectiveEnd = row.actual_return_date || row.expected_return_date || bounds.end;
      const billableStart = row.start_date > bounds.start ? row.start_date : bounds.start;
      const billableEnd = effectiveEnd < bounds.end ? effectiveEnd : bounds.end;

      const dayCountRow = db.prepare(`
        SELECT CAST((julianday(?) - julianday(?) + 1) AS INTEGER) AS days
      `).get(billableEnd, billableStart);

      const billableDays = Math.max(0, Number(dayCountRow?.days || 0));
      if (billableDays <= 0) continue;

      let chargeAmount = 0;
      const resolvedRate = toNumber(row.rate);
      const dailyRate = resolvedRate ?? toNumber(row.daily_rate) ?? 0;
      const monthlyRate = resolvedRate ?? toNumber(row.monthly_rate) ?? 0;

      if (row.charge_type === 'fixed') {
        chargeAmount = toNumber(row.fixed_charge) || 0;
      } else if (row.charge_type === 'daily') {
        chargeAmount = dailyRate * billableDays;
      } else {
        chargeAmount = (monthlyRate * billableDays) / bounds.daysInMonth;
      }

      const roundedCharge = Number(chargeAmount.toFixed(2));
      const vendor = row.vendor_name || 'Unknown Vendor';

      if (!byVendor.has(vendor)) {
        byVendor.set(vendor, []);
      }

      byVendor.get(vendor).push({
        assetId: row.asset_id,
        assignmentId: row.id,
        chargeType: row.charge_type,
        billableStart,
        billableEnd,
        billableDays,
        chargeAmount: roundedCharge,
        note: `${row.asset_uid} - ${row.asset_name}`,
      });
    }

    const generated = [];

    for (const [vendorName, items] of byVendor.entries()) {
      const existing = db.prepare(`
        SELECT id FROM monthly_asset_vouchers
        WHERE voucher_month = ? AND vendor_name = ?
      `).get(month, vendorName);

      const totalAmount = Number(items.reduce((sum, item) => sum + item.chargeAmount, 0).toFixed(2));
      let voucherId;

      if (existing) {
        voucherId = existing.id;
        db.prepare(`
          UPDATE monthly_asset_vouchers
          SET total_amount = ?, status = 'generated', generated_by = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(totalAmount, req.user.id, voucherId);

        db.prepare('DELETE FROM monthly_asset_voucher_items WHERE voucher_id = ?').run(voucherId);
      } else {
        const created = db.prepare(`
          INSERT INTO monthly_asset_vouchers (
            voucher_month, vendor_name, total_amount, status, generated_by, generated_at, updated_at
          ) VALUES (?, ?, ?, 'generated', ?, datetime('now'), datetime('now'))
        `).run(month, vendorName, totalAmount, req.user.id);
        voucherId = created.lastInsertRowid;
      }

      const insertItem = db.prepare(`
        INSERT INTO monthly_asset_voucher_items (
          voucher_id, asset_id, assignment_id, billable_start, billable_end,
          billable_days, charge_amount, charge_type, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      items.forEach((item) => {
        insertItem.run(
          voucherId,
          item.assetId,
          item.assignmentId,
          item.billableStart,
          item.billableEnd,
          item.billableDays,
          item.chargeAmount,
          item.chargeType,
          item.note
        );
      });

      generated.push({ voucherId, vendorName, totalAmount, itemCount: items.length });
    }

    return res.json({ message: 'Monthly vouchers generated successfully', month, generated });
  } catch (error) {
    console.error('Error generating monthly vouchers:', error);
    return res.status(500).json({ error: 'Failed to generate monthly vouchers' });
  }
});

export default router;
