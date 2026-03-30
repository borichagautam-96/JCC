const fs = require('fs');
const path = require('path');
// distinct import for node environment vs browser
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

            // Standardize items
            const items = content.items.map(item => {
                // transform is [scaleX, skewY, skewX, scaleY, tx, ty]
                // ty is usually 0 at bottom, increasing upwards (PDF coordinates)
                // We might want to convert to top-down coordinates
                const tx = item.transform[4];
                const ty = item.transform[5];

                // Convert to top-down Y (0 at top)
                const y_top_down = viewport.height - ty;

                return {
                    text: item.str,
                    x: tx,
                    y: y_top_down, // Use top-down for easier visualization
                    w: item.width,
                    h: item.height,
                    // fontHeight: item.transform[3] or item.height
                };
            });

            // Filter out empty strings
            const nonEmptyItems = items.filter(it => it.text.trim().length > 0);

            // Log first 20 items to verify
            console.log('Sample Extracted Items (Text @ [x, y]):');
            nonEmptyItems.slice(0, 20).forEach(it => {
                console.log(`"${it.text}" @ [${it.x.toFixed(2)}, ${it.y.toFixed(2)}]`);
            });

            // Group by lines (simple heuristic)
            console.log('\n--- Line Grouping Preview ---');
            const lines = groupTextIntoLines(nonEmptyItems);
            lines.slice(0, 10).forEach(line => {
                const lineText = line.items.map(it => it.text).join(' ');
                console.log(`Y=${line.y.toFixed(0)}: ${lineText}`);
            });
        }
    } catch (err) {
        console.error('Error parsing PDF:', err);
    }
}

function groupTextIntoLines(items) {
    // Sort by Y (top down), then X
    items.sort((a, b) => {
        if (Math.abs(a.y - b.y) < 5) return a.x - b.x; // Same line tolerance 5px
        return a.y - b.y;
    });

    const lines = [];
    let currentLine = { y: -1, items: [] };

    items.forEach(item => {
        if (currentLine.y === -1 || Math.abs(item.y - currentLine.y) < 5) {
            // Add to current line
            if (currentLine.y === -1) currentLine.y = item.y;
            currentLine.items.push(item);
        } else {
            // Start new line
            lines.push(currentLine);
            currentLine = { y: item.y, items: [item] };
        }
    });
    if (currentLine.items.length > 0) lines.push(currentLine);

    return lines;
}

// Run the test
const samplePdf = path.join(__dirname, '../uploads/1768989199565-330266426.pdf');
console.log(`Testing with: ${samplePdf}`);
extractTextWithCoordinates(samplePdf);
