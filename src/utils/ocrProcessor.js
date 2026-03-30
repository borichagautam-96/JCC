import Tesseract from 'tesseract.js';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.js?url';

// Use bundled worker to avoid network/CDN failures in restricted environments.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

export const processInvoice = async (file) => {
    try {
        // Handle PDF files
        if (file.type === 'application/pdf') {
            console.log('PDF detected - extracting data...');
            return await processPDF(file);
        }

        // Handle image files with OCR
        console.log('Image file detected - running OCR...');
        return await processImage(file);

    } catch (error) {
        console.error('Processing Error:', error);
        // Return empty data for manual entry
        return {
            vendorName: '',
            invoiceNumber: '',
            amount: '',
            date: '',
            poNumber: '',
            lineItems: [],
            rawText: `Error: ${error.message}`,
        };
    }
};

const processPDF = async (pdfFile) => {
    try {
        console.log('[OCR] Starting PDF processing...');
        console.log('[OCR] Reading PDF file...');
        const arrayBuffer = await pdfFile.arrayBuffer();
        console.log('[OCR] Array buffer size:', arrayBuffer.byteLength);

        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        console.log('[OCR] PDF loaded. Pages:', pdf.numPages);

        const pagesToScan = Math.min(pdf.numPages, 3);
        let searchableText = '';
        let allItems = [];
        const pageHandles = [];

        for (let pageNumber = 1; pageNumber <= pagesToScan; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            pageHandles.push(page);

            const textContent = await page.getTextContent();
            console.log(`[OCR] Page ${pageNumber} text items:`, textContent.items.length);

            const viewport = page.getViewport({ scale: 1.0 });
            const pageItems = textContent.items.map(item => ({
                text: item.str,
                x: item.transform[4],
                y: viewport.height - item.transform[5],
                width: item.width,
                height: item.height
            }));

            allItems = allItems.concat(pageItems);
            searchableText += buildReadableTextFromItems(pageItems) + '\n';
        }

        searchableText = searchableText.trim();
        console.log('[OCR] Combined text length:', searchableText.length);
        console.log('[OCR] Combined sample:', searchableText.substring(0, 200));

        const hasSearchableText = allItems.length > 10;
        const tableData = hasSearchableText ? extractTableFromItems(allItems) : { lineItems: [], tableHeaders: [] };
        const extractedFromText = extractDataFromText(searchableText, tableData.lineItems || []);

        const hasKeyFields = extractedFromText.invoiceNumber && extractedFromText.amount;
        if (hasSearchableText && hasKeyFields) {
            console.log('[OCR] Extracted data from searchable PDF text:', extractedFromText);
            return {
                ...extractedFromText,
                ...tableData
            };
        }

        // OCR fallback for scanned PDFs or weak searchable text extraction.
        console.log('[OCR] Running OCR fallback on PDF pages...');
        let ocrMerged = {
            vendorName: '',
            invoiceNumber: '',
            amount: '',
            date: '',
            poNumber: '',
            lineItems: [],
            rawText: ''
        };

        for (const page of pageHandles) {
            const pageOcr = await processScannedPDF(page);
            ocrMerged = {
                ...ocrMerged,
                ...pageOcr,
                vendorName: ocrMerged.vendorName || pageOcr.vendorName || '',
                invoiceNumber: ocrMerged.invoiceNumber || pageOcr.invoiceNumber || '',
                amount: ocrMerged.amount || pageOcr.amount || '',
                date: ocrMerged.date || pageOcr.date || '',
                poNumber: ocrMerged.poNumber || pageOcr.poNumber || '',
                rawText: [ocrMerged.rawText, pageOcr.rawText].filter(Boolean).join('\n')
            };

            if (ocrMerged.invoiceNumber && ocrMerged.amount && ocrMerged.poNumber) {
                break;
            }
        }

        const mergedData = {
            ...ocrMerged,
            ...extractedFromText,
            vendorName: extractedFromText.vendorName || ocrMerged.vendorName || '',
            invoiceNumber: extractedFromText.invoiceNumber || ocrMerged.invoiceNumber || '',
            amount: extractedFromText.amount || ocrMerged.amount || '',
            date: extractedFromText.date || ocrMerged.date || '',
            poNumber: extractedFromText.poNumber || ocrMerged.poNumber || '',
            rawText: [searchableText, ocrMerged.rawText].filter(Boolean).join('\n')
        };

        return {
            ...mergedData,
            ...tableData,
            lineItems: (tableData.lineItems && tableData.lineItems.length > 0)
                ? tableData.lineItems
                : (ocrMerged.lineItems || [])
        };

    } catch (error) {
        console.error('[OCR] PDF processing error:', error);
        throw error;
    }
};

