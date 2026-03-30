
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); // Moved inside function
import Tesseract from 'tesseract.js';

// Ensure generic font data is loaded if needed (usually handled by legacy build)

export class TableExtractor {
    constructor() {
        this.headerKeywords = ['description', 'particulars', 'item', 'product', 'qty', 'quantity', 'rate', 'unit', 'price', 'amount', 'total'];
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

        const loadingTask = pdfjsLib.getDocument({ data });
        const doc = await loadingTask.promise;
        const pageCount = doc.numPages;

        // Results
        let fullText = '';
        let tableData = [];

        // We only process the first page for the table mostly, or iterate all if needed.
        // For now, let's look at Page 1 where the main invoice table usually starts.
        for (let i = 1; i <= Math.min(pageCount, 1); i++) {
            const page = await doc.getPage(i);
            const viewport = page.getViewport({ scale: 1.0 });
            const content = await page.getTextContent();

            const items = this.standardizeItems(content.items, viewport.height);
            fullText += items.map(it => it.text).join(' ');

            if (items.length > 0) {
                const lines = this.groupLines(items);
                const table = this.analyzeTable(lines);
                if (table) {
                    tableData = table;
                }
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
            const rowData = {};

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

            // Only add row if it has meaningful data (e.g. description or amount)
            if (Object.keys(rowData).length > 0) {
                extractedRows.push(rowData);
            }
        }

        return extractedRows;
    }

    normalizeKey(headerText) {
        const text = headerText.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (text.includes('desc')) return 'description';
        if (text.includes('qty') || text.includes('quan')) return 'quantity';
        if (text.includes('rate') || text.includes('price') || text.includes('unit')) return 'unitPrice';
        if (text.includes('amount') || text.includes('total')) return 'amount';
        return text;
    }
}
