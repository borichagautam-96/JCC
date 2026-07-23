import Tesseract from 'tesseract.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// const pdf = require('pdf-parse'); // Moved inside function
import { TableExtractor } from './tableExtractor.js';
const tableExtractor = new TableExtractor();

/**
 * Extract text from an image using OCR
 * @param {string} imagePath - Path to the image file
 * @returns {Promise<Object>} OCR result with text and confidence
 */
export const extractTextFromImage = async (imagePath) => {
    try {
        const result = await Tesseract.recognize(
            imagePath,
            'eng',
            {
                logger: info => console.log(info)
            }
        );

        return {
            text: result.data.text,
            confidence: result.data.confidence,
            blocks: result.data.blocks
        };
    } catch (error) {
        console.error('OCR Error:', error);
        throw new Error('Failed to extract text from image');
    }
};

/**
 * Extract text from a PDF file
 * @param {string} pdfPath - Path to the PDF file
 * @returns {Promise<Object>} Extracted text
 */
export const extractTextFromPDF = async (pdfPath) => {
    try {
        const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
        const dataBuffer = fs.readFileSync(pdfPath);

        // useSystemFonts=true suppresses standard font fetch warnings in Node.js
        // (pdfjs legacy can't load font files via file:// in Node context)
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(dataBuffer), useSystemFonts: true });
        const doc = await loadingTask.promise;

        let fullText = '';
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
            const page = await doc.getPage(pageNumber);
            const content = await page.getTextContent();

            // Keep a line-like structure by grouping tokens with similar vertical position.
            const lineBuckets = new Map();
            for (const item of content.items || []) {
                const token = (item.str || '').trim();
                if (!token) continue;

                const y = Math.round(item.transform[5] || 0);
                if (!lineBuckets.has(y)) {
                    lineBuckets.set(y, []);
                }
                lineBuckets.get(y).push({
                    x: item.transform[4] || 0,
                    str: token
                });
            }

            const sortedLines = [...lineBuckets.entries()].sort((a, b) => b[0] - a[0]);
            for (const [, tokens] of sortedLines) {
                tokens.sort((a, b) => a.x - b.x);
                fullText += tokens.map(t => t.str).join(' ') + '\n';
            }

            fullText += '\n';
        }

        return {
            text: fullText,
            confidence: 100,
            pages: doc.numPages
        };
    } catch (error) {
        console.error('PDF Text Extraction Error:', error);
        throw new Error('Failed to extract text from PDF');
    }
};

/**
 * Clean and format extracted text
 * @param {string} text - Raw OCR text
 * @returns {string} Cleaned text
 */
export const cleanText = (text) => {
    return text
        .replace(/\s+/g, ' ') // Replace multiple spaces with single space
        .replace(/\n\s*\n/g, '\n\n') // Remove excessive line breaks
        .trim();
};

/**
 * Extract entities from text (dates, reference numbers, addresses)
 * @param {string} text - OCR text
 * @returns {Object} Extracted entities
 */