const processScannedPDF = async (pdfPage) => {
    try {
        const scale = 2.0;
        const viewport = pdfPage.getViewport({ scale });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await pdfPage.render({ canvasContext: context, viewport }).promise;

        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        if (!blob) {
            throw new Error('Failed to render PDF page for OCR');
        }
        return await processImage(blob);

    } catch (error) {
        console.error('Scanned PDF OCR error:', error);
        throw error;
    }
};

const processImage = async (imageFile) => {
    try {
        const result = await Tesseract.recognize(imageFile, 'eng', {
            logger: m => m.status === 'recognizing text' && console.log(`OCR: ${Math.round(m.progress * 100)}%`)
        });

        // Normalize OCR words to common item format
        const items = result.data.words.map(w => ({
            text: w.text,
            x: w.bbox.x0,
            y: w.bbox.y0,
            width: w.bbox.x1 - w.bbox.x0,
            height: w.bbox.y1 - w.bbox.y0
        }));

        const fullText = result.data.text;
        const tableData = extractTableFromItems(items);

        return {
            ...extractDataFromText(fullText, tableData.lineItems || []),
            ...tableData
        };

    } catch (error) {
        console.error('Image OCR error:', error);
        throw error;
    }
};

const buildReadableTextFromItems = (items) => {
    if (!items || items.length === 0) return '';

    const sorted = [...items].sort((a, b) => {
        if (Math.abs(a.y - b.y) < 8) return a.x - b.x;
        return a.y - b.y;
    });

    const lines = [];
    let currentLine = [];
    let currentY = -1;

    sorted.forEach((item) => {
        if (!item.text || !item.text.trim()) return;

        if (currentY === -1 || Math.abs(item.y - currentY) <= 10) {
            currentLine.push(item);
            if (currentY === -1) currentY = item.y;
        } else {
            lines.push(currentLine.sort((a, b) => a.x - b.x).map((i) => i.text).join(' '));
            currentLine = [item];
            currentY = item.y;
        }
    });

    if (currentLine.length > 0) {
        lines.push(currentLine.sort((a, b) => a.x - b.x).map((i) => i.text).join(' '));
    }

    return lines.join('\n');
};

// --- Table Extraction Logic ---

