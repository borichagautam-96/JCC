
import db from './database.js';
import { generateJCCPDF } from './utils/pdfGenerator.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testRouteLogic() {
    try {
        const voucherId = 21;
        console.log(`Fetching voucher ${voucherId}...`);

        // Get voucher with user details
        const voucher = db.prepare(`
      SELECT v.*, u.name as user_name, u.ps_number as creator_ps_number
      FROM voucher_requests v
      JOIN users u ON v.user_id = u.id
      WHERE v.id = ?
    `).get(voucherId);

        if (!voucher) {
            console.error('Voucher not found');
            return;
        }

        console.log('Voucher data found.');

        // Prepare PDF data
        const pdfData = {
            id: voucher.id,
            voucher_number: `PEW00${String(voucher.id).padStart(5, '0')}`,
            claimed_by: voucher.claimed_by,
            ps_number: voucher.creator_ps_number || '-',
            department: voucher.department,
            claimed_date: voucher.claimed_date,
            expense_booking_location: voucher.expense_booking_location,

            // Map actions for the table
            actions: [
                {
                    person: voucher.user_name || '-',
                    psno: voucher.creator_ps_number || '-',
                    action: 'Voucher Initiated',
                    date: new Date(voucher.claimed_date).toISOString().split('T')[0]
                },
                {
                    person: voucher.approver1_name || '-',
                    psno: '-',
                    action: voucher.approver1_status === 'approved' ? 'Approved' : (voucher.approver1_status || '-'),
                    date: voucher.approver1_date ? new Date(voucher.approver1_date).toISOString().split('T')[0] : '-'
                },
                {
                    person: voucher.approver2_name || '-',
                    psno: '-',
                    action: voucher.approver2_status === 'approved' ? 'Approved' : (voucher.approver2_status || '-'),
                    date: voucher.approver2_date ? new Date(voucher.approver2_date).toISOString().split('T')[0] : '-'
                }
            ],

            invoice_no: voucher.invoice_number,
            invoice_date: voucher.invoice_date,
            nature_of_expenses: voucher.nature_of_expenses,
            service_category: '',
            description: voucher.description,

            supplier_name: voucher.supplier,
            supplier_code: 'ALLW003',
            supplier_address: 'ALLWYN JUMBO PRINTS AND EXCHANGER PVT LTD\n9-C/10, Near Railway Station\nAndheri (East), MUMBAI 400069',
            business_partner_type: 'OTHERS',

            basic_amount: voucher.basic_amount,
            gross_amount: voucher.gross_amount,
            project_code: voucher.project_code,
            project_name: voucher.project_name,
            items: [
                {
                    ledger: '4074006\nWIP - OTHERS',
                    loc: voucher.expense_booking_location || 'PEW',
                    eu: '06',
                    dept: voucher.department,
                    project: voucher.project_code || 'S068015A',
                    csr_project: '',
                    excise_exempt: 'No',
                    employee: '',
                    amount: voucher.basic_amount
                }
            ]
        };

        console.log('PDF Data prepared.');

        const pdfPath = path.join(__dirname, 'debug_route_jcc_21_v2.pdf');
        console.log('Generating PDF to:', pdfPath);

        await generateJCCPDF(pdfData, pdfPath);
        console.log('PDF Generation Successful!');

        // Check file size
        const stats = fs.statSync(pdfPath);
        console.log('PDF Size:', stats.size);

    } catch (error) {
        console.error('Error in testRouteLogic:', error);
    }
}

testRouteLogic();
