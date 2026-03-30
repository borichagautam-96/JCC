import { TableExtractor } from './utils/tableExtractor.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const extractor = new TableExtractor();
const pdfPath = process.argv[2] || path.join(__dirname, 'temp', 'test_invoice.pdf');

console.log(`Extracting from: ${pdfPath}`);

extractor.extractTableFromPdf(pdfPath)
    .then(result => {
        console.log('Full Text Preview:', result.text.substring(0, 100));
        console.log('Extracted Line Items:', JSON.stringify(result.lineItems, null, 2));
    })
    .catch(err => console.error(err));