const extractTableFromItems = (items) => {
    // 1. Group items into lines based on Y coordinate
    // Improve line grouping with a slightly larger tolerance for scanned docs
    items.sort((a, b) => a.y - b.y);

    const lines = [];
    let currentLine = [];
    let currentY = -1;
    const TOLERANCE = 12; // Increased tolerance

    items.forEach(item => {
        if (!item.text.trim()) return;

        if (currentY === -1 || Math.abs(item.y - currentY) < TOLERANCE) {
            currentLine.push(item);
            if (currentY === -1) currentY = item.y;
        } else {
            lines.push({ y: currentY, items: currentLine.sort((a, b) => a.x - b.x) });
            currentLine = [item];
            currentY = item.y;
        }
    });
    if (currentLine.length) lines.push({ y: currentY, items: currentLine.sort((a, b) => a.x - b.x) });

    console.log(`Detected ${lines.length} text lines`);

    // 2. Identify Header Row(s)
    // We look for 1-3 consecutive lines that contain our keywords
    const commonHeaders = [
        'description', 'particulars', 'item', 'details', 'narration', 'desc',
        'qty', 'quantity', 'nos', 'unit',
        'rate', 'price', 'unit price',
        'amount', 'total', 'value', 'net',
        'sr', 'sl', 'no.', 's.no',
        'ledger', 'account', 'location', 'enterprise', 'dept', 'project', 'csr', 'excise', 'employee'
    ];

    let headerStart = -1;
    let headerEnd = -1;

    // Scan lines for header keywords
    for (let i = 0; i < Math.min(30, lines.length); i++) {
        const checkWindow = [i, i + 1].filter(idx => idx < lines.length); // Look at current and next line
        const combinedText = checkWindow.map(idx => lines[idx].items.map(it => it.text.toLowerCase()).join(' ')).join(' ');

        let matchCount = 0;
        commonHeaders.forEach(k => {
            if (combinedText.includes(k)) matchCount++;
        });

        // Strong signal: "Ledger", "Project", "Amount" together
        if (matchCount >= 3 || (combinedText.includes('ledger') && combinedText.includes('amount'))) {
            headerStart = i;
            headerEnd = i;
            // Check if next line also has keywords (continuation of header)
            if (i + 1 < lines.length) {
                const nextLineText = lines[i + 1].items.map(it => it.text.toLowerCase()).join(' ');
                let nextMatches = 0;
                commonHeaders.forEach(k => { if (nextLineText.includes(k)) nextMatches++; });
                if (nextMatches >= 1) {
                    headerEnd = i + 1;
                }
            }
            break;
        }
    }

    if (headerStart === -1) {
        console.warn('No table header found.');
        return { lineItems: [], tableHeaders: [] };
    }

    console.log(`Header detected from line ${headerStart} to ${headerEnd}`);

    // Build Header Columns from the identified header lines
    // We project all items in the header range onto the X-axis to define columns
    let allHeaderItems = [];
    for (let i = headerStart; i <= headerEnd; i++) {
        allHeaderItems = allHeaderItems.concat(lines[i].items);
    }
    allHeaderItems.sort((a, b) => a.x - b.x);

    // Merge overlapping/close items on X-axis to form specific columns
    let headerColumns = [];
    if (allHeaderItems.length > 0) {
        let currentCol = {
            text: allHeaderItems[0].text,
            xStart: allHeaderItems[0].x,
            xEnd: allHeaderItems[0].x + allHeaderItems[0].width
        };

        for (let i = 1; i < allHeaderItems.length; i++) {
            const item = allHeaderItems[i];
            // If item starts close to where previous ended (within 30px), merge it
            // OR if it overlaps (vertical stack flattened)
            if (item.x < currentCol.xEnd + 40) {
                currentCol.text += " " + item.text;
                // Update bounds
                currentCol.xEnd = Math.max(currentCol.xEnd, item.x + item.width);
            } else {
                headerColumns.push(currentCol);
                currentCol = {
                    text: item.text,
                    xStart: item.x,
                    xEnd: item.x + item.width
                };
            }
        }
        headerColumns.push(currentCol);
    }

    // Refine Column Objects
    headerColumns = headerColumns.map(c => ({
        text: c.text.trim().replace(/\s+/g, ' '),
        normalized: c.text.toLowerCase().replace(/[^a-z0-9]/g, ''),
        xStart: c.xStart,
        xEnd: c.xEnd,
        center: c.xStart + ((c.xEnd - c.xStart) / 2),
        width: c.xEnd - c.xStart
    }));

    console.log('Detected Columns:', headerColumns.map(c => c.text));


    // 3. Extract Line Items
    const lineItems = [];
    const END_KEYWORDS = ['total', 'sub total', 'grand', 'amount in words', 'gross amount', 'net amount', 'authorised', 'signature'];

    for (let i = headerEnd + 1; i < lines.length; i++) {
        const line = lines[i];
        const lineString = line.items.map(it => it.text).join(' ').toLowerCase();

        if (END_KEYWORDS.some(k => lineString.startsWith(k) || (lineString.includes(k) && lineString.length < 50))) {
            break;
        }

        const rowData = {};
        headerColumns.forEach(c => rowData[c.normalized] = '');

        line.items.forEach(item => {
            const itemCenter = item.x + (item.width / 2);
            let bestCol = null;
            let minDist = Infinity;

            headerColumns.forEach(col => {
                const dist = Math.abs(col.center - itemCenter);
                if (dist < minDist) {
                    minDist = dist;
                    bestCol = col;
                }
            });

            // Looser check for column assignment (200px)
            if (bestCol && minDist < 200) {
                const key = bestCol.normalized;
                rowData[key] = (rowData[key] ? rowData[key] + ' ' : '') + item.text;
            }
        });

        let hasContent = false;
        Object.keys(rowData).forEach(key => {
            rowData[key] = rowData[key].trim();
            if (rowData[key]) hasContent = true;
        });

        if (hasContent) {
            const finalRow = {};
            headerColumns.forEach(col => {
                const val = rowData[col.normalized];
                // Map to standard keys if possible
                let key = col.text;
                const norm = col.normalized;
                if (norm.includes('desc') || norm.includes('particular')) key = 'description';
                else if (norm.includes('qty') || norm.includes('quant')) key = 'quantity';
                else if ((norm.includes('rate') || norm.includes('price')) && !norm.includes('enterprise')) key = 'rate';
                else if (norm.includes('amount') || norm.includes('total')) key = 'amount';

                finalRow[key] = val;
            });

            // Filter noise using string length check
            if (Object.values(finalRow).join('').length > 3) {
                lineItems.push(finalRow);
            }
        }
    }

    return { lineItems, tableHeaders: headerColumns.map(c => c.text) };
};


