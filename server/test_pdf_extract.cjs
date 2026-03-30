const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function extractTextWithCoordinates(pdfPath) {
    if (!fs.existsSync(pdfPath)) {
        console.error(`File not found: ${pdfPath}`);
        return;
    }

    const dataBuffer = fs.readFileSync(pdfPath);
    const data = new Uint8Array(dataBuffer);

    try {
        const loadingTask = pdfjsLib.getDocument({ data });
        const doc = await loadingTask.promise;
        console.log(`PDF loaded. Pages: ${doc.numPages}`);

        for (let i = 1; i <= doc.numPages; i++) {
            console.log(`\n--- Page ${i} ---`);
            const page = await doc.getPage(i);
            const viewport = page.getViewport({ scale: 1.0 });
            console.log(`Size: ${viewport.width}x${viewport.height}`);


            const content = await page.getTextContent();
            console.log('Raw content items:', content.items.length);
            if (content.items.length > 0) {
                console.log('First item:', JSON.stringify(content.items[0]));
            }

            // Standardize items
            const items = content.items.map(item => {
                const tx = item.transform[4];
                const ty = item.transform[5];
                // PDF coords: 0,0 is bottom-left. We convert to top-left.
                const y_top_down = viewport.height - ty;

                return {
                    text: item.str,
                    x: tx,
                    y: y_top_down,
                    w: item.width,
                    h: item.height,
                };
            });

            // Filter out empty strings
            const nonEmptyItems = items.filter(it => it.text.trim().length > 0);

            console.log('Sample Extracted Items (Text @ [x, y]):');
            nonEmptyItems.slice(0, 20).forEach(it => {
                console.log(`"${it.text}" @ [${it.x.toFixed(2)}, ${it.y.toFixed(2)}]`);
            });

            console.log('\n--- Line Grouping Preview ---');
            const lines = groupTextIntoLines(nonEmptyItems);
            lines.slice(0, 15).forEach(line => {
                const lineText = line.items.map(it => it.text).join(' '); // Simple join
                console.log(`Y=${line.y.toFixed(0)}: ${lineText}`);
            });

            // Try to detect headers
            detectHeaders(lines);
        }
    } catch (err) {
        console.error('Error parsing PDF:', err);
    }
}

function groupTextIntoLines(items) {
    // Sort by Y (top down), then X
    items.sort((a, b) => {
        if (Math.abs(a.y - b.y) < 5) return a.x - b.x;
        return a.y - b.y;
    });

    const lines = [];
    let currentLine = { y: -1, items: [] };

    items.forEach(item => {
        if (currentLine.y === -1 || Math.abs(item.y - currentLine.y) < 5) { // 5px tolerance
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

function detectHeaders(lines) {
    console.log('\n--- Potential Table Headers ---');
    const headerKeywords = ['description', 'particulars', 'qty', 'quantity', 'rate', 'unit', 'amount', 'total'];

    lines.forEach((line, idx) => {
        const fullText = line.items.map(it => it.text).join(' ').toLowerCase();
        let matchCount = 0;
        headerKeywords.forEach(k => {
            if (fullText.includes(k)) matchCount++;
        });

        if (matchCount >= 2) {
            console.log(`[Possible Header Line] Y=${line.y.toFixed(0)}: ${line.items.map(it => it.text).join(' | ')}`);
        }
    });
}


const targetFile = process.argv[2] || path.join(__dirname, '../uploads/1768989199565-330266426.pdf');
console.log(`Testing with: ${targetFile}`);
extractTextWithCoordinates(targetFile);
