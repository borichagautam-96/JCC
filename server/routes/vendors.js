import express from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import db from '../database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();
const excelUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});

const handleVendorFileUpload = (req, res, next) => {
    excelUpload.single('vendorFile')(req, res, (uploadError) => {
        if (!uploadError) {
            return next();
        }

        if (uploadError instanceof multer.MulterError) {
            if (uploadError.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'Excel file is too large. Max allowed size is 20 MB.' });
            }
            return res.status(400).json({ error: `Upload error: ${uploadError.message}` });
        }

        return res.status(400).json({ error: uploadError.message || 'Failed to process uploaded file' });
    });
};

const toTrimmedString = (value) => String(value ?? '').trim();

const normalizeHeader = (value) => toTrimmedString(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();

const findColumnIndex = (headers, aliases) => {
    const exactMatchIndex = headers.findIndex((header) => aliases.includes(header));
    if (exactMatchIndex >= 0) {
        return exactMatchIndex;
    }
    return headers.findIndex((header) => aliases.some((alias) => header.includes(alias)));
};

const getCellValue = (row, index) => {
    if (!Array.isArray(row) || index < 0 || index >= row.length) {
        return '';
    }
    return toTrimmedString(row[index]);
};

const resolveVendorName = (vendorName, bpName) => {
    const normalizedVendorName = toTrimmedString(vendorName);
    if (normalizedVendorName) {
        return normalizedVendorName;
    }
    return toTrimmedString(bpName);
};

const generateVendorCode = () => {
    let generated = '';
    let attempts = 0;
    do {
        const suffix = String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
        generated = `V${suffix}`;
        const existingByCode = db.prepare('SELECT id FROM vendors WHERE vendor_code = ?').get(generated);
        if (!existingByCode) {
            return generated;
        }
        attempts += 1;
    } while (attempts < 5);

    return '';
};

const generateUniqueVendorCode = (existingCodes) => {
    let attempts = 0;
    while (attempts < 200) {
        const candidate = generateVendorCode();
        if (candidate && !existingCodes.has(candidate.toLowerCase())) {
            return candidate;
        }
        attempts += 1;
    }
    return '';
};

// Canonical vendor names shown in Vendor Management — must stay in sync with VendorManagementPage.jsx TEMP_ALLOWED_VENDOR_NAMES
const ALLOWED_VENDOR_NAMES = [
    'ALLWYN JUMBO PRINTS AND EXCHANGER PVT LTD',
    'Armoured Vehicles Nigam Limited',
    'Asha Furniture Works',
    'Balaji Arts',
    'Bharat Electronics Limited',
    'CHANDRAHAS SHETTY',
    'DDSPLM Pvt. Ltd.',
    'Delos Consulting Pvt. Ltd.',
    'DesignTech Systems Pvt. Ltd.',
    'GenieHR Solutions Pvt. Ltd.',
    'Global Publishing Solutions Ltd.',
    'Hornbill Studios Pvt Ltd',
    'JUSTVFX STUDIOS',
    'LOUISCIAGA OVERSEAS PVT. LTD',
    'MICROPOINT COMPUTERS PRIVATE LIMITED',
    'Pentagon System And Services Pvt. Ltd',
    'PEREVODRU',
    'PEREVODRU GLOBAL TRANSLATION SERVICES',
    'Pixlar Art Creation',
    'RAC IT SOLUTIONS PVT. LTD.',
    'Schneider Electric India Pvt. Limited (SEIPL)',
    'Shezarweb Technologies',
    'Shivam Computers',
    'SIEMENS INDUSTRY SOFTWARE (INDIA)',
    'Smartify Software Solutions LLP',
    'Somshanti Enterprises',
    'Urgent Courier',
    'Voice Kraft Productions',
    'White Globe Pvt. Ltd.',
    'Track On Courier',
];

// Get vendor names list (for dropdowns) — returns ONLY vendors visible in Vendor Management
// Merges DB vendors (filtered to the whitelist) + the whitelist itself as guaranteed fallback
// Accessible by: Any authenticated user
router.get('/names', authenticateToken, (req, res) => {
    try {
        // Fetch all vendor_name values from DB
        const dbVendors = db.prepare(`
            SELECT DISTINCT vendor_name
            FROM vendors
            WHERE vendor_name IS NOT NULL
              AND TRIM(vendor_name) != ''
        `).all().map((v) => String(v.vendor_name).trim()).filter(Boolean);

        const allowedLower = new Set(ALLOWED_VENDOR_NAMES.map((n) => n.toLowerCase()));

        // Merge: include all DB vendors, then add canonical fallbacks not already present
        const dbLowerSet = new Set(dbVendors.map((n) => n.toLowerCase()));
        const fallback = ALLOWED_VENDOR_NAMES.filter((n) => !dbLowerSet.has(n.toLowerCase()));

        const merged = [...new Set([...dbVendors, ...fallback])]
            .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

        res.json(merged);
    } catch (error) {
        console.error('Error fetching vendor names:', error);
        res.status(500).json({ error: 'Failed to fetch vendor names' });
    }
});

// Get all vendors
// Accessible by: Admin only
router.get('/', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const sql = `SELECT * FROM vendors ORDER BY created_at DESC`;
        const vendors = db.prepare(sql).all();
        res.json(vendors);
    } catch (error) {
        console.error('Error fetching vendors:', error);
        res.status(500).json({ error: 'Failed to fetch vendors' });
    }
});