// --- Existing Regex Extractors (Enhanced) ---

const extractDataFromText = (text, lineItems = []) => {
    return {
        vendorName: extractVendorName(text),
        invoiceNumber: extractInvoiceNumber(text),
        amount: extractAmount(text, lineItems),
        date: extractDate(text),
        poNumber: extractPONumber(text),
        rawText: text,
    };
};

const extractLabeledValue = (text, labelPattern, valuePattern) => {
    const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const labelRegex = new RegExp(labelPattern, 'i');
    const valueRegex = new RegExp(valuePattern, 'i');

    for (const line of lines) {
        if (!labelRegex.test(line)) continue;
        const valueMatch = line.match(valueRegex);
        if (valueMatch?.[1]) {
            return valueMatch[1].trim();
        }
    }

    return '';
};

const extractVendorName = (text) => {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    const patterns = [
        /(?:supplier\s+name|vendor\s+name)[\s:]+([A-Z\s&.,'()-]+)/i, // Explicit label first
        /([A-Z][A-Za-z\s&.,'()-]+(?:Pvt\.?\s*Ltd\.?|Private\s+Limited|Limited|Ltd\.?|LLP|Inc\.?|Corporation|Corp\.?))/gi,
        /([A-Z][A-Z\s&]+(?:PVT\.?\s*LTD\.?|PRIVATE\s+LIMITED|LIMITED|LTD\.?|LLP|INC\.?|CORPORATION|CORP\.?))/g,
        /(?:vendor|supplier|company|from|bill\s+from)[:\s]+([A-Z][A-Za-z\s&.,'-]+(?:Pvt\.?\s*Ltd\.?|Private\s+Limited|Limited|Ltd\.?|LLP|Inc\.?|Corp\.?))/i,
        /^([A-Z][A-Za-z\s&.,'()-]+(?:Pvt\.?\s*Ltd\.?|Private\s+Limited|Limited|Ltd\.?|LLP|Inc\.?|Corp\.?))/im,
    ];

    for (const pattern of patterns) {
        const matches = [...text.matchAll(pattern)];
        for (const match of matches) {
            const vendorName = match[1].trim();
            if (vendorName.length > 3 && vendorName.split(/\s+/).length >= 2) return vendorName;
        }
    }

    // Fallback: First few lines
    for (let i = 0; i < Math.min(10, lines.length); i++) {
        const line = lines[i];
        if (/(?:Pvt\.?\s*Ltd\.?|Private\s+Limited|Limited|Ltd\.?|LLP|Inc\.?|Corp\.?)/i.test(line)) {
            const cleaned = line.replace(/[^\w\s&.,'()-]/g, '').trim();
            if (cleaned.length > 3) return cleaned;
        }
        if (line === line.toUpperCase() && line.length > 10 && line.length < 100) {
            if (!/^(INVOICE|BILL|TAX|GST|QUOTATION|RECEIPT)/.test(line)) return line;
        }
    }
    return '';
};

const extractInvoiceNumber = (text) => {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean);

    // OCR-safe, label-first extraction (supports formats like "SLA 0343/25-26").
    for (const line of lines) {
        if (!/(?:tax\s*)?invoice\s*(?:no\.?|number|#|num)?|\binv\b\s*(?:no\.?|#)?|bill\s*(?:no\.?|number|#)?/i.test(line)) {
            continue;
        }

        let candidate = line
            .replace(/.*?(?:invoice|inv|bill)\s*(?:no\.?|number|#|num)?\s*[:\-]?\s*/i, '')
            .replace(/\b(?:date|dated|gstin|irn|ack(?:\s*no)?|po\b|p\.o\.)\b.*$/i, '')
            .trim();

        // Keep at most two OCR tokens to avoid dragging full sentence text.
        if (candidate) {
            const parts = candidate.split(/\s+/).slice(0, 2);
            candidate = parts.join(' ').replace(/[^A-Za-z0-9/\-\s]/g, '').trim();
            if (candidate.length >= 4 && /\d/.test(candidate)) {
                return candidate.toUpperCase();
            }
        }
    }

    const patterns = [
        /(?:tax\s+)?invoice\s*(?:no\.?|number|#|num)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\s\/-]{3,30})/i,
        /inv\s*(?:no|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\s\/-]{3,30})/i,
        /bill\s*(?:no|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\s\/-]{3,30})/i,
        /(?:document|doc|voucher)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\s\/-]{3,30})/i,
        /#\s*([A-Z0-9][A-Z0-9\/-]{3,25})/i,
        /\b(INV[-/]?[A-Z0-9/-]{2,25})\b/i,
        /\b(INVOICE[-/]?[A-Z0-9/-]{2,25})\b/i,
    ];

    for (const pattern of patterns) {
        const match = normalizedText.match(pattern);
        if (match && match[1] && match[1].length >= 4) {
            const num = match[1].replace(/\s+/g, ' ').trim().toUpperCase();
            if (!['INVOICE', 'NUMBER', 'DATE', 'TOTAL', 'AMOUNT'].includes(num)) return num;
        }
    }

    // Fallback: pick first token with letters+digits near invoice label.
    const invoiceLabelIndex = normalizedText.toLowerCase().search(/invoice|inv\b/);
    if (invoiceLabelIndex >= 0) {
        const tail = normalizedText.slice(invoiceLabelIndex, invoiceLabelIndex + 120);
        const tokenMatch = tail.match(/([A-Z]{1,6}[\/-]?[0-9][A-Z0-9\/-]{2,20}|[0-9]{2,}[A-Z][A-Z0-9\/-]{1,20})/i);
        if (tokenMatch) return tokenMatch[1].toUpperCase();
    }

    return '';
};

const extractAmount = (text, lineItems = []) => {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
        if (!/(?:grand\s*total|net\s*payable|amount\s*payable|invoice\s*value|final\s*amount|total\s*amount)/i.test(line)) {
            continue;
        }

        const amountMatch = line.match(/(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?[0-9]{0,2})\s*$/i)
            || line.match(/(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?[0-9]{0,2})/i);
        if (amountMatch?.[1]) {
            return amountMatch[1].replace(/,/g, '');
        }
    }

    const labeledFromLines = extractLabeledValue(
        text,
        'grand\\s*total|net\\s*payable|final\\s*amount|invoice\\s*value|total\\s*amount',
        '(?:₹|rs\\.?|inr)?\\s*([0-9][0-9,]*\\.?[0-9]{0,2})'
    );
    if (labeledFromLines) {
        return labeledFromLines.replace(/,/g, '');
    }

    const labeledPatterns = [
        { regex: /(?:grand\s*total|net\s*payable|amount\s*payable|invoice\s*value|final\s*amount)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?[0-9]{0,2})/gi, priority: 5 },
        { regex: /(?:total\s*amount|gross\s*amount|net\s*amount)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?[0-9]{0,2})/gi, priority: 4 },
        { regex: /(?:total|amount|payable|balance\s*due)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?[0-9]{0,2})/gi, priority: 3 },
        { regex: /(?:₹|rs\.?|inr)\s*([0-9][0-9,]*\.?[0-9]{0,2})/gi, priority: 2 }
    ];

    const parseAmount = (raw) => {
        const clean = (raw || '').replace(/,/g, '').trim();
        const num = Number.parseFloat(clean);
        if (Number.isNaN(num)) return null;
        if (num <= 0 || num > 1000000000) return null;
        return { num, text: clean };
    };

    const candidates = [];
    labeledPatterns.forEach(({ regex, priority }) => {
        const matches = normalizedText.matchAll(regex);
        for (const match of matches) {
            const parsed = parseAmount(match[1]);
            if (!parsed) continue;
            if (parsed.num < 10) continue;
            candidates.push({ ...parsed, priority });
        }
    });

    if (candidates.length > 0) {
        candidates.sort((a, b) => (b.priority - a.priority) || (b.num - a.num));
        return candidates[0].text;
    }

    // Final fallback: highest currency-looking number.
    const fallbackMatches = normalizedText.matchAll(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]{3,}(?:\.[0-9]{1,2})|[0-9]+\.[0-9]{2})\b/g);
    const fallback = [];
    for (const match of fallbackMatches) {
        const parsed = parseAmount(match[1]);
        if (!parsed) continue;
        if (parsed.num < 10) continue;
        fallback.push(parsed);
    }

    if (fallback.length === 0) return '';
    fallback.sort((a, b) => b.num - a.num);
    let bestAmount = fallback[0].text;

    // Extra fallback: if table line items exist, prefer the largest parsed row amount when stronger.
    if (Array.isArray(lineItems) && lineItems.length > 0) {
        const lineAmounts = [];
        lineItems.forEach((row) => {
            if (!row || typeof row !== 'object') return;
            Object.entries(row).forEach(([key, value]) => {
                const keyNorm = String(key).toLowerCase();
                if (!keyNorm.includes('amount') && !keyNorm.includes('total')) return;
                const parsed = Number.parseFloat(String(value || '').replace(/,/g, '').replace(/[^0-9.]/g, ''));
                if (!Number.isNaN(parsed) && parsed > 10) {
                    lineAmounts.push(parsed);
                }
            });
        });

        if (lineAmounts.length > 0) {
            const maxLineAmount = Math.max(...lineAmounts);
            const current = Number.parseFloat(bestAmount);
            if (Number.isNaN(current) || maxLineAmount > current) {
                bestAmount = String(maxLineAmount);
            }
        }
    }

    return bestAmount;
};

const extractPONumber = (text) => {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
        if (!/(?:purchase\s*order|\bp\.?\s*o\.?\b|\bpo\b)\s*(?:no\.?|number|#)?/i.test(line)) {
            continue;
        }

        let candidate = line
            .replace(/.*?(?:purchase\s*order|\bp\.?\s*o\.?\b|\bpo\b)\s*(?:no\.?|number|#)?\s*[:\-]?\s*/i, '')
            .replace(/\b(?:date|dated|gstin|invoice|inv\b|amount|value)\b.*$/i, '')
            .trim();

        if (candidate) {
            candidate = candidate.replace(/[^A-Za-z0-9/\-]/g, '').trim();
            if (candidate.length >= 4 && /\d/.test(candidate)) {
                return candidate.toUpperCase();
            }
        }
    }

    const labeledFromLines = extractLabeledValue(
        text,
        'po|p\\.o\\.|purchase\\s*order',
        '(?:no\\.?|number|#)?\\s*[:\\-]?\\s*([A-Z0-9][A-Z0-9/-]{2,30})'
    );
    if (labeledFromLines && /\d/.test(labeledFromLines)) {
        return labeledFromLines.toUpperCase();
    }

    const patterns = [
        /(?:po|p\.o\.|purchase\s*order)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/-]{2,30})/i,
        /\bPO\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/-]{2,30})\b/i,
        /\bP\/O\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/-]{2,30})\b/i,
    ];

    for (const pattern of patterns) {
        const match = normalizedText.match(pattern);
        if (match && match[1].length >= 4) {
            const val = match[1].trim().toUpperCase();
            if (/[0-9]/.test(val)) return val;
        }
    }

    // Fallback: PO-like token after PO marker.
    const markerIndex = normalizedText.toLowerCase().search(/\bpo\b|purchase\s*order|p\.o\./);
    if (markerIndex >= 0) {
        const tail = normalizedText.slice(markerIndex, markerIndex + 100);
        const token = tail.match(/([A-Z0-9]{2,}[\/-][A-Z0-9\/-]{1,20}|[A-Z]{1,5}[0-9]{2,}[A-Z0-9\/-]{0,20})/i);
        if (token) return token[1].toUpperCase();
    }

    return '';
};

