
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); // Moved inside function
import Tesseract from 'tesseract.js';

// Ensure generic font data is loaded if needed (usually handled by legacy build)

export class TableExtractor {
    constructor() {
        this.headerKeywords = ['description', 'particulars', 'item', 'product', 'qty', 'quantity', 'rate', 'unit', 'price', 'amount', 'total', 'sr', 'no', 'hsn', 'sac', 'value', 'net', 'gross', 'sum', 'charge', 'material'];
        this.stopKeywords = ['total', 'subtotal', 'amount in words', 'tax', 'vat', 'gst', 'grand total'];
    }

    async extractTableFromImage(imagePath) {
        const result = await Tesseract.recognize(imagePath, 'eng');
        // Tesseract provides lines -> words.
        // We can flatten all words into items.
        const items = [];

        result.data.lines.forEach(line => {
            line.words.forEach(word => {
                if (word.text.trim().length > 0) {
                    items.push({
                        text: word.text,
                        x: word.bbox.x0,
                        y: word.bbox.y0, // Top-down
                        w: word.bbox.x1 - word.bbox.x0,
                        h: word.bbox.y1 - word.bbox.y0
                    });
                }
            });
        });

        // Tesseract layout analysis is already line-based, but our analyzeTable re-groups them.
        // We can trust our re-grouper or use Tesseract lines. 
        // Our re-grouper is safer if columns are tight.
        const lines = this.groupLines(items);
        const table = this.analyzeTable(lines);

        return {
            text: result.data.text,
            lineItems: table || []
        };
    }

    async extractTableFromPdf(pdfPath) {
        if (!fs.existsSync(pdfPath)) {
            throw new Error(`File not found: ${pdfPath}`);
        }

        // Lazy load pdfjs-dist to avoid canvas dependency crash unless used
        const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

        const dataBuffer = fs.readFileSync(pdfPath);
        const data = new Uint8Array(dataBuffer);

        // useSystemFonts=true suppresses standard font fetch warnings in Node.js
        // (pdfjs legacy can't load font files via file:// in Node context)
        const loadingTask = pdfjsLib.getDocument({ data, useSystemFonts: true });
        const doc = await loadingTask.promise;
        const pageCount = doc.numPages;

        // Results
        let fullText = '';
        let allItems = [];
        let accumulatedHeight = 0;

        // Process all pages to ensure we catch line items that span multiple pages
        // or totals that appear on the last page.
        for (let i = 1; i <= pageCount; i++) {
            const page = await doc.getPage(i);
            const viewport = page.getViewport({ scale: 1.0 });
            const content = await page.getTextContent();

            const items = this.standardizeItems(content.items, viewport.height);
            
            // Offset Y coordinates so lines from subsequent pages appear sequentially below
            items.forEach(it => {
                it.y += accumulatedHeight;
            });

            allItems = allItems.concat(items);
            fullText += items.map(it => it.text).join(' ');
            
            accumulatedHeight += viewport.height;
        }

        let tableData = [];
        if (allItems.length > 0) {
            const lines = this.groupLines(allItems);
            const table = this.analyzeTable(lines);
            if (table) {
                tableData = table;
            }
        }

        return {
            text: fullText,
            lineItems: tableData
        };
    }

    standardizeItems(items, pageHeight) {
        return items.map(item => {
            // item.transform is [scaleX, skewY, skewX, scaleY, tx, ty]
            const tx = item.transform[4];
            const ty = item.transform[5];

            return {
                text: item.str,
                x: tx,
                y: pageHeight - ty, // Top-down Y
                w: item.width,
                h: item.height || item.transform[3] // height might be in transform scaleY
            };
        }).filter(it => it.text.trim().length > 0);
    }