// Create new vendor
// Accessible by: Admin only
router.post('/', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const {
            vendorCode,
            vendorName,
            address,
            vendorAddress,
            contactNumber,
            mailId,
            emailId,
            bpId,
            bpName,
            city,
            poNo,
            poNumber,
            country,
            ndaDate,
            ndaExpiryDate,
            ndaPeriodYear,
            projectName,
            signedHardCopyDepositoryLocation,
            signedHardCopyDepositoryLocationFp,
            itemType,
            path: vendorPath,
        } = req.body;

        const normalizedVendorName = resolveVendorName(vendorName, bpName);
        const resolvedVendorAddress = toTrimmedString(vendorAddress || address);
        const resolvedMailId = toTrimmedString(emailId || mailId);

        if (!normalizedVendorName) {
            return res.status(400).json({ error: 'Vendor is required' });
        }

        let finalVendorCode = toTrimmedString(vendorCode);
        if (!finalVendorCode) {
            return res.status(400).json({ error: 'Vendor code is required' });
        }

        if (!resolvedVendorAddress) {
            return res.status(400).json({ error: 'Vendor address is required' });
        }

        const resolvedPoNo = toTrimmedString(poNo || poNumber || country);

        const existingByCode = db.prepare(`
            SELECT id
            FROM vendors
            WHERE LOWER(TRIM(vendor_code)) = LOWER(TRIM(?))
            LIMIT 1
        `).get(finalVendorCode);

        if (existingByCode) {
            return res.status(400).json({ error: 'Vendor code already exists' });
        }

        const existingByName = db.prepare(`
            SELECT id, vendor_name
            FROM vendors
            WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))
            LIMIT 1
        `).get(normalizedVendorName);

        if (existingByName) {
            return res.status(400).json({ error: 'Vendor Name already exists' });
        }

        const result = db.prepare(`
            INSERT INTO vendors (
                vendor_code,
                vendor_name,
                address,
                contact_number,
                mail_id,
                bp_id,
                bp_name,
                city,
                country,
                nda_date,
                nda_expiry_date,
                nda_period_year,
                project_name,
                signed_hard_copy_depository_location,
                signed_hard_copy_depository_location_fp,
                item_type,
                vendor_path
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            finalVendorCode,
            normalizedVendorName,
            resolvedVendorAddress,
            toTrimmedString(contactNumber),
            resolvedMailId,
            toTrimmedString(bpId),
            toTrimmedString(bpName) || normalizedVendorName,
            toTrimmedString(city),
            resolvedPoNo,
            toTrimmedString(ndaDate),
            toTrimmedString(ndaExpiryDate),
            toTrimmedString(ndaPeriodYear),
            toTrimmedString(projectName),
            toTrimmedString(signedHardCopyDepositoryLocation),
            toTrimmedString(signedHardCopyDepositoryLocationFp),
            toTrimmedString(itemType),
            toTrimmedString(vendorPath)
        );

        res.status(201).json({
            message: 'Vendor created successfully',
            id: result.lastInsertRowid,
            vendorCode: finalVendorCode,
            vendorName: normalizedVendorName
        });
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Vendor already exists' });
        }
        console.error('Error creating vendor:', error);
        res.status(500).json({ error: 'Failed to create vendor' });
    }
});

// Bulk import vendors from Excel
router.post('/import', authenticateToken, authorizeRoles('admin'), handleVendorFileUpload, (req, res) => {
    try {
        if (!req.file?.buffer) {
            return res.status(400).json({ error: 'Excel file is required' });
        }

        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const firstSheetName = workbook.SheetNames?.[0];
        if (!firstSheetName) {
            return res.status(400).json({ error: 'Excel file has no sheets' });
        }

        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
            header: 1,
            defval: '',
            raw: false,
        });

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ error: 'Excel file is empty' });
        }

        const headerRow = Array.isArray(rows[0]) ? rows[0].map(normalizeHeader) : [];

        const bpIdColumnIndex = findColumnIndex(headerRow, ['bp id', 'business partner id', 'business partner code']);
        const bpNameColumnIndex = findColumnIndex(headerRow, ['bp name', 'business partner name']);
        const vendorNameColumnIndex = findColumnIndex(headerRow, ['vendor name', 'vendor']);
        const cityColumnIndex = findColumnIndex(headerRow, ['city', 'vendor city']);
        const poNoColumnIndex = findColumnIndex(headerRow, ['po no', 'po number', 'pono', 'po#', 'po ref', 'purchase order', 'country']);
        const addressColumnIndex = findColumnIndex(headerRow, ['vendor address', 'address', 'vendor addr']);
        const ndaDateColumnIndex = findColumnIndex(headerRow, ['date of nda', 'nda date', 'nda signed date']);
        const ndaExpiryDateColumnIndex = findColumnIndex(headerRow, ['expiry date of nda', 'nda expiry date', 'nda valid till', 'nda valid until']);
        const ndaPeriodYearColumnIndex = findColumnIndex(headerRow, ['period of nda in year', 'nda period', 'nda period year', 'nda period years', 'nda years']);
        const projectNameColumnIndex = findColumnIndex(headerRow, ['project name', 'project']);
        const signedHardCopyLocationColumnIndex = findColumnIndex(headerRow, ['signed hard copy depository location', 'signed hard copy location', 'hard copy depository']);
        const signedHardCopyLocationFpColumnIndex = findColumnIndex(headerRow, ['signed hard copy depository location fp', 'signed hard copy location fp', 'hard copy location fp']);
        const itemTypeColumnIndex = findColumnIndex(headerRow, ['item type', 'item category', 'category']);
        const pathColumnIndex = findColumnIndex(headerRow, ['path', 'vendor path']);
        const emailColumnIndex = findColumnIndex(headerRow, ['email', 'email id', 'email address', 'mail id', 'mail']);
        const vendorCodeColumnIndex = findColumnIndex(headerRow, ['vendor code', 'vendor id', 'code', 'vendorid']);

        const parsedRows = rows
            .slice(1)
            .map((row) => {
                const bpName = getCellValue(row, bpNameColumnIndex);
                const fallbackName = (bpNameColumnIndex < 0 && vendorNameColumnIndex < 0) ? getCellValue(row, 0) : '';
                const vendorName = resolveVendorName(getCellValue(row, vendorNameColumnIndex), bpName || fallbackName);

                return {
                    vendorCode: getCellValue(row, vendorCodeColumnIndex),
                    vendorName,
                    address: getCellValue(row, addressColumnIndex),
                    bpId: getCellValue(row, bpIdColumnIndex),
                    bpName: bpName || vendorName,
                    city: getCellValue(row, cityColumnIndex),
                    poNo: getCellValue(row, poNoColumnIndex),
                    ndaDate: getCellValue(row, ndaDateColumnIndex),
                    ndaExpiryDate: getCellValue(row, ndaExpiryDateColumnIndex),
                    ndaPeriodYear: getCellValue(row, ndaPeriodYearColumnIndex),
                    projectName: getCellValue(row, projectNameColumnIndex),
                    signedHardCopyDepositoryLocation: getCellValue(row, signedHardCopyLocationColumnIndex),
                    signedHardCopyDepositoryLocationFp: getCellValue(row, signedHardCopyLocationFpColumnIndex),
                    itemType: getCellValue(row, itemTypeColumnIndex),
                    path: getCellValue(row, pathColumnIndex),
                    mailId: getCellValue(row, emailColumnIndex),
                };
            })
            .filter((entry) => entry.vendorName.length > 0);

        if (parsedRows.length === 0) {
            return res.status(400).json({ error: 'No Vendor Name values found in Excel file' });
        }

        const uniqueIncomingRows = Array.from(new Map(
            parsedRows.map((entry) => [entry.vendorName.toLowerCase(), entry])
        ).values());

        const existingCodes = new Set();

        let insertedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        let deletedCount = 0;

        const insertStmt = db.prepare(`
            INSERT INTO vendors (
                vendor_code,
                vendor_name,
                address,
                contact_number,
                mail_id,
                bp_id,
                bp_name,
                city,
                country,
                nda_date,
                nda_expiry_date,
                nda_period_year,
                project_name,
                signed_hard_copy_depository_location,
                signed_hard_copy_depository_location_fp,
                item_type,
                vendor_path
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const deleteAllStmt = db.prepare('DELETE FROM vendors');

        const importTransaction = db.transaction(() => {
            const deleteResult = deleteAllStmt.run();
            deletedCount = deleteResult?.changes || 0;

            uniqueIncomingRows.forEach((entry) => {
                let finalVendorCode = toTrimmedString(entry.vendorCode);
                if (!finalVendorCode || existingCodes.has(finalVendorCode.toLowerCase())) {
                    finalVendorCode = generateUniqueVendorCode(existingCodes);
                }

                if (!finalVendorCode) {
                    throw new Error('Failed to generate unique vendor code during import');
                }

                insertStmt.run(
                    finalVendorCode,
                    entry.vendorName,
                    entry.address,
                    '',
                    entry.mailId,
                    entry.bpId,
                    entry.bpName || entry.vendorName,
                    entry.city,
                    entry.poNo,
                    entry.ndaDate,
                    entry.ndaExpiryDate,
                    entry.ndaPeriodYear,
                    entry.projectName,
                    entry.signedHardCopyDepositoryLocation,
                    entry.signedHardCopyDepositoryLocationFp,
                    entry.itemType,
                    entry.path,
                );

                existingCodes.add(finalVendorCode.toLowerCase());
                insertedCount += 1;
            });
        });

        importTransaction();

        return res.json({
            message: 'Vendor import completed',
            inserted: insertedCount,
            updated: updatedCount,
            skipped: skippedCount,
            deleted: deletedCount,
            totalRows: parsedRows.length,
        });
    } catch (error) {
        console.error('Error importing vendors from Excel:', error);
        return res.status(500).json({ error: `Failed to import vendors from Excel: ${error.message || 'Unknown error'}` });
    }
});

