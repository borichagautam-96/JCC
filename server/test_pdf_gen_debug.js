
import { generateJCCPDF } from './utils/pdfGenerator.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testData = {
    id: 22,
    voucher_number: 'PEW0000022',
    claimed_by: 'Shaikh Mohd Faizaan Haseen',
    ps_number: '12345',
    department: 'DOCUMENTATION & TRAINING',
    claimed_date: '2026-01-22',
    expense_booking_location: 'POWAI',
    actions: [
        {
            person: 'Manager A',
            psno: '-',
            action: 'APPROVED',
            date: '2026-01-22'
        }
    ],
    invoice_no: 'INV-00255',
    invoice_date: '2026-01-22',
    nature_of_expenses: 'Services',
    service_category: 'N/A',
    description: 'Payment for LIMITED',
    supplier: 'LIMITED',
    supplier_code: '-',
    supplier_name: 'LIMITED',
    supplier_address: '-',
    business_partner_type: 'OTHERS',
    basic_amount: 111111.00,
    gross_amount: 111111.00,
    project_code: 'S068015A',
    project_name: 'Test Project',
    items: [
        {
            ledger: '4074006 WIP - OTHERS',
            loc: 'PEW',
            eu: '06',
            dept: 'DOCUMENTATION & TRAINING',
            project: 'S068015A',
            amount: 111111.00
        }
    ]
};

const pdfPath = path.join(__dirname, 'test_jcc_22.pdf');

console.log('Testing PDF generation...');
try {
    await generateJCCPDF(testData, pdfPath);
    console.log('PDF generated successfully at:', pdfPath);
    if (fs.existsSync(pdfPath)) {
        console.log('File size:', fs.statSync(pdfPath).size);
        // fs.unlinkSync(pdfPath);
    }
} catch (error) {
    console.error('PDF Generation Failed:', error);
}