export const extractEntities = (text) => {
    const entities = {
        dates: [],
        referenceNumbers: [],
        emails: [],
        phones: []
    };

    // Extract dates (DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD)
    const datePattern = /\b(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/g;
    entities.dates = text.match(datePattern) || [];

    // Extract reference numbers (REF:, Ref:, Reference:, etc. followed by alphanumeric)
    const refPattern = /(?:REF|Ref|Reference|Ref\.|REF:)\s*:?\s*([A-Z0-9-/]+)/gi;
    const refMatches = text.matchAll(refPattern);
    for (const match of refMatches) {
        entities.referenceNumbers.push(match[1]);
    }

    // Extract emails
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    entities.emails = text.match(emailPattern) || [];

    // Extract phone numbers (basic pattern)
    const phonePattern = /\b\d{10}\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
    entities.phones = text.match(phonePattern) || [];

    return entities;
};

const normalizeText = (text) => (text || '').replace(/\s+/g, ' ').trim();

const extractInvoiceNumberCore = (text) => {
    const normalized = normalizeText(text);

    const explicitPatterns = [
        // Standard formats like HBS/26-27/012, INV-001, or numeric 100/25-26
        /(?:invoice|inv|bill)\s*(?:no\.?|number|#|num|:)\s*[:\-|\s]+([A-Z0-9][A-Z0-9\s\/-]{2,25})/i,
        /(?:document|doc|voucher)\s*(?:no\.?|number|#|num)\s*[:\-]?\s*([A-Z0-9]+(?:[\s\/-][A-Z0-9]+){0,4})/i,
        // HBS/ prefix used by Hornbill and similar invoice numbering
        /(HBS\/[A-Z0-9\-\/]+)/i,
    ];

    for (const pattern of explicitPatterns) {
        const match = normalized.match(pattern);
        if (!match?.[1]) continue;
        const cleaned = match[1]
            .replace(/\b(?:REFERENCE|REF|DATED|DATE|IRN|ACK|DELIVERY|NOTE|MODE|TERMS)\b.*$/i, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase();
        if (cleaned.length >= 4 && /\d/.test(cleaned)) return cleaned;
    }

    // Fallback: match patterns like INV-2025-001, INVOICE/2025/12 but NOT bare 'INVOICE'
    const invStyle = normalized.match(/\b(INV[-/]\s*[A-Z0-9][-A-Z0-9/]{2,24}|INVOICE[-/]\s*[A-Z0-9][-A-Z0-9/]{2,24})\b/i);
    if (invStyle?.[1] && /\d/.test(invStyle[1])) return invStyle[1].toUpperCase();

    return '';
};

const extractAmountCore = (text) => {
    const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const labelPattern = /(?:grand\s*total|net\s*payable|amount\s*payable|invoice\s*value|final\s*amount|total\s*amount)/i;

    for (const line of lines) {
        if (!labelPattern.test(line)) continue;
        const amountMatch = line.match(/(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?[0-9]{0,2})\s*$/i)
            || line.match(/(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?[0-9]{0,2})/i);
        if (amountMatch?.[1]) return amountMatch[1].replace(/,/g, '');
    }

    const normalized = normalizeText(text);
    const fallback = [...normalized.matchAll(/(?:₹|rs\.?|inr)\s*([0-9][0-9,]*\.?[0-9]{0,2})/gi)]
        .map((m) => Number.parseFloat((m[1] || '').replace(/,/g, '')))
        .filter((n) => !Number.isNaN(n) && n > 10)
        .sort((a, b) => b - a);

    return fallback.length > 0 ? String(fallback[0]) : '';
};

const toIsoDate = (value) => {
    const raw = (value || '').trim();
    if (!raw) return '';
    if (/^\d{3,5}[-/]\d{2}[-/]\d{2}$/.test(raw)) return '';

    const dmy = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
    if (dmy) {
        let year = Number.parseInt(dmy[3], 10);
        if (year < 100) year += 2000;
        const month = Number.parseInt(dmy[2], 10);
        const day = Number.parseInt(dmy[1], 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
            return new Date(Date.UTC(year, month - 1, day)).toISOString().split('T')[0];
        }
    }

    const ymd = raw.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
    if (ymd) {
        const year = Number.parseInt(ymd[1], 10);
        const month = Number.parseInt(ymd[2], 10);
        const day = Number.parseInt(ymd[3], 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
            return new Date(Date.UTC(year, month - 1, day)).toISOString().split('T')[0];
        }
    }

    const monthNamed = raw.match(/^(\d{1,2})\s*[-\/.]?\s*([A-Za-z]{3,})\s*[-\/.]?\s*(\d{2,4})$/);
    if (monthNamed) {
        const monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const day = Number.parseInt(monthNamed[1], 10);
        const month = monthMap[monthNamed[2].slice(0, 3).toLowerCase()];
        let year = Number.parseInt(monthNamed[3], 10);
        if (year < 100) year += 2000;
        if (month !== undefined && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
            return new Date(Date.UTC(year, month, day)).toISOString().split('T')[0];
        }
    }

    return '';
};

const extractInvoiceDateCore = (text) => {
    const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean);
    // Allow optional non-digit prefix (e.g. '[' from OCR artifacts) before day number
    const dateTokenPattern = /[^\d]?(\d{1,2}\s*[-\/.]?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*[-\/.]?\s*\d{2,4}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}|\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/i;

    for (const line of lines) {
        if (!/(?:invoice\s*date|bill\s*date|dated|date\s*of\s*invoice)/i.test(line)) continue;
        const token = line.match(dateTokenPattern);
        if (!token?.[1]) continue;
        const iso = toIsoDate(token[1].trim());
        if (iso) return iso;
    }

    // Fallback: search the whole normalized text for a date near a 'Dated' label
    const normalized = normalizeText(text);
    // First try to find date right after 'Dated' keyword
    const datedNear = normalized.match(/(?:dated|invoice\s*date|date)\s*[\|\-\:]?\s*[^\w]?(\d{1,2}[-\/\s]?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\/\s]?\d{2,4})/i);
    if (datedNear?.[1]) {
        const iso = toIsoDate(datedNear[1].trim());
        if (iso) return iso;
    }
    // Last resort: any date pattern in text
    const token = normalized.match(dateTokenPattern);
    if (!token?.[1]) return '';
    return toIsoDate(token[1].trim());
};

const extractPONumberCore = (text) => {
    const normalized = normalizeText(text);

    const explicitPatterns = [
        /(?:buy(?:er'?s)?\s*order\s*no\.?|purchase\s*order\s*no\.?|po\s*no\.?|p\.o\.\s*no\.?)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\s\/-]{3,40})/i,
        /(?:buy(?:er'?s)?\s*order\s*no\.?|purchase\s*order\s*no\.?|po\s*no\.?|p\.o\.\s*no\.?)\s*[:\-]?\s*([^\n]{4,80})/i,
        // 'PO NO :' format common in scanned invoices
        /\bPO\s+NO\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,30})/i,
    ];

    for (const pattern of explicitPatterns) {
        const match = normalized.match(pattern);
        if (!match?.[1]) continue;

        const raw = match[1].trim();
        const firstToken = raw
            .split(/[\s,;|]+/)
            .map((part) => part.replace(/[^A-Za-z0-9/\-]/g, ''))
            .find((part) => part.length >= 4 && /\d/.test(part) && !/BOX/i.test(part));

        if (firstToken) return firstToken.toUpperCase();
    }

    return '';
};

/**
 * Extracts vendor/supplier name from OCR text.
 * The vendor name is typically the first substantial company/org name in the document,
 * appearing before "Invoice No.", "GSTIN", or "Date" labels.
 */
const extractVendorNameCore = (text) => {
    const lines = (text || '').split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);
    
    // Skip generic headers (Tax Invoice, etc.) and find the first company name line
    const skipPatterns = /^(tax\s+invoice|proforma\s+invoice|invoice|original|recipient|gstin|state\s+name|cin:|contact|e-mail|buyer|description|sl\s+no|#)/i;
    const companyNamePattern = /\b(?:pvt\.?\s*ltd\.?|private\s+limited|limited|llp|inc\.?|corp\.?|studios|enterprises|works|services|systems|technologies|consulting|engineers|prints|trading|industries)\b/i;
    
    const cleanVendorName = (name) => {
        // Remove trailing invoice labels that OCR puts on the same line
        return name
            .replace(/\s*invoice\s+no\.?.*/i, '')
            .replace(/\s*dated.*/i, '')
            .replace(/\s*gstin.*/i, '')
            .replace(/^[^A-Za-z]+/, '')
            .trim();
    };
    
    for (const line of lines) {
        if (skipPatterns.test(line)) continue;
        // Looks like a company name - stop at pipe character (OCR table separator)
        const cleanLine = line.split('|')[0].trim();
        if (companyNamePattern.test(cleanLine) && cleanLine.length > 5 && cleanLine.length < 150) {
            return cleanVendorName(cleanLine);
        }
    }
    
    // Fallback: first non-skipped line that is long enough to be a company name
    for (const line of lines) {
        if (skipPatterns.test(line)) continue;
        const cleanLine = line.split('|')[0].trim();
        if (cleanLine.length > 8 && cleanLine.length < 150 && /[A-Z]/.test(cleanLine)) {
            return cleanVendorName(cleanLine);
        }
    }
    
    return '';
};

export const extractCoreInvoiceFields = (text) => {
    return {
        vendorName: extractVendorNameCore(text),
        invoiceNumber: extractInvoiceNumberCore(text),
        amount: extractAmountCore(text),
        date: extractInvoiceDateCore(text),
        poNumber: extractPONumberCore(text)
    };
};

/**
 * Process uploaded letter with OCR
 * @param {string} filePath - Path to uploaded file
 * @param {string} fileType - Type of file (image/pdf)
 * @returns {Promise<Object>} Processed OCR result
 */


/**
 * Extract comprehensive invoice data including table
 * @param {string} filePath 
 * @param {string} fileType 
 */
/**
 * Checks whether `pdftoppm` (poppler-utils) is available on the system PATH.
 */
const isPdftoppmAvailable = (() => {
    let cached = null;
    return () => {
        if (cached !== null) return cached;
        try {
            execSync('pdftoppm -v', { stdio: 'pipe' });
            cached = true;
        } catch (_) {
            cached = false;
        }
        return cached;
    };
})();

/**
 * Converts every page of a PDF to a high-resolution PNG using pdftoppm.
 * Works for BOTH digital PDFs and scanned/image-based PDFs.
 * Returns { files: string[], tmpDir: string } — caller must delete tmpDir.
 */
const pdfPagesToImages = (filePath) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftoppm-'));
    const outPrefix = path.join(tmpDir, 'page');

    // 300 DPI gives excellent OCR accuracy on both digital and scanned PDFs.
    // Quotes around paths handle spaces in temp dir names.
    execSync(`pdftoppm -r 300 -png "${filePath}" "${outPrefix}"`, { stdio: 'pipe' });

    const files = fs.readdirSync(tmpDir)
        .filter(f => f.endsWith('.png'))
        .sort()                              // page-1.png, page-2.png, ...
        .map(f => path.join(tmpDir, f));

    return { files, tmpDir };
};

/**
 * Pure-JS PDF → page-image rasterizer using pdfjs-dist + @napi-rs/canvas.
 * This is the cross-platform fallback for scanned/image PDFs when the native
 * `pdftoppm` (poppler) binary is NOT installed — it needs no system binary,
 * so scanned-PDF OCR works on any machine (local dev, Docker, etc.).
 * Returns { files: string[], tmpDir: string } — caller must delete tmpDir.
 */
let _napiCanvas = null;
const getNapiCanvas = () => {
    if (_napiCanvas) return _napiCanvas;
    const napi = require('@napi-rs/canvas');
    // pdfjs (legacy build) expects these DOM globals; back them with @napi-rs/canvas
    if (!globalThis.DOMMatrix) globalThis.DOMMatrix = napi.DOMMatrix;
    if (!globalThis.Path2D) globalThis.Path2D = napi.Path2D;
    if (!globalThis.ImageData) globalThis.ImageData = napi.ImageData;
    _napiCanvas = napi;
    return napi;
};

const pdfPagesToImagesJS = async (filePath) => {
    const { createCanvas } = getNapiCanvas();
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const data = new Uint8Array(fs.readFileSync(filePath));

    class NodeCanvasFactory {
        create(w, h) {
            const canvas = createCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
            return { canvas, context: canvas.getContext('2d') };
        }
        reset(cc, w, h) { cc.canvas.width = Math.max(1, Math.ceil(w)); cc.canvas.height = Math.max(1, Math.ceil(h)); }
        destroy(cc) { if (cc.canvas) { cc.canvas.width = 0; cc.canvas.height = 0; } cc.canvas = null; cc.context = null; }
    }

    const factory = new NodeCanvasFactory();
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true, canvasFactory: factory }).promise;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfjs-raster-'));
    const files = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        // 300 DPI (scale 300/72) gives strong OCR accuracy
        const viewport = page.getViewport({ scale: 300 / 72 });
        const cc = factory.create(viewport.width, viewport.height);
        await page.render({ canvasContext: cc.context, viewport, canvasFactory: factory }).promise;
        const outPath = path.join(tmpDir, `page-${String(p).padStart(3, '0')}.png`);
        fs.writeFileSync(outPath, cc.canvas.toBuffer('image/png'));
        files.push(outPath);
        factory.destroy(cc);
        try { page.cleanup(); } catch (_) {}
    }
    try { await doc.destroy(); } catch (_) {}
    return { files, tmpDir };
};

