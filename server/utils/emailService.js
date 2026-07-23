import nodemailer from 'nodemailer';
import db from '../database.js';

// ─── SMTP Configuration (On-prem Exchange relay, no auth) ─────────────────────
const EMAIL_CONFIG = {
    host: process.env.SMTP_HOST || '172.16.128.51',
    port: Number(process.env.SMTP_PORT) || 25,
    secure: false,
    tls: { rejectUnauthorized: false },
    // No auth — open relay via on-prem Exchange
};

const SENDER_ADDRESS = process.env.SMTP_SENDER || 'PESDT@larsentoubro.com';

const createTransporter = () => {
    try {
        return nodemailer.createTransport(EMAIL_CONFIG);
    } catch (error) {
        console.error('[Email] Error creating transporter:', error);
        return null;
    }
};

// ─── Email Validation ─────────────────────────────────────────────────────────
const isValidEmail = (email) => {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};

// ─── Email Event Logging ──────────────────────────────────────────────────────
const logEmailEvent = ({ recipient, subject, templateName, entityType, entityId, status, errorMessage, messageId }) => {
    try {
        db.prepare(`
            INSERT INTO email_event_logs (recipient, subject, template_name, entity_type, entity_id, status, error_message, message_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            recipient || null,
            subject || null,
            templateName || null,
            entityType || null,
            entityId || null,
            status,
            errorMessage || null,
            messageId || null
        );
    } catch (err) {
        console.error('[Email] Failed to log email event:', err.message);
    }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Format date as "Thursday, October 16, 2025"
const formatInvoiceDate = (dateStr) => {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
};

// Shared details table matching the L&T email format
const detailsTable = (voucher) => `
    <table style="border-collapse: collapse; font-size: 14px; margin: 12px 0; width: 100%; border: 2px solid #444;">
        <thead>
            <tr>
                <th style="padding: 8px 12px; background-color: #1a1a2e; color: #ffffff; text-align: left; font-weight: bold; border: 1px solid #444; width: 40%;">Field</th>
                <th style="padding: 8px 12px; background-color: #1a1a2e; color: #ffffff; text-align: left; font-weight: bold; border: 1px solid #444;">Information</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; font-weight: 600; color: #222;">JCC No.</td>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; color: #222;">${voucher.voucherRequestId || '-'}</td>
            </tr>
            <tr>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #ffffff; font-weight: 600; color: #222;">Claimed By</td>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #ffffff; color: #222;">${voucher.claimedBy || '-'}${voucher.creatorPsNumber ? ` (${voucher.creatorPsNumber})` : ''}</td>
            </tr>
            <tr>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; font-weight: 600; color: #222;">Location</td>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; color: #222;">${voucher.expenseBookingLocation || '-'}</td>
            </tr>
            <tr>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #ffffff; font-weight: 600; color: #222;">Supplier</td>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #ffffff; color: #222;">${voucher.supplier || '-'}</td>
            </tr>
            <tr>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; font-weight: 600; color: #222;">Basic Amount (INR)</td>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; color: #222;">${voucher.basicAmount || '-'}</td>
            </tr>
            <tr>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #ffffff; font-weight: 600; color: #222;">Gross Amount (INR)</td>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #ffffff; color: #222;">${voucher.grossAmount || '-'}</td>
            </tr>
            <tr>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; font-weight: 600; color: #222;">Invoice No.</td>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; color: #222;">${voucher.invoiceNumber || '-'}</td>
            </tr>
            <tr>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #ffffff; font-weight: 600; color: #222;">Invoice Date</td>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #ffffff; color: #222;">${formatInvoiceDate(voucher.invoiceDate)}</td>
            </tr>
            <tr>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; font-weight: 600; color: #222;">Nature of Expense</td>
                <td style="padding: 7px 12px; border: 1px solid #555; background-color: #f5f5f5; color: #222;">${voucher.natureOfExpenses || '-'}</td>
            </tr>
        </tbody>
    </table>
`;

const getJccLink = (voucher) => {
    const baseUrl = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
    const explicitLink = (voucher?.jccLink || '').trim();
    if (explicitLink) return explicitLink;
    if (baseUrl && voucher?.voucherId) return `${baseUrl}/api/jcc/download-jcc-pdf/${voucher.voucherId}`;
    return '#';
};

const getJccDisplayId = (voucher) => {
    const raw = String(voucher?.voucherRequestId || '').trim();
    if (!raw) return 'JCC001';
    const digits = (raw.match(/\d+/g) || []).join('');
    if (!digits) return raw;
    return `JCC${String(Number.parseInt(digits, 10)).padStart(3, '0')}`;
};

const emailWrapper = (body) => `
    <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; color: #333; font-size: 14px; line-height: 1.6;">
        ${body}
        <div style="margin-top: 30px; padding-top: 14px; border-top: 1px solid #E0E0E0;">
            <p style="color: #888; font-size: 12px; margin: 0;">This is an automated email from the InFloAI System. Please do not reply to this email.</p>
            <p style="color: #888; font-size: 12px; margin: 4px 0 0 0;">&copy; ${new Date().getFullYear()} L&amp;T &mdash; InFloAI JCC Automation System</p>
        </div>
    </div>
`;

// ─── Printing-module helpers ──────────────────────────────────────────────────
const printRow = (label, value, alt) => `
    <tr>
        <td style="padding: 7px 12px; border: 1px solid #555; background-color: ${alt ? '#f5f5f5' : '#ffffff'}; font-weight: 600; color: #222;">${label}</td>
        <td style="padding: 7px 12px; border: 1px solid #555; background-color: ${alt ? '#f5f5f5' : '#ffffff'}; color: #222;">${value ?? '-'}</td>
    </tr>`;

const printDetailsTable = (pj) => `
    <table style="border-collapse: collapse; font-size: 14px; margin: 12px 0; width: 100%; border: 2px solid #444;">
        <thead>
            <tr>
                <th style="padding: 8px 12px; background-color: #1a1a2e; color: #ffffff; text-align: left; font-weight: bold; border: 1px solid #444; width: 40%;">Field</th>
                <th style="padding: 8px 12px; background-color: #1a1a2e; color: #ffffff; text-align: left; font-weight: bold; border: 1px solid #444;">Information</th>
            </tr>
        </thead>
        <tbody>
            ${printRow('Job No.', pj.jobNumber, true)}
            ${printRow('Request ID', pj.requestId, false)}
            ${printRow('Requestor', pj.requestorName, true)}
            ${printRow('Project', pj.projectName, false)}
            ${printRow('Debit Code', pj.debitCode, true)}
            ${printRow('Documents', pj.documentCount, false)}
            ${pj.operatorName ? printRow('Operator', pj.operatorName, true) : ''}
        </tbody>
    </table>`;

const printPortalLink = () => {
    const base = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
    if (!base) return '';
    return `<p style="margin-top:16px;"><a href="${base}/hub" style="display:inline-block;background:#1E3A5F;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Open Printing Portal</a></p>`;
};

// ─── Email Templates ──────────────────────────────────────────────────────────

const emailTemplates = {

    // Sent to Creator on JCC submission
    jccCreatedCreator: (voucher, creator) => ({
        subject: `JCC ${voucher.voucherRequestId} Submitted Successfully`,
        html: emailWrapper(`
            <p>Dear <strong>${creator.name}</strong>,</p>
            <p>
                <strong>${voucher.voucherRequestId}</strong> has been submitted successfully and is pending for approval.
            </p>
            <p>Its details are as follows:</p>
            ${detailsTable(voucher)}
            <p style="color: #555;">You will be notified once the JCC is reviewed by the approvers.</p>
        `)
    }),

    // Sent to Manager (Approver 1) on JCC submission
    jccCreatedApprover1: (voucher, creator) => ({
        subject: `${voucher.voucherRequestId} has been submitted by ${voucher.claimedBy || creator.name} for approval`,
        html: emailWrapper(`
            <p>${voucher.voucherRequestId} has been submitted by <strong>${voucher.claimedBy || creator.name}</strong> for your review and approval. Please find the details below for your reference:</p>
            <p><strong>JCC Submission Details</strong></p>
            ${detailsTable(voucher)}
            ${voucher.approveLink ? `<p style="margin-top: 18px;"><a href="${voucher.approveLink}" style="display:inline-block;background:#059669;color:#ffffff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600;">✓ Approve this JCC</a><span style="color:#888;font-size:12px;">&nbsp; (opens a confirmation page)</span></p>` : ''}
            <p style="margin-top: 20px;">
                To view invoice and to approve:&nbsp;
                <a href="#" style="color: #0066CC; text-decoration: none; font-weight: 600;">Open Task</a>
                &nbsp;|&nbsp;
                <a href="#" style="color: #CC6600; text-decoration: none; font-weight: 600;">Open BPM</a>
                <span style="color: #888; font-size: 12px;"> (Link to access the portal directly)</span>
            </p>
        `)
    }),

    // Sent to Final Approver on JCC submission (FYI — Level 1 not yet done)
    jccCreatedFinalApprover: (voucher, creator) => ({
        subject: `${voucher.voucherRequestId} submitted — Your Final Approval will be required`,
        html: emailWrapper(`
            <p>${voucher.voucherRequestId} has been submitted by <strong>${voucher.claimedBy || creator.name}</strong> for your review and approval. Please find the details below for your reference:</p>
            <p>After Level 1 Manager approval, this JCC will require <strong>your Final Approval</strong>.</p>
            <p><strong>JCC Submission Details</strong></p>
            ${detailsTable(voucher)}
            <p style="margin-top: 20px;">
                To view invoice and to approve:&nbsp;
                <a href="#" style="color: #0066CC; text-decoration: none; font-weight: 600;">Open Task</a>
                &nbsp;|&nbsp;
                <a href="#" style="color: #CC6600; text-decoration: none; font-weight: 600;">Open BPM</a>
                <span style="color: #888; font-size: 12px;"> (Link to access the portal directly)</span>
            </p>
        `)
    }),

    // Sent to Final Approver after Level 1 is approved — their turn now
    jccPendingFinalApproval: (voucher, creator) => ({
        subject: `${voucher.voucherRequestId} — Action Required: Final Approval Pending`,
        html: emailWrapper(`
            <p>
                <strong>JCC No.: ${voucher.voucherRequestId}</strong> has been submitted by
                <strong>${voucher.claimedBy || creator.name}</strong> for approval.<br/>
                It has been <strong>approved at Level 1</strong> and is now pending <strong>your Final Approval</strong>.<br/>
                Kindly review the same.
            </p>
            <p>Its details are as follows:</p>
            ${detailsTable(voucher)}
            ${voucher.approveLink ? `<p style="margin-top: 18px;"><a href="${voucher.approveLink}" style="display:inline-block;background:#059669;color:#ffffff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600;">✓ Approve this JCC</a><span style="color:#888;font-size:12px;">&nbsp; (opens a confirmation page)</span></p>` : ''}
            <p>
                <a href="#" style="color: #0066CC; text-decoration: none; font-weight: 600;">Open Task</a>
                &nbsp;|&nbsp;
                <a href="#" style="color: #0066CC; text-decoration: none; font-weight: 600;">Open BPM</a>
                <span style="color: #888; font-size: 12px;"> (Link to access the portal directly)</span>
            </p>
        `)
    }),

    // Sent to Creator on approval (level 1 or final)
    jccApprovedCreator: (voucher, approver, level) => ({
        subject: `${voucher.voucherRequestId} has been ${level === 'Final Approver' ? 'successfully approved' : 'approved at Level 1'}`,
        html: emailWrapper(`
            <p>
                <strong>${voucher.voucherRequestId}</strong> has been
                <strong>${level === 'Final Approver' ? 'successfully approved' : 'approved at Level 1 by the Manager'}</strong>.
                ${level !== 'Final Approver' ? 'It is now pending <strong>Final Approval</strong>.' : `Please follow the link to view: <a href="#" style="color: #0066CC;">${voucher.voucherRequestId}</a>`}
            </p>
            <p>Its details are as follows:</p>
            ${detailsTable(voucher)}
            ${level === 'Final Approver' ? `
            <p style="margin-top: 16px;">
                Please submit the print received along with Original Invoice to SCM for further process.
            </p>` : ''}
        `)
    }),

    // Sent to Initiator and Manager after final approval
    jccFinalApprovedNotice: (voucher, finalApprover) => ({
        subject: `${voucher.voucherRequestId} has been successfully approved by ${finalApprover?.name || voucher.approver2Name || 'Final Approver'}`,
        html: emailWrapper(`
            <p>
                <strong>${voucher.voucherRequestId}</strong> has been successfully approved by
                <strong>${finalApprover?.name || voucher.approver2Name || 'Final Approver'}</strong>.<br/>
                Please follow the link to view: <a href="${getJccLink(voucher)}" style="color: #0066CC;">${getJccDisplayId(voucher)}</a>
            </p>
            <p>Its details are as follows:</p>
            ${detailsTable(voucher)}
        `)
    }),

    // Sent to Approver as confirmation of their action
    jccApprovedApprover: (voucher, approver, level) => ({
        subject: `Confirmation: You have approved ${voucher.voucherRequestId}`,
        html: emailWrapper(`
            <p>Dear <strong>${approver.name}</strong>,</p>
            <p>
                This is a confirmation that <strong>${voucher.voucherRequestId}</strong> has been
                <strong>approved by you</strong> as <strong>${level}</strong>.
            </p>
            <p>Its details are as follows:</p>
            ${detailsTable(voucher)}
        `)
    }),

    // Sent to Creator on rejection (level 1 or final)
    jccRejectedCreator: (voucher, rejector, level, remarks) => ({
        subject: `${voucher.voucherRequestId} has been Rejected`,
        html: emailWrapper(`
            <p>
                <strong>${voucher.voucherRequestId}</strong> submitted by
                <strong>${voucher.claimedBy || '-'}</strong> has been
                <strong style="color: #DC2626;">rejected</strong> at <strong>${level}</strong> by <strong>${rejector.name}</strong>.
            </p>
            <p>Its details are as follows:</p>
            ${detailsTable(voucher)}
            ${remarks ? `
            <div style="background: #FEF2F2; border-left: 4px solid #EF4444; padding: 12px 16px; margin-top: 12px; border-radius: 0 4px 4px 0;">
                <strong style="color: #991B1B;">Rejection Remarks:</strong>
                <p style="margin: 4px 0 0 0; color: #7F1D1D;">${remarks}</p>
            </div>` : ''}
            <p style="margin-top: 16px;">Please review the remarks and resubmit the JCC after making the necessary corrections.</p>
        `)
    }),

    // Legacy aliases
    voucherCreated: (voucher, creator) => emailTemplates.jccCreatedApprover1(voucher, creator),
    voucherApproved: (voucher, approver, level) => emailTemplates.jccApprovedCreator(voucher, approver, level),
    voucherRejected: (voucher, rejector, level, remarks) => emailTemplates.jccRejectedCreator(voucher, rejector, level, remarks),

    jccApprovalReminder: (voucher, recipient, levelLabel) => ({
        subject: `[Reminder] ${voucher.voucherRequestId} is pending ${levelLabel} approval`,
        html: emailWrapper(`
            <p>Dear <strong>${recipient.name || 'Approver'}</strong>,</p>
            <p>
                This is a reminder that <strong>${voucher.voucherRequestId}</strong> is still pending
                <strong>${levelLabel}</strong> approval.
            </p>
            <p>Its details are as follows:</p>
            ${detailsTable(voucher)}
            <p>
                Kindly review and take action at the earliest.
            </p>
        `)
    }),

    // ─── Printing Module ──────────────────────────────────────────────────────
    printJobSubmitted: (pj) => ({
        subject: `New Printing Job ${pj.jobNumber} awaiting verification`,
        html: emailWrapper(`
            <p>A new printing job has been submitted and is awaiting your verification.</p>
            ${printDetailsTable(pj)}
            <p style="color:#555;">Please review it in the Printing Coordinator screen.</p>
            ${printPortalLink()}
        `)
    }),
    printJobAccepted: (pj) => ({
        subject: `Printing Job ${pj.jobNumber} accepted`,
        html: emailWrapper(`
            <p>Dear <strong>${pj.requestorName || 'Requestor'}</strong>,</p>
            <p><strong>${pj.jobNumber}</strong> has been <strong>accepted</strong> and added to the print queue.</p>
            ${printDetailsTable(pj)}
            ${printPortalLink()}
        `)
    }),
    printJobReturned: (pj) => ({
        subject: `Printing Job ${pj.jobNumber} returned for correction`,
        html: emailWrapper(`
            <p>Dear <strong>${pj.requestorName || 'Requestor'}</strong>,</p>
            <p><strong>${pj.jobNumber}</strong> has been <strong>returned</strong> for correction.</p>
            <p style="background:#FFF7ED;border:1px solid #FDBA74;border-radius:6px;padding:10px 14px;color:#9A3412;"><strong>Reason:</strong> ${pj.reason || '-'}</p>
            ${printDetailsTable(pj)}
            <p>Please edit and resubmit it — it keeps the same job number.</p>
            ${printPortalLink()}
        `)
    }),
    printJobRejected: (pj) => ({
        subject: `Printing Job ${pj.jobNumber} rejected`,
        html: emailWrapper(`
            <p>Dear <strong>${pj.requestorName || 'Requestor'}</strong>,</p>
            <p><strong>${pj.jobNumber}</strong> has been <strong>rejected</strong>.</p>
            <p style="background:#FEF2F2;border:1px solid #FCA5A5;border-radius:6px;padding:10px 14px;color:#7F1D1D;"><strong>Reason:</strong> ${pj.reason || '-'}</p>
            ${printDetailsTable(pj)}
            ${printPortalLink()}
        `)
    }),
    printJobAssignedOperator: (pj) => ({
        subject: `Print Job ${pj.jobNumber} assigned to you`,
        html: emailWrapper(`
            <p>Dear <strong>${pj.operatorName || 'Operator'}</strong>,</p>
            <p><strong>${pj.jobNumber}</strong> has been assigned to you for printing.</p>
            ${printDetailsTable(pj)}
            <p style="color:#555;">Open the Operator screen to start printing.</p>
            ${printPortalLink()}
        `)
    }),
    printJobReady: (pj) => ({
        subject: `Printing Job ${pj.jobNumber} is ready for collection`,
        html: emailWrapper(`
            <p>Dear <strong>${pj.requestorName || 'Requestor'}</strong>,</p>
            <p><strong>${pj.jobNumber}</strong> is <strong>ready for collection</strong>.</p>
            ${printDetailsTable(pj)}
            ${printPortalLink()}
        `)
    }),
    printJobCompleted: (pj) => ({
        subject: `Printing Job ${pj.jobNumber} completed`,
        html: emailWrapper(`
            <p>Dear <strong>${pj.requestorName || 'Requestor'}</strong>,</p>
            <p><strong>${pj.jobNumber}</strong> has been collected and closed. Thank you.</p>
            ${printDetailsTable(pj)}
        `)
    }),
};

// ─── Send Email ───────────────────────────────────────────────────────────────

export const sendEmail = async (to, templateFn, templateArgs, meta = {}) => {
    // Validate recipient email
    if (!isValidEmail(to)) {
        console.warn(`[Email] Invalid recipient email address: "${to}" — skipping`);
        logEmailEvent({
            recipient: to,
            subject: null,
            templateName: meta.templateName || null,
            entityType: meta.entityType || 'jcc',
            entityId: meta.entityId || null,
            status: 'failed',
            errorMessage: 'Invalid email address',
        });
        return { success: false, message: 'Invalid email address' };
    }

    const transporter = createTransporter();

    if (!transporter) {
        console.log('[Email] Transporter not configured. Skipping email send.');
        logEmailEvent({
            recipient: to,
            templateName: meta.templateName || null,
            entityType: meta.entityType || 'jcc',
            entityId: meta.entityId || null,
            status: 'failed',
            errorMessage: 'Transporter not configured',
        });
        return { success: false, message: 'Email not configured' };
    }

    try {
        const emailContent = templateFn(...templateArgs);

        const mailOptions = {
            from: `"InFloAI System" <${SENDER_ADDRESS}>`,
            to,
            subject: emailContent.subject,
            html: emailContent.html,
            attachments: Array.isArray(meta.attachments) ? meta.attachments : undefined
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] Sent to ${to}: ${info.messageId}`);

        logEmailEvent({
            recipient: to,
            subject: emailContent.subject,
            templateName: meta.templateName || null,
            entityType: meta.entityType || 'jcc',
            entityId: meta.entityId || null,
            status: 'sent',
            messageId: info.messageId,
        });

        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error(`[Email] Error sending to ${to}:`, error.message);

        logEmailEvent({
            recipient: to,
            subject: null,
            templateName: meta.templateName || null,
            entityType: meta.entityType || 'jcc',
            entityId: meta.entityId || null,
            status: 'failed',
            errorMessage: error.message,
        });

        return { success: false, error: error.message };
    }
};

// ─── Notification Functions ───────────────────────────────────────────────────

export const notifyVoucherCreated = async (voucher, creator, approver1, approver2) => {
    console.log(`[Email] JCC Created notifications for ${voucher.voucherRequestId}`);
    const meta = { entityType: 'jcc', entityId: voucher.voucherRequestId };
    const results = [];

    if (creator?.email) {
        results.push(await sendEmail(creator.email, emailTemplates.jccCreatedCreator, [voucher, creator], { ...meta, templateName: 'jccCreatedCreator' }));
    }
    if (approver1?.email) {
        results.push(await sendEmail(approver1.email, emailTemplates.jccCreatedApprover1, [voucher, creator], { ...meta, templateName: 'jccCreatedApprover1' }));
    }

    return results;
};

export const notifyVoucherApproved = async (voucher, approver, creator, level, manager = null) => {
    console.log(`[Email] JCC Approval (${level}) notifications for ${voucher.voucherRequestId}`);
    const meta = { entityType: 'jcc', entityId: voucher.voucherRequestId };
    const results = [];

    if (level === 'Final Approver') {
        if (creator?.email) {
            results.push(await sendEmail(creator.email, emailTemplates.jccFinalApprovedNotice, [voucher, approver], { ...meta, templateName: 'jccFinalApprovedNotice' }));
        }
        if (manager?.email && manager.email !== creator?.email) {
            results.push(await sendEmail(manager.email, emailTemplates.jccFinalApprovedNotice, [voucher, approver], { ...meta, templateName: 'jccFinalApprovedNotice' }));
        }
    } else if (creator?.email) {
        results.push(await sendEmail(creator.email, emailTemplates.jccApprovedCreator, [voucher, approver, level], { ...meta, templateName: 'jccApprovedCreator' }));
    }

    if (approver?.email) {
        results.push(await sendEmail(approver.email, emailTemplates.jccApprovedApprover, [voucher, approver, level], { ...meta, templateName: 'jccApprovedApprover' }));
    }

    return results;
};

export const notifyNextApprover = async (voucher, creator, nextApprover) => {
    console.log(`[Email] Pending Final Approval notification for ${voucher.voucherRequestId}`);
    if (nextApprover?.email) {
        return await sendEmail(nextApprover.email, emailTemplates.jccPendingFinalApproval, [voucher, creator], {
            entityType: 'jcc', entityId: voucher.voucherRequestId, templateName: 'jccPendingFinalApproval'
        });
    }
    return null;
};

export const notifyVoucherRejected = async (voucher, rejector, creator, level, remarks) => {
    console.log(`[Email] JCC Rejected (${level}) notification for ${voucher.voucherRequestId}`);
    if (!creator?.email) {
        console.log('[Email] Creator email not available, skipping rejection email');
        return { success: false, message: 'No creator email' };
    }
    return await sendEmail(creator.email, emailTemplates.jccRejectedCreator, [voucher, rejector, level, remarks], {
        entityType: 'jcc', entityId: voucher.voucherRequestId, templateName: 'jccRejectedCreator'
    });
};

export const notifyJccApprovalReminder = async (voucher, recipients, levelLabel) => {
    const uniqueRecipients = Array.isArray(recipients)
        ? recipients.filter((recipient, index, arr) => {
            if (!recipient?.email) return false;
            return arr.findIndex((item) => item?.email === recipient.email) === index;
        })
        : [];

    const results = [];
    for (const recipient of uniqueRecipients) {
        results.push(await sendEmail(recipient.email, emailTemplates.jccApprovalReminder, [voucher, recipient, levelLabel], {
            entityType: 'jcc', entityId: voucher.voucherRequestId, templateName: 'jccApprovalReminder'
        }));
    }
    return results;
};

// ─── Printing Module notifications ────────────────────────────────────────────
// Each returns a promise; callers may fire-and-forget. `to` may be a single email
// or an array; invalid/empty recipients are skipped by sendEmail.
const sendToMany = async (recipients, templateFn, pj, templateName) => {
    const list = (Array.isArray(recipients) ? recipients : [recipients]).filter(Boolean);
    const seen = new Set();
    const results = [];
    for (const email of list) {
        const key = String(email).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(await sendEmail(email, templateFn, [pj], { entityType: 'print_job', entityId: pj.jobNumber, templateName }));
    }
    return results;
};

export const notifyPrintJobSubmitted = (pj, coordinatorEmails) => sendToMany(coordinatorEmails, emailTemplates.printJobSubmitted, pj, 'printJobSubmitted');
export const notifyPrintJobAccepted = (pj, requestorEmail) => sendToMany(requestorEmail, emailTemplates.printJobAccepted, pj, 'printJobAccepted');
export const notifyPrintJobReturned = (pj, requestorEmail) => sendToMany(requestorEmail, emailTemplates.printJobReturned, pj, 'printJobReturned');
export const notifyPrintJobRejected = (pj, requestorEmail) => sendToMany(requestorEmail, emailTemplates.printJobRejected, pj, 'printJobRejected');
export const notifyPrintJobAssigned = (pj, operatorEmail) => sendToMany(operatorEmail, emailTemplates.printJobAssignedOperator, pj, 'printJobAssignedOperator');
export const notifyPrintJobReady = (pj, recipients) => sendToMany(recipients, emailTemplates.printJobReady, pj, 'printJobReady');
export const notifyPrintJobCompleted = (pj, requestorEmail) => sendToMany(requestorEmail, emailTemplates.printJobCompleted, pj, 'printJobCompleted');

export default {
    sendEmail,
    isValidEmail,
    notifyVoucherCreated,
    notifyVoucherApproved,
    notifyNextApprover,
    notifyVoucherRejected,
    notifyJccApprovalReminder,
    notifyPrintJobSubmitted,
    notifyPrintJobAccepted,
    notifyPrintJobReturned,
    notifyPrintJobRejected,
    notifyPrintJobAssigned,
    notifyPrintJobReady,
    notifyPrintJobCompleted,
    emailTemplates
};