// Update vendor
router.put('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const {
            vendorCode,
            vendorName,
            address,
            vendorAddress,
            contactNumber,
            mailId,
            emailId,
            bpId,
            bpName,
            city,
            poNo,
            poNumber,
            country,
            ndaDate,
            ndaExpiryDate,
            ndaPeriodYear,
            projectName,
            signedHardCopyDepositoryLocation,
            signedHardCopyDepositoryLocationFp,
            itemType,
            path: vendorPath,
        } = req.body;
        const { id } = req.params;

        const normalizedVendorName = resolveVendorName(vendorName, bpName);
        const resolvedVendorAddress = toTrimmedString(vendorAddress || address);
        const resolvedMailId = toTrimmedString(emailId || mailId);
        if (!normalizedVendorName) {
            return res.status(400).json({ error: 'Vendor is required' });
        }

        let finalVendorCode = toTrimmedString(vendorCode);
        if (!finalVendorCode) {
            return res.status(400).json({ error: 'Vendor code is required' });
        }

        if (!resolvedVendorAddress) {
            return res.status(400).json({ error: 'Vendor address is required' });
        }

        const existingByCode = db.prepare(`
            SELECT id
            FROM vendors
            WHERE LOWER(TRIM(vendor_code)) = LOWER(TRIM(?))
              AND id != ?
            LIMIT 1
        `).get(finalVendorCode, id);

        if (existingByCode) {
            return res.status(400).json({ error: 'Vendor code already exists' });
        }

        db.prepare(`
            UPDATE vendors
            SET vendor_code = ?,
                vendor_name = ?,
                address = ?,
                contact_number = ?,
                mail_id = ?,
                bp_id = ?,
                bp_name = ?,
                city = ?,
                country = ?,
                nda_date = ?,
                nda_expiry_date = ?,
                nda_period_year = ?,
                project_name = ?,
                signed_hard_copy_depository_location = ?,
                signed_hard_copy_depository_location_fp = ?,
                item_type = ?,
                vendor_path = ?
            WHERE id = ?
        `).run(
            finalVendorCode,
            normalizedVendorName,
            resolvedVendorAddress,
            toTrimmedString(contactNumber),
            resolvedMailId,
            toTrimmedString(bpId),
            toTrimmedString(bpName) || normalizedVendorName,
            toTrimmedString(city),
            toTrimmedString(poNo || poNumber || country),
            toTrimmedString(ndaDate),
            toTrimmedString(ndaExpiryDate),
            toTrimmedString(ndaPeriodYear),
            toTrimmedString(projectName),
            toTrimmedString(signedHardCopyDepositoryLocation),
            toTrimmedString(signedHardCopyDepositoryLocationFp),
            toTrimmedString(itemType),
            toTrimmedString(vendorPath),
            id
        );

        res.json({ message: 'Vendor updated successfully' });
    } catch (error) {
        console.error('Error updating vendor:', error);
        res.status(500).json({ error: 'Failed to update vendor' });
    }
});

// Delete all vendors
router.delete('/clear', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        const result = db.prepare('DELETE FROM vendors').run();
        res.json({ message: 'All vendors deleted successfully', deleted: result?.changes || 0 });
    } catch (error) {
        console.error('Error deleting all vendors:', error);
        res.status(500).json({ error: 'Failed to delete all vendors' });
    }
});

// Delete vendor
router.delete('/:id', authenticateToken, authorizeRoles('admin'), (req, res) => {
    try {
        db.prepare('DELETE FROM vendors WHERE id = ?').run(req.params.id);
        res.json({ message: 'Vendor deleted successfully' });
    } catch (error) {
        console.error('Error deleting vendor:', error);
        res.status(500).json({ error: 'Failed to delete vendor' });
    }
});

export default router;
