const fs = require('fs');
const pdf = require('pdf-parse');
const path = require('path');

async function testPdfParse(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error('File not found:', filePath);
        return;
    }
    const dataBuffer = fs.readFileSync(filePath);

    try {
        console.log('Require pdf-parse result type:', typeof pdf);
        let parseFunc = pdf;
        if (typeof pdf !== 'function') {
            if (pdf.default) parseFunc = pdf.default;
            else console.log('pdf-parse export structure:', pdf);
        }

        if (typeof parseFunc === 'function') {
            const data = await parseFunc(dataBuffer);
            console.log(`\nFile: ${path.basename(filePath)}`);
            console.log(`Pages: ${data.numpages}`);
            console.log(`Text Length: ${data.text.length}`);
            if (data.text.length > 50) {
                console.log(`Sample Text: ${data.text.substring(0, 100).replace(/\n/g, ' ')}...`);
            } else {
                console.log('Text is very short (possible image scan).');
            }
        } else {
            console.error('Could not find PDF parse function');
        }
    } catch (e) {
        console.error('Error:', e);
    }
}

const targetFile = process.argv[2] || path.join(__dirname, '../uploads/1768989199565-330266426.pdf');
testPdfParse(targetFile);
