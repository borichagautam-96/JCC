import db from './database.js';
import { extractInvoiceData } from './utils/ocrProcessor.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function fixMissingDescriptions() {
    console.log('Starting missing description backfill...');
    
    const missingVouchers = db.prepare(`
        SELECT v.id as voucher_id, v.attachment_path as attachment, v.basic_amount as amount
        FROM voucher_requests v
        LEFT JOIN voucher_materials m ON v.id = m.voucher_id
        WHERE m.id IS NULL AND v.attachment_path IS NOT NULL AND v.attachment_path != ''
    `).all();

    console.log(`Found ${missingVouchers.length} vouchers with no materials.`);

    for (const voucher of missingVouchers) {
        const { voucher_id: voucherId, attachment, amount } = voucher;
        
        const filePath = path.join(__dirname, '../uploads', attachment);
        if (!fs.existsSync(filePath)) {
            console.log(`Attachment not found for voucher ${voucherId}: ${filePath}`);
            continue;
        }

        console.log(`Extracting data for voucher ${voucherId} from ${attachment}...`);
        try {
            const data = await extractInvoiceData(filePath, 'application/pdf');
            if (!data || !data.lineItems) {
                console.log(`No line items extracted for voucher ${voucherId}`);
                continue;
            }

            const extractedItems = data.lineItems.filter(item => !item.isSummary);
            
            // Try to find matching item by amount
            const matAmountNum = parseFloat(String(amount).replace(/[^0-9.-]/g, ''));
            if (isNaN(matAmountNum)) {
               console.log(`Voucher ${voucherId} has invalid amount ${amount}`);
               continue;
            }

            const match = extractedItems.find(item => {
                const extractedAmount = parseFloat(String(item.amount).replace(/[^0-9.-]/g, ''));
                return Math.abs(extractedAmount - matAmountNum) < 0.01;
            });

            if (match && (match.description || match.text)) {
                const desc = match.description || match.text;
                
                // Get project_name and project_code from voucher_requests to populate voucher_materials correctly
                const vRecord = db.prepare('SELECT project_name, project_code FROM voucher_requests WHERE id = ?').get(voucherId);
                
                db.prepare(`INSERT INTO voucher_materials (voucher_id, amount, project_code, project_name, description_of_material) VALUES (?, ?, ?, ?, ?)`)
                  .run(voucherId, amount, vRecord.project_code || '', vRecord.project_name || '', desc);
                console.log(`✅ Created material for voucher ${voucherId} with description: ${desc}`);
            } else {
                console.log(`❌ Could not find match for amount ${amount} in voucher ${voucherId}`);
            }
        } catch (err) {
            console.error(`Failed extraction for voucher ${voucherId}:`, err.message);
        }
    }
    
    console.log('Finished missing description backfill.');
}

fixMissingDescriptions().catch(console.error);
