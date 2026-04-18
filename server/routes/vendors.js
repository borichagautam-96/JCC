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

        const bpIdColumnIndex = findColumnIndex(headerRow, ['bp id']);
        const bpNameColumnIndex = findColumnIndex(headerRow, ['bp name']);
        const vendorNameColumnIndex = findColumnIndex(headerRow, ['vendor name']);
        const cityColumnIndex = findColumnIndex(headerRow, ['city']);
        const poNoColumnIndex = findColumnIndex(headerRow, ['po no', 'po number', 'pono', 'country']);
        const addressColumnIndex = findColumnIndex(headerRow, ['vendor address', 'address']);
        const ndaDateColumnIndex = findColumnIndex(headerRow, ['date of nda', 'nda date']);
        const ndaExpiryDateColumnIndex = findColumnIndex(headerRow, ['expiry date of nda', 'nda expiry date']);
        const ndaPeriodYearColumnIndex = findColumnIndex(headerRow, ['period of nda in year', 'nda period']);
        const projectNameColumnIndex = findColumnIndex(headerRow, ['project name']);
        const signedHardCopyLocationColumnIndex = findColumnIndex(headerRow, ['signed hard copy depository location']);
        const signedHardCopyLocationFpColumnIndex = findColumnIndex(headerRow, ['signed hard copy depository location fp']);
        const itemTypeColumnIndex = findColumnIndex(headerRow, ['item type']);
        const pathColumnIndex = findColumnIndex(headerRow, ['path']);
        const emailColumnIndex = findColumnIndex(headerRow, ['email', 'mail id', 'mail']);
        const vendorCodeColumnIndex = findColumnIndex(headerRow, ['vendor code', 'code']);

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

        const existingRows = db.prepare('SELECT vendor_name, vendor_code FROM vendors').all();
        const existingNames = new Set(existingRows.map((row) => toTrimmedString(row.vendor_name).toLowerCase()));
        const existingCodes = new Set(existingRows.map((row) => toTrimmedString(row.vendor_code).toLowerCase()).filter(Boolean));

        let insertedCount = 0;
        let skippedCount = 0;

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

        const importTransaction = db.transaction(() => {
            uniqueIncomingRows.forEach((entry) => {
                const normalizedName = entry.vendorName.toLowerCase();
                if (existingNames.has(normalizedName)) {
                    skippedCount += 1;
                    return;
                }

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

                existingNames.add(normalizedName);
                existingCodes.add(finalVendorCode.toLowerCase());
                insertedCount += 1;
            });
        });

        importTransaction();

        return res.json({
            message: 'Vendor import completed',
            inserted: insertedCount,
            skipped: skippedCount,
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