/**
 * Run Tesseract OCR on an image file and return the extracted text.
 */
const ocrImageFile = async (imagePath) => {
    const Tesseract = (await import('tesseract.js')).default;
    const worker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
    try {
        const result = await worker.recognize(imagePath);
        return result.data.text || '';
    } finally {
        await worker.terminate();
        try { fs.unlinkSync(imagePath); } catch (_) {}
    }
};

export const extractInvoiceData = async (filePath, fileType) => {
    try {
        let result;
        if (fileType === 'application/pdf') {
            // ── Step 1: Try pdfjs geometric text extraction ─────────────────
            // Fast, zero-dependency. Works for digital (text-layer) PDFs.
            try {
                result = await tableExtractor.extractTableFromPdf(filePath);
            } catch (e) {
                console.warn('PDF geometric extraction failed, falling back to basic:', e);
            }
        }

        if (!result || !result.text || result.text.length < 50) {
            console.log('Using Image/OCR extraction for:', filePath);

            if (fileType === 'application/pdf') {
                // ── Step 2a: Check for a text layer via basic pdfjs read ─────
                const basic = await extractTextFromPDF(filePath);

                if (basic.text && basic.text.trim().length > 50) {
                    // Digital PDF with text layer — use pdfjs text directly
                    result = { text: basic.text, lineItems: [] };
                } else {
                    // ── Step 2b: Scanned / image-based PDF ───────────────────
                    // Primary: render every page to a 300-DPI PNG via pdftoppm,
                    // then run Tesseract on each page image.
                    // Fallback: extract embedded image XObjects via pdfjs (less reliable).
                    console.log('PDF appears to be image-based (scanned). Running OCR pipeline...');
                    let ocrText = '';
                    let tmpDirToClean = null;

                    try {
                        if (isPdftoppmAvailable()) {
                            console.log('pdftoppm available — rendering pages at 300 DPI...');
                            const { files, tmpDir } = await pdfPagesToImages(filePath);
                            tmpDirToClean = tmpDir;

                            if (files.length > 0) {
                                console.log(`Rendered ${files.length} page(s). Running Tesseract OCR...`);
                                // OCR pages sequentially to avoid Tesseract memory spikes
                                const pageTexts = [];
                                for (const imgPath of files) {
                                    pageTexts.push(await ocrImageFile(imgPath));
                                }
                                ocrText = pageTexts.join('\n\n');
                                console.log(`OCR complete. Total text length: ${ocrText.length}`);
                            }
                        } else {
                            // Fallback: pure-JS pdfjs rasterizer (@napi-rs/canvas) — no poppler needed.
                            // Renders every page to a 300-DPI PNG, then Tesseract-OCRs each.
                            console.warn('pdftoppm not available — using pure-JS pdfjs rasterizer (no system binary needed)');
                            const { files, tmpDir } = await pdfPagesToImagesJS(filePath);
                            tmpDirToClean = tmpDir;
                            if (files.length > 0) {
                                console.log(`Rendered ${files.length} page(s) via pdfjs. Running Tesseract OCR...`);
                                const pageTexts = [];
                                for (const imgPath of files) {
                                    pageTexts.push(await ocrImageFile(imgPath));
                                }
                                ocrText = pageTexts.join('\n\n');
                                console.log(`OCR complete. Total text length: ${ocrText.length}`);
                            }
                        }
                    } catch (imgErr) {
                        console.warn('Scanned PDF OCR pipeline failed:', imgErr.message);
                    } finally {
                        // Clean up the pdftoppm temp directory
                        if (tmpDirToClean) {
                            try { fs.rmSync(tmpDirToClean, { recursive: true, force: true }); } catch (_) {}
                        }
                    }

                    result = { text: ocrText, lineItems: [] };
                }
            } else {
                // ── Direct image file (JPEG / PNG uploaded directly) ─────────
                const imageText = await extractTextFromImage(filePath);
                let lineItems = [];
                try {
                    const tableFromImage = await tableExtractor.extractTableFromImage(filePath);
                    lineItems = tableFromImage.lineItems || [];
                } catch (tableError) {
                    console.warn('Image table extraction failed, continuing with OCR text only:', tableError.message);
                }
                result = { text: imageText.text || '', lineItems };
            }
        }

        const cleanedText = cleanText(result.text || '');
        const entities = extractEntities(cleanedText);
        const coreFields = extractCoreInvoiceFields(result.text || '');

        return {
            text: cleanedText,
            lineItems: result.lineItems || [],
            entities,
            ...coreFields,
            confidence: 90,
            processedAt: new Date().toISOString()
        };
    } catch (error) {
        console.error('Invoice extraction error:', error);
        throw error;
    }
};


export const processLetter = async (filePath, fileType) => {
    // Legacy wrapper or reused
    return transformInvoiceToLetterFormat(await extractInvoiceData(filePath, fileType));
};

function transformInvoiceToLetterFormat(invoiceData) {
    return {
        text: invoiceData.text,
        confidence: invoiceData.confidence,
        entities: invoiceData.entities,
        processedAt: invoiceData.processedAt
    };
}
