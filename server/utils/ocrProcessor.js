import Tesseract from 'tesseract.js';
import fs from 'fs';
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
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(dataBuffer) });
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
        /(?:invoice|inv|bill)\s*(?:no\.?|number|#|num)\s*[:\-]?\s*([A-Z0-9]+(?:[\s\/-][A-Z0-9]+){0,4})/i,
        /(?:document|doc|voucher)\s*(?:no\.?|number|#|num)\s*[:\-]?\s*([A-Z0-9]+(?:[\s\/-][A-Z0-9]+){0,4})/i
    ];

    for (const pattern of explicitPatterns) {
        const match = normalized.match(pattern);
        if (!match?.[1]) continue;
        const cleaned = match[1]
            .replace(/\b(?:REFERENCE|REF|DATED|DATE|IRN|ACK)\b.*$/i, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase();
        if (cleaned.length >= 4 && /\d/.test(cleaned)) return cleaned;
    }

    const invStyle = normalized.match(/\b(INV[-/]?[A-Z0-9/-]{2,25}|INVOICE[-/]?[A-Z0-9/-]{2,25})\b/i);
    if (invStyle?.[1]) return invStyle[1].toUpperCase();

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
    const dateTokenPattern = /(\d{1,2}\s*[-\/.]?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*[-\/.]?\s*\d{2,4}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}|\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/i;

    for (const line of lines) {
        if (!/(?:invoice\s*date|bill\s*date|dated|date\s*of\s*invoice)/i.test(line)) continue;
        const token = line.match(dateTokenPattern);
        if (!token?.[1]) continue;
        const iso = toIsoDate(token[1]);
        if (iso) return iso;
    }

    const normalized = normalizeText(text);
    const token = normalized.match(dateTokenPattern);
    if (!token?.[1]) return '';
    return toIsoDate(token[1]);
};

const extractPONumberCore = (text) => {
    const normalized = normalizeText(text);

    const explicitPatterns = [
        /(?:buy(?:er'?s)?\s*order\s*no\.?|purchase\s*order\s*no\.?|po\s*no\.?|p\.o\.\s*no\.?)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\s\/-]{3,40})/i,
        /(?:buy(?:er'?s)?\s*order\s*no\.?|purchase\s*order\s*no\.?|po\s*no\.?|p\.o\.\s*no\.?)\s*[:\-]?\s*([^\n]{4,80})/i
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

export const extractCoreInvoiceFields = (text) => {
    return {
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
export const extractInvoiceData = async (filePath, fileType) => {
    try {
        let result;
        if (fileType === 'application/pdf') {
            // First try PDF geometric extraction
            try {
                result = await tableExtractor.extractTableFromPdf(filePath);
            } catch (e) {
                console.warn('PDF geometric extraction failed, falling back to basic:', e);
                // Fallback handled below if result is empty
            }
        }

        if (!result || !result.text || result.text.length < 50) {
            // If PDF extraction failed or file is image, use OCR/Image extraction
            console.log('Using Image/ORC extraction for:', filePath);
            // If PDF, we might need to convert to image? 
            // TableExtractor.extractTableFromImage takes image path.
            // If fileType is pdf, Tesseract won't work directly on filePath.
            // But if it's an image file (jpg/png) it works.

            if (fileType === 'application/pdf') {
                // We rely on standard pdf-parse for text if geometric failed
                const basic = await extractTextFromPDF(filePath);
                result = { text: basic.text, lineItems: [] };
            } else {
                // It's an image: prioritize direct OCR text for core fields.
                const imageText = await extractTextFromImage(filePath);
                let lineItems = [];
                try {
                    const tableFromImage = await tableExtractor.extractTableFromImage(filePath);
                    lineItems = tableFromImage.lineItems || [];
                } catch (tableError) {
                    console.warn('Image table extraction failed, continuing with OCR text only:', tableError.message);
                }

                result = {
                    text: imageText.text || '',
                    lineItems
                };
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
            confidence: 90, // Estimation
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
