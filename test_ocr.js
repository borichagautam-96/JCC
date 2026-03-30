// Test script for OCR extraction debugging
// Run this to test extraction on a specific file

import { processInvoice } from './src/utils/ocrProcessor.js';
import fs from 'fs';

async function testExtraction() {
    console.log('=== OCR EXTRACTION TEST ===\n');

    const testFilePath = process.argv[2];

    if (!testFilePath) {
        console.error('Usage: node test_ocr.js <path-to-pdf-or-image>');
        process.exit(1);
    }

    if (!fs.existsSync(testFilePath)) {
        console.error('File not found:', testFilePath);
        process.exit(1);
    }

    console.log('Test file:', testFilePath);
    console.log('Reading file...\n');

    const fileBuffer = fs.readFileSync(testFilePath);
    const file = new File([fileBuffer], testFilePath.split('/').pop(), {
        type: testFilePath.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'
    });

    console.log('File size:', file.size, 'bytes');
    console.log('File type:', file.type);
    console.log('\nStarting extraction...\n');

    try {
        const result = await processInvoice(file);

        console.log('\n=== EXTRACTION RESULTS ===');
        console.log(JSON.stringify(result, null, 2));
        console.log('\n=== TEST COMPLETE ===');
    } catch (error) {
        console.error('\n=== EXTRACTION FAILED ===');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
    }
}

testExtraction();
