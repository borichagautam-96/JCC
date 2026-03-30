import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import fs from 'fs';
import path from 'path';

const doc = new jsPDF();

// Handle ESM import mess
const autoTableFunc = autoTable.default || autoTable;

doc.text("Invoice #12345", 10, 10);
doc.text("Date: 2026-01-22", 10, 20);

autoTableFunc(doc, {
    startY: 30,
    head: [['Description', 'Quantity', 'Unit Price', 'Amount']],
    body: [
        ['Consulting Services', '10', '150.00', '1500.00'],
        ['Software Development', '50', '100.00', '5000.00'],
        ['Server Setup', '1', '500.00', '500.00'],
    ],
});

doc.text("Subtotal: 7000.00", 140, 100);
doc.text("Total: 7000.00", 140, 110);

const outputPath = path.join('server', 'temp', 'test_invoice.pdf');
const data = doc.output(); // as string? or arraybuffer?
// jsPDF output in node is tricky. use output('arraybuffer')
const buffer = doc.output('arraybuffer');

fs.writeFileSync(outputPath, Buffer.from(buffer));
console.log(`Created ${outputPath}`);