const extractDate = (text) => {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const labeledFromLines = extractLabeledValue(
        text,
        'invoice\\s*date|bill\\s*date|date\\s*of\\s*invoice|dated',
        '(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}\\s*[-/.]?\\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s*[-/.]?\\s*\\d{2,4})'
    );
    const patterns = [
        /(?:invoice\s*date|bill\s*date|dated|date\s*of\s*invoice)\s*[:\-]?\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i,
        /(?:invoice\s*date|bill\s*date|dated|date\s*of\s*invoice)\s*[:\-]?\s*(\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2})/i,
        /(?:invoice\s*date|bill\s*date|dated|date\s*of\s*invoice)\s*[:\-]?\s*(\d{1,2}\s*[-\/.]?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*[-\/.]?\s*\d{2,4})/i,
        /(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{4})/,
        /(\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2})/,
        /(\d{1,2}\s*[-\/.]?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*[-\/.]?\s*\d{2,4})/i,
        /(\d{1,2}[-\/\.][A-Za-z]{3,}[-\/\.]\d{2,4})/i,
    ];

    const toIsoDate = (value) => {
        const raw = (value || '').trim();
        if (!raw) return '';

        // Reject invoice-number-like values (for example: 0343/25-26).
        if (/^\d{3,5}[-/]\d{2}[-/]\d{2}$/.test(raw)) {
            return '';
        }

        // dd/mm/yyyy or dd-mm-yyyy or dd.mm.yyyy
        const dmy = raw.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{2,4})$/);
        if (dmy) {
            let year = Number.parseInt(dmy[3], 10);
            if (year < 100) year += 2000;
            const month = Number.parseInt(dmy[2], 10);
            const day = Number.parseInt(dmy[1], 10);
            if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return '';
            const dt = new Date(Date.UTC(year, month - 1, day));
            if (!Number.isNaN(dt.getTime())) return dt.toISOString().split('T')[0];
        }

        // yyyy/mm/dd
        const ymd = raw.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})$/);
        if (ymd) {
            const year = Number.parseInt(ymd[1], 10);
            const month = Number.parseInt(ymd[2], 10);
            const day = Number.parseInt(ymd[3], 10);
            if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return '';
            const dt = new Date(Date.UTC(year, month - 1, day));
            if (!Number.isNaN(dt.getTime())) return dt.toISOString().split('T')[0];
        }

        // Support formats like 5-Mar-26, 5 Mar 2026.
        const monthNamed = raw.match(/^(\d{1,2})\s*[-\/.]?\s*([A-Za-z]{3,})\s*[-\/.]?\s*(\d{2,4})$/);
        if (monthNamed) {
            const monthMap = {
                jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
            };
            const day = Number.parseInt(monthNamed[1], 10);
            const monthName = monthNamed[2].slice(0, 3).toLowerCase();
            let year = Number.parseInt(monthNamed[3], 10);
            if (year < 100) year += 2000;
            const month = monthMap[monthName];

            if (month !== undefined && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
                const dt = new Date(Date.UTC(year, month, day));
                if (!Number.isNaN(dt.getTime())) return dt.toISOString().split('T')[0];
            }
        }

        const generic = new Date(raw);
        if (!Number.isNaN(generic.getTime())) return generic.toISOString().split('T')[0];
        return '';
    };

    for (const line of lines) {
        if (!/(?:invoice\s*date|bill\s*date|dated|date\s*of\s*invoice)/i.test(line)) continue;
        const dateToken = line.match(/(\d{1,2}\s*[-\/.]?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*[-\/.]?\s*\d{2,4}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}|\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/i);
        if (dateToken?.[1]) {
            const iso = toIsoDate(dateToken[1]);
            if (iso) return iso;
        }
    }

    if (labeledFromLines) {
        const iso = toIsoDate(labeledFromLines);
        if (iso) return iso;
    }

    for (const pattern of patterns) {
        const match = normalizedText.match(pattern);
        if (match) {
            const iso = toIsoDate(match[1]);
            if (iso) return iso;
        }
    }
    return '';
};
