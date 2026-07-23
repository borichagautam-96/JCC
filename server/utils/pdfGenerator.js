import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ================= NUMBER TO WORDS ================= */
const numberToWords = (num) => {
    const ones = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE"];
    const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
    const teens = ["TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];

    const conv = (n) => {
        let s = "";
        if (n >= 100) { s += ones[Math.floor(n / 100)] + " HUNDRED "; n %= 100; }
        if (n >= 20) { s += tens[Math.floor(n / 10)] + " "; n %= 10; }
        else if (n >= 10) return s + teens[n - 10] + " ";
        if (n > 0) s += ones[n] + " ";
        return s;
    };

    let r = Math.floor(+num || 0), out = "";
    if (r >= 10000000) { out += conv(r / 10000000 | 0) + "CRORE "; r %= 10000000; }
    if (r >= 100000) { out += conv(r / 100000 | 0) + "LAKH "; r %= 100000; }
    if (r >= 1000) { out += conv(r / 1000 | 0) + "THOUSAND "; r %= 1000; }
    if (r > 0) out += conv(r);
    return "Rs." + (out.trim() || "ZERO") + " ONLY";
};

/* ================= GENERATOR ================= */
export const generateJCCPDF = (d, out) =>
    new Promise((res, rej) => {

        const doc = new PDFDocument({ size: "A4", margin: 40 });
        const stream = fs.createWriteStream(out);
        doc.pipe(stream);

        const W = 515, L = 40;
        let y = 75;
        let tx = L;

        /* ---------- HEADER ---------- */
        const drawHeader = () => {
            const logoSize = 30;
            const logoPath = path.join(__dirname, '../../src/assets/lt-logo.png');
            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, L, 18, { width: logoSize, height: logoSize });
            }
            const textStartX = L + logoSize + 10;
            doc.fillColor('black');
            doc.font("Helvetica-Bold").fontSize(12).text("L&T Precision Engineering and Systems", textStartX, 20);
            doc.font("Helvetica-Oblique").fontSize(8).text("A Brand of Larsen & Toubro Limited", textStartX, 35);

            const titleText = d.voucher_number ? `JCC No. ${d.voucher_number}` : "JCC REQUEST";
            doc.font("Helvetica-Bold").fontSize(12).text(titleText, L + 280, 20, { width: W - 280, align: 'right' });
        };

        doc.on('pageAdded', drawHeader);
        drawHeader(); // Draw on the first page immediately

        // Helper to check and handle page breaks
        const checkPageBreak = (neededHeight) => {
            if (y + neededHeight > 780) { // A4 height is 841.89, giving some bottom padding
                doc.addPage();
                y = 75; // reset below header
            }
        };

        // Helper for 2-column row (Label | Value)
        const row2Col = (lbl, val, h = 18, lblW = 150) => {
            checkPageBreak(h);
            doc.rect(L, y, lblW, h).stroke();
            doc.rect(L + lblW, y, W - lblW, h).stroke();
            doc.font("Helvetica-Bold").fontSize(8).text(lbl, L + 4, y + 5);
            doc.font("Helvetica").fontSize(8).text(val, L + lblW + 4, y + 5);
            y += h;
        };

        // Dynamic row for wrapped value text to prevent overlap on long strings.
        const row2ColWrapped = (lbl, val, minH = 18, lblW = 150) => {
            const valueText = String(val || "");
            const valueX = L + lblW + 4;
            const valueW = W - lblW - 8;

            doc.font("Helvetica").fontSize(8);
            const valueTextHeight = doc.heightOfString(valueText, { width: valueW, align: 'left' });
            const h = Math.max(minH, Math.ceil(valueTextHeight) + 10);

            checkPageBreak(h);
            doc.rect(L, y, lblW, h).stroke();
            doc.rect(L + lblW, y, W - lblW, h).stroke();
            doc.font("Helvetica-Bold").fontSize(8).text(lbl, L + 4, y + 5);
            doc.font("Helvetica").fontSize(8).text(valueText, valueX, y + 5, { width: valueW, align: 'left' });
            y += h;
        };

        // Removed duplicate JCC No row since it is now in the header title

        // Company Address (full width)
        checkPageBreak(18);
        doc.rect(L, y, W, 18).stroke();
        doc.fontSize(7).font("Helvetica")
            .text("The Larsen & Toubro (L&T) Innovation Campus, Gate No. 1, Saki Vihar Rd, Krishna Nagar, Powai, Mumbai, Maharashtra 400072, India.",
                L + 6, y + 6, { width: W - 12 });
        y += 18;

        y += 5; // Spacing

        /* ---------- INITIATOR'S DETAIL ---------- */
        // Helper for section headers
        const section = (t) => {
            checkPageBreak(18);
            doc.rect(L, y, W, 18).fillAndStroke("#e0e0e0", "#000");
            doc.fillColor("#000").fontSize(9).font("Helvetica-Bold").text(t, L + 6, y + 5);
            y += 18;
        };

        section("INITIATOR'S DETAIL");

        // 4-column grid row helper (Lbl | Val | Lbl | Val)
        const row4Col = (l1, v1, l2, v2, h = 18) => {
            const w1 = 120;
            const w2 = 137;
            const w3 = 130;
            const w4 = 128;

            checkPageBreak(h);
            let cx = L;
            doc.rect(cx, y, w1, h).stroke();
            doc.font("Helvetica-Bold").fontSize(8).text(l1, cx + 4, y + 5);
            cx += w1;
            doc.rect(cx, y, w2, h).stroke();
            doc.font("Helvetica").fontSize(8).text(v1 || "", cx + 4, y + 5);
            cx += w2;
            doc.rect(cx, y, w3, h).stroke();
            doc.font("Helvetica-Bold").fontSize(8).text(l2, cx + 4, y + 5);
            cx += w3;
            doc.rect(cx, y, w4, h).stroke();
            doc.font("Helvetica").fontSize(8).text(v2 || "", cx + 4, y + 5);

            y += h;
        };

        // 2-column row in the initiator section (full width split in half)
        const row2ColInitiator = (l1, v1, l2, v2, h = 18) => {
            const half = W / 2;
            const lblW = 120;
            checkPageBreak(h);
            let cx = L;
            // Left cell label
            doc.rect(cx, y, lblW, h).stroke();
            doc.font("Helvetica-Bold").fontSize(8).text(l1, cx + 4, y + 5);
            cx += lblW;
            // Left cell value
            doc.rect(cx, y, half - lblW, h).stroke();
            doc.font("Helvetica").fontSize(8).text(v1 || "", cx + 4, y + 5);
            cx = L + half;
            // Right cell label
            doc.rect(cx, y, lblW, h).stroke();
            doc.font("Helvetica-Bold").fontSize(8).text(l2, cx + 4, y + 5);
            cx += lblW;
            // Right cell value
            doc.rect(cx, y, W - half - lblW, h).stroke();
            doc.font("Helvetica").fontSize(8).text(v2 || "", cx + 4, y + 5);
            y += h;
        };

        row4Col("NAME", d.claimed_by, "PS NO.", d.ps_number);
        // SBU NO. removed — now show DEPT and EXPENSE BOOKING LOCATION in this row
        row4Col("DEPT.", d.department, "EXPENSE BOOKING LOCATION", d.expense_booking_location);
        row4Col("CLAIMED DATE", d.claimed_date, "DEPT CODE", d.dept_code);

        y += 5; // Spacing

        /* ---------- INVOICE & DESCRIPTION ---------- */
        section("INVOICE DETAILS");
        row4Col("INVOICE NO.", d.invoice_no, "INVOICE DATE", d.invoice_date);
        row4Col("NATURE OF EXPENSES", d.nature_of_expenses, "SERVICE CATEGORY", d.service_category);

        // Remark Row (2 Col) — shows the voucher-level remark/description
        row2ColWrapped("REMARK", d.description || "", 30, 120);

        y += 5;

        /* ---------- ITEMS TABLE ----------
           Removed: LEDGER ACCOUNT, ENTERPRISE UNIT, CSR PROJECT, EXCISE EXEMPT, EMPLOYEE, DEPT
           Kept/Added: SR.No, DESCRIPTION OF MATERIAL, DEPT CODE, PROJECT, PROJECT CODE, AMOUNT
           Total W = 515
        */
        const iCols = [
            { h: "SR.\nNo.", w: 25 },
            { h: "DESCRIPTION OF\nMATERIAL", w: 180 },
            { h: "DEPT\nCODE", w: 60 },
            { h: "PROJECT\nNAME", w: 75 },
            { h: "PROJECT\nCODE", w: 75 },
            { h: "AMOUNT", w: 100 }
        ];

        // Header
        const hHeight = 30;

        // Ensure enough space for header AND at least one row
        checkPageBreak(hHeight + 25);
        doc.rect(L, y, W, hHeight).fillAndStroke("#e0e0e0", "#000");

        tx = L;
        doc.fillColor("#000").font("Helvetica-Bold").fontSize(8);
        iCols.forEach(col => {
            doc.rect(tx, y, col.w, hHeight).stroke();
            doc.text(col.h, tx + 2, y + 4, { width: col.w - 4, align: 'center' });
            tx += col.w;
        });
        y += hHeight;

        // Item Rows
        doc.font("Helvetica").fontSize(8);
        const itemsToRender = (d.items && d.items.length) ? d.items : [{}, {}];

        itemsToRender.forEach((it, idx) => {
            // Calculate dynamic row height based on the description text length
            const descText = String(it.description_of_material || '');
            const descW = iCols[1].w - 8; // column width minus padding
            doc.font('Helvetica').fontSize(8);
            const descH = descText ? doc.heightOfString(descText, { width: descW }) : 0;
            const rowH = Math.max(25, Math.ceil(descH) + 10);

            const vals = [
                idx + 1,
                descText,
                it.dept_code || '',
                it.project || '',
                it.project_code || '',
                it.amount || ''
            ];

            if (y + rowH > 780) {
                doc.addPage();
                y = 75;
                // Redraw table header
                doc.rect(L, y, W, hHeight).fillAndStroke('#e0e0e0', '#000');
                tx = L;
                doc.fillColor('#000').font('Helvetica-Bold').fontSize(6);
                iCols.forEach(col => {
                    doc.rect(tx, y, col.w, hHeight).stroke();
                    doc.text(col.h, tx + 2, y + 4, { width: col.w - 4, align: 'center' });
                    tx += col.w;
                });
                y += hHeight;
            }

            tx = L;
            doc.fillColor('#000').font('Helvetica').fontSize(8);
            vals.forEach((v, i) => {
                doc.rect(tx, y, iCols[i].w, rowH).stroke();
                // Description column: left-align for readability; others: centre
                const align = i === 1 ? 'left' : 'center';
                const xPad = i === 1 ? tx + 4 : tx + 2;
                doc.text(String(v), xPad, y + 6, {
                    width: iCols[i].w - (i === 1 ? 8 : 4),
                    align,
                });
                tx += iCols[i].w;
            });
            y += rowH;
        });

        y += 5;

        /* ---------- SUPPLIER & TOTALS ---------- */
        const lblW = 180;

        row2Col("SUPPLIER CODE :", d.supplier_code, 18, lblW);
        row2Col("SUPPLIER NAME :", d.supplier_name, 18, lblW);

        // Address (multiline)
        const addrH = 50;
        checkPageBreak(addrH);
        doc.rect(L, y, lblW, addrH).stroke();
        doc.rect(L + lblW, y, W - lblW, addrH).stroke();
        doc.font("Helvetica-Bold").fontSize(8).text("SUPPLIER ADDRESS :", L + 4, y + 5);
        doc.font("Helvetica").fontSize(8).text(d.supplier_address || "", L + lblW + 4, y + 5, { width: W - lblW - 8 });
        y += addrH;

        row2Col("PO NO. :", d.po_number || "", 18, lblW);
        row2Col("PO DATE :", d.po_date || "", 18, lblW);
        row2Col("PO AMOUNT :", d.po_amount ? Number(d.po_amount).toFixed(2) : "", 18, lblW);

        row2Col("BASIC AMOUNT(IN INR) :", Number(d.basic_amount).toFixed(2), 18, lblW);
        row2ColWrapped("BASIC AMOUNT(IN WORDS) :", numberToWords(d.basic_amount), 18, lblW);
        row2Col("GROSS AMOUNT(IN INR) :", Number(d.gross_amount).toFixed(2), 18, lblW);
        row2ColWrapped("GROSS AMOUNT(IN WORDS) :", numberToWords(d.gross_amount), 22, lblW);

        y += 20;

        /* ---------- ACTION HISTORY ---------- */
        const actCols = [
            { h: "ACTION BY", w: 100 },
            { h: "PERSON", w: 160 },
            { h: "PSNO.", w: 60 },
            { h: "ACTION", w: 90 },
            { h: "ACTION DATE", w: 105 }
        ];

        const ahHeight = 18;
        tx = L;
        doc.fillColor("#000");

        // Ensure enough space for header AND at least one row
        checkPageBreak(ahHeight + 18);
        doc.rect(L, y, W, ahHeight).fillAndStroke("#e0e0e0", "#000");

        tx = L;
        doc.fillColor("#000").font("Helvetica-Bold").fontSize(8);
        actCols.forEach(col => {
            doc.rect(tx, y, col.w, ahHeight).stroke();
            doc.text(col.h, tx + 4, y + 6, { width: col.w - 8, align: 'left' });
            tx += col.w;
        });
        y += ahHeight;

        doc.font("Helvetica").fontSize(8);
        if (d.actions && d.actions.length) {
            d.actions.forEach(act => {
                const actionBy = (act.action_by || "").toUpperCase()
                    .replace("FIRST APPROVER", "REVIEWER")
                    .replace("SECOND APPROVER", "APPROVER");

                const aVals = [
                    actionBy,
                    String(act.person || "").toUpperCase(),
                    String(act.psno || "-").toUpperCase(),
                    String(act.action || "").toUpperCase(),
                    String(act.date || "").toUpperCase()
                ];

                const rH = 18;

                if (y + rH > 780) {
                    doc.addPage();
                    y = 75;
                    // Redraw Action History header
                    doc.rect(L, y, W, ahHeight).fillAndStroke("#e0e0e0", "#000");
                    tx = L;
                    doc.fillColor("#000").font("Helvetica-Bold").fontSize(8);
                    actCols.forEach(col => {
                        doc.rect(tx, y, col.w, ahHeight).stroke();
                        doc.text(col.h, tx + 4, y + 6, { width: col.w - 8, align: 'left' });
                        tx += col.w;
                    });
                    y += ahHeight;
                }

                tx = L;
                doc.fillColor("#000").font("Helvetica").fontSize(8);
                aVals.forEach((v, i) => {
                    doc.rect(tx, y, actCols[i].w, rH).stroke();
                    doc.text(String(v), tx + 4, y + 5, {
                        width: actCols[i].w - 8,
                        align: 'left'
                    });
                    tx += actCols[i].w;
                });
                y += rH;
            });
        }

        y += 15;
        checkPageBreak(15);
        doc.fillColor("#000").font("Helvetica-Bold").fontSize(10);
        doc.text("This document has been digitally signed and does not require a handwritten signature.", L, y, { width: W, align: 'center' });

        doc.end();

        stream.on("finish", () => res(out));
        stream.on("error", rej);
        doc.on("error", rej);
    });