    groupLines(items) {
        // Sort by Y asc, then X asc
        items.sort((a, b) => {
            if (Math.abs(a.y - b.y) < 5) return a.x - b.x;
            return a.y - b.y;
        });

        const lines = [];
        let currentLine = { y: -1, items: [] };

        items.forEach(item => {
            // If first item or within vertical tolerance of current line
            if (currentLine.y === -1 || Math.abs(item.y - currentLine.y) < 6) {
                if (currentLine.y === -1) currentLine.y = item.y;
                currentLine.items.push(item);
            } else {
                lines.push(currentLine);
                currentLine = { y: item.y, items: [item] };
            }
        });
        if (currentLine.items.length > 0) lines.push(currentLine);
        return lines;
    }

    analyzeTable(lines) {
        // 1. Find Header Row
        let headerRowIndex = -1;

        for (let i = 0; i < lines.length; i++) {
            const lineText = lines[i].items.map(it => it.text).join(' ').toLowerCase();
            let matchCount = 0;
            this.headerKeywords.forEach(kw => {
                if (lineText.includes(kw)) matchCount++;
            });
            // If we find at least 2 keywords, assume it's the header
            if (matchCount >= 2) {
                headerRowIndex = i;
                break;
            }
        }

        if (headerRowIndex === -1) return null; // No table found

        const headerLine = lines[headerRowIndex];
        console.log('Found Header Row:', headerLine.items.map(it => it.text).join('|'));

        // 2. Define Columns based on Headers
        // We'll define simple ranges based on header item X coordinates
        // This is a naive approach; robust approach uses gaps.
        const columns = headerLine.items.map(item => ({
            name: item.text,
            xStart: item.x,
            xEnd: item.x + item.w,
            center: item.x + (item.w / 2)
        }));

        // 3. Extract Rows
        const extractedRows = [];

        // Start from next line
        for (let i = headerRowIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            const lineText = line.items.map(it => it.text).join(' ').toLowerCase();

            // Check for stop keywords (footer starts)
            if (this.stopKeywords.some(kw => lineText.includes(kw))) {
                break;
            }

            // Map items to closest column
            const rowData = { _y: line.y };

            line.items.forEach(item => {
                const itemCenter = item.x + (item.w / 2);

                // Find column with closest center or overlapping x
                // Simple distance to center check
                let bestCol = null;
                let minDist = Infinity;

                columns.forEach(col => {
                    // Check horizontal overlap? Or just distance.
                    // Distance is safer for aligned columns.
                    const dist = Math.abs(itemCenter - col.center);
                    if (dist < minDist) {
                        minDist = dist;
                        bestCol = col;
                    }
                });

                if (bestCol) {
                    // Normalize column key
                    const key = this.normalizeKey(bestCol.name);
                    if (rowData[key]) rowData[key] += ' ' + item.text;
                    else rowData[key] = item.text;
                }
            });

            // Process row data before adding
            // FIX: srNo sometimes absorbs the description text due to column X-position
            // mismatch between header and content. Split '1 WORKSTATION ON RENT' into
            // srNo='1' and description='WORKSTATION ON RENT'.
            if (rowData.srNo) {
                const srNoStr = rowData.srNo.trim();
                const mixedMatch = srNoStr.match(/^(\d+)\s+([^\d].*)$/s);
                if (mixedMatch) {
                    rowData.srNo = mixedMatch[1];          // just the number
                    if (!rowData.description) {
                        rowData.description = mixedMatch[2].trim(); // the rest is the description
                    }
                } else if (!/^\d+$/.test(srNoStr)) {
                    // srNo has non-digit text but no leading digit (e.g. 'No') - clear it
                    delete rowData.srNo;
                }
            }

            const hasData = Object.keys(rowData).filter(k => k !== '_y').length > 0;
            if (hasData) {
                if (rowData.description) {
                    rowData.description = rowData.description.replace(/(?:serial|s\/n|sl\s*no)[\s\S]*$/gi, '').trim();
                }
                // Push any row that has desc or amount
                if (rowData.description || rowData.amount || rowData.quantity || rowData.unitPrice) {
                    console.log('[TABLE-EXTRACT] Raw row:', JSON.stringify(rowData));
                    extractedRows.push(rowData);
                }
            }
        }

        /**
         * Post-process: merge orphan description rows into their correct main rows.
         *
         * Strategy:
         *  - A row with srNo (serial number column) marks the START of a new item.
         *    Its description text is buffered as a "pending" prefix.
         *  - A row with numbers (amount/qty/rate) is a MAIN row. Any pending
         *    descriptions are prepended to it.
         *  - A description-only row with NO srNo and AFTER a main row is a
         *    continuation of that main row (e.g. sub-description or wrapped text).
         *    UNLESS pending buffer is non-empty (meaning we're between items).
         */
        const finalRows = [];
        let pendingDescs = [];  // Text lines waiting to be attached to next main row
        let afterMainRow = false; // Whether we've seen at least one main row

        for (const row of extractedRows) {
            // 'Sr No' PDF column may be split into 'sr'→srNo and 'no'→no keys.
            // Accept either as a serial number signal.
            const hasSrNo = (row.srNo && /^\d+$/.test((row.srNo || '').trim())) ||
                            (row.no   && /^\d+$/.test((row.no   || '').trim()));
            // hasNumbers: only count a field as numeric if it actually contains a digit
            const isNumericField = (v) => v && /[0-9]/.test(v);
            const hasNumbers = isNumericField(row.amount) || isNumericField(row.quantity) || isNumericField(row.unitPrice);
            const desc = (row.description || '').trim();
            const hasDesc = desc && desc !== '-';

            if (hasSrNo && !hasNumbers) {
                // Definitive start of a new item (e.g. "1 | WORKSTATION ON RENT | 997315 | 18% |")
                // Flush any leftover pending into last row (shouldn't happen in normal cases)
                if (pendingDescs.length > 0 && finalRows.length > 0) {
                    const last = finalRows[finalRows.length - 1];
                    last.description = [last.description || '', ...pendingDescs].filter(Boolean).join(' ');
                }
                pendingDescs = hasDesc ? [desc] : [];
                afterMainRow = false; // Reset: we're now starting a new item
            } else if (hasNumbers) {
                // Main data row – commit it
                let rowDesc = desc !== '-' ? desc : '';
                if (pendingDescs.length > 0) {
                    rowDesc = pendingDescs.join(' ') + (rowDesc ? ' ' + rowDesc : '');
                    pendingDescs = [];
                }
                row.description = rowDesc;
                finalRows.push(row);
                afterMainRow = true;
            } else if (hasDesc) {
                // A description-only row (no Sr No, no numbers).
                // Decide: is this the START of a new item, or a continuation of the previous item?
                
                const tableHasSrNo = extractedRows.some(r => (r.srNo && /^\d+$/.test((r.srNo || '').trim())) || (r.no && /^\d+$/.test((r.no || '').trim())));
                
                let isContinuation = false;
                if (tableHasSrNo) {
                    // If the table uses Sr No, a new item ALWAYS has a Sr No.
                    // So ANY description-only row without a Sr No is a continuation of the current item.
                    isContinuation = afterMainRow && pendingDescs.length === 0;
                } else {
                    // Heuristic fallback for tables without Sr No
                    const firstChar = desc.charAt(0);
                    const looksLikeNewItem = firstChar === firstChar.toUpperCase() && firstChar !== '(' && /[A-Z]/.test(firstChar);
                    isContinuation = afterMainRow && pendingDescs.length === 0 && !looksLikeNewItem;
                }

                if (isContinuation) {
                    // Continuation of the most recent main row
                    finalRows[finalRows.length - 1].description =
                        (finalRows[finalRows.length - 1].description || '') + '\n' + desc;
                } else {
                    // Either before first main row, or looks like a new item name → buffer it
                    pendingDescs.push(desc);
                }
            }
        }

        // Flush any remaining pending descriptions to the last main row
        if (pendingDescs.length > 0 && finalRows.length > 0) {
            const last = finalRows[finalRows.length - 1];
            last.description = [last.description || '', ...pendingDescs].filter(Boolean).join(' ');
        }

        // Clean up internal keys and trim descriptions
        finalRows.forEach(row => {
            delete row._y;
            delete row.srNo;
            if (row.description) {
                // Remove parenthetical sub-descriptions like "(DETAILS AS PER ANNEXURE SHEET)"
                // These are comments in the PDF, not the actual item name
                row.description = row.description
                    .replace(/\s*\(DETAILS\s+AS\s+PER[^)]*\)/gi, '')
                    .replace(/\s*\(AS\s+PER[^)]*\)/gi, '')
                    .replace(/\s*Duration\s*[-:][^\n]*/gi, '')
                    .trim();
                // If description is now empty (was only parenthetical), try restoring from srNo description context
                // (this won't happen in practice since srNo rows always have desc)
            }
        });

        // Identify Summary/Total rows that OCR accidentally captured as regular items
        if (finalRows.length > 1) {
            const lastRow = finalRows[finalRows.length - 1];
            const hasQty = lastRow.quantity && lastRow.quantity.trim() !== '-' && lastRow.quantity.trim() !== '';
            const hasRate = lastRow.unitPrice && lastRow.unitPrice.trim() !== '-' && lastRow.unitPrice.trim() !== '';
            
            if (!hasQty && !hasRate && lastRow.amount) {
                const descLower = (lastRow.description || '').toLowerCase();
                if (descLower.includes('description of goods') || descLower.includes('total') || descLower.includes('amount') || descLower === '') {
                    lastRow.description = 'Total Amount';
                    lastRow.isSummary = true;
                }
            }
        }

        console.log('[TABLE-EXTRACT] Final rows:', JSON.stringify(finalRows));
        return finalRows;
    }

    normalizeKey(headerText) {
        const raw = (headerText || '').trim();
        // Handle pure-symbol headers BEFORE stripping — they become empty after replace otherwise
        if (raw === '#' || raw === 'S#' || raw === 'Sr.' || raw === 'S.No.' || raw === 'No.') return 'srNo';
        if (raw === '%') return 'taxRate';

        const text = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Empty after stripping (e.g. '#', '%') — treat as srNo as a safe fallback
        if (text === '') return 'srNo';
        // Tax columns — must check before generic 'amount' since CGST/SGST amount also contains 'amount'
        if (text.includes('cgst') || text.includes('sgst') || text.includes('igst') || text.includes('tax')) {
            if (text.includes('amt') || text.includes('amount')) return 'taxAmount';
            if (text.includes('rate') || text.includes('perc') || text === 'taxrate') return 'taxRate';
            return 'taxColumn';
        }
        // 'Amt' alone (short column in Hornbill/Tally invoices) is the tax sub-total, NOT the grand total
        if (text === 'amt') return 'taxAmount';
        // Serial number column
        if (text === 's' || text === 'no' || text.includes('sr') || text.includes('slno') || text.includes('sno') || text.includes('serial')) return 'srNo';
        // Description
        if (text.includes('desc') || text.includes('good') || text.includes('service') || text.includes('particular') || text.includes('item') || text.includes('material') || text.includes('detail')) return 'description';
        // HSN
        if (text.includes('hsn') || text.includes('sac')) return 'hsn';
        // Quantity
        if (text.includes('qty') || text.includes('quan') || text.includes('weight') || text === 'q') return 'quantity';
        // UoM
        if (text.includes('uom') || (text.includes('unit') && !text.includes('price') && !text.includes('cost') && !text.includes('rate'))) return 'uom';
        // Rate
        if (text.includes('rate') || text.includes('price') || text.includes('cost') || text.includes('charge')) return 'unitPrice';
        // Taxable Value — pre-tax amount, separate from final total Amount
        if (text.includes('taxable') || text === 'taxablevalue' || text === 'taxableamt') return 'taxableValue';
        // Amount/Total column — actual total (with tax)
        if (text.includes('amount') || text.includes('total') || text.includes('value') || text.includes('sum') || text.includes('net') || text.includes('gross')) return 'amount';
        return text;  // keep original key for anything else
    }
}
