import QRCode from 'qrcode';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Generate a unique QR code for a correspondence
 * @param {Object} data - Correspondence data
 * @param {string} outputPath - Path to save QR code image
 * @returns {Promise<Object>} QR code info
 */
export const generateCorrespondenceQR = async (correspondenceId, correspondenceNumber) => {
    try {
        // Generate unique verification token
        const verificationToken = uuidv4();

        // Create QR data with correspondence info and verification
        const qrData = JSON.stringify({
            id: correspondenceId,
            number: correspondenceNumber,
            token: verificationToken,
            timestamp: new Date().toISOString(),
            type: 'correspondence'
        });

        // Generate hash for integrity verification
        const hash = crypto
            .createHash('sha256')
            .update(qrData)
            .digest('hex')
            .substring(0, 16);

        // QR directory
        const qrDir = path.join(__dirname, '../../uploads/qr-codes');
        if (!fs.existsSync(qrDir)) {
            fs.mkdirSync(qrDir, { recursive: true });
        }

        // Generate QR code as data URL (for embedding in PDFs)
        const qrDataURL = await QRCode.toDataURL(qrData, {
            width: 200,
            margin: 1,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });

        // Also save as file
        const fileName = `qr-${correspondenceId}-${hash}.png`;
        const filePath = path.join(qrDir, fileName);

        await QRCode.toFile(filePath, qrData, {
            width: 200,
            margin: 1
        });

        return {
            qrCode: hash, // Store hash in database for verification
            verificationToken,
            qrDataURL, // For embedding in PDFs
            qrFilePath: `/uploads/qr-codes/${fileName}`
        };
    } catch (error) {
        console.error('Error generating QR code:', error);
        throw error;
    }
};

/**
 * Verify a QR code
 * @param {string} qrData - QR code data string
 * @param {string} storedHash - Hash stored in database
 * @returns {Object} Verification result
 */
export const verifyQRCode = (qrData, storedHash) => {
    try {
        const parsedData = JSON.parse(qrData);

        // Regenerate hash
        const hash = crypto
            .createHash('sha256')
            .update(qrData)
            .digest('hex')
            .substring(0, 16);

        const isValid = hash === storedHash;

        return {
            isValid,
            data: isValid ? parsedData : null,
            message: isValid ? 'QR code verified successfully' : 'Invalid QR code'
        };
    } catch (error) {
        return {
            isValid: false,
            data: null,
            message: 'Invalid QR code format'
        };
    }
};

/**
 * Generate digital signature placeholder
 * (In production, this would integrate with actual digital signature service)
 */
export const generateDigitalSignature = (userId, userName, documentId) => {
    const signatureData = {
        userId,
        userName,
        documentId,
        timestamp: new Date().toISOString(),
        signatureId: uuidv4()
    };

    // Generate signature hash
    const signature = crypto
        .createHash('sha256')
        .update(JSON.stringify(signatureData))
        .digest('hex');

    return {
        signature,
        signedBy: userName,
        signedAt: signatureData.timestamp,
        signatureId: signatureData.signatureId
    };
};
