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
        let y = 40;
        let tx = L;

        /* ---------- HEADER ---------- */
        // Logo on the far left (actual L&T logo)
        const logoSize = 30;
        const logoX = L;
        const logoY = y;

        // Load and embed the L&T logo image
        const logoPath = path.join(__dirname, '../../src/assets/lt-logo.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, logoX, logoY - 22, { width: logoSize, height: logoSize });
        }

        // Company Name and Tagline (next to logo)
        const textStartX = logoX + logoSize + 10;
        doc.fillColor('black');
        doc.font("Helvetica-Bold").fontSize(12).text("L&T Precision Engineering and Systems", textStartX, y - 20);
        doc.font("Helvetica-Oblique").fontSize(8).text("A Brand of Larsen & Toubro Limited", textStartX, y - 5);

        // Right: Title
        doc.font("Helvetica-Bold").fontSize(12).text("                                         JCC REQUEST", L + 280, y - 20);
        y += 35;

        // Helper for 2-column row (Label | Value)
        const row2Col = (lbl, val, h = 18, lblW = 150) => {
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

            doc.rect(L, y, lblW, h).stroke();
            doc.rect(L + lblW, y, W - lblW, h).stroke();
            doc.font("Helvetica-Bold").fontSize(8).text(lbl, L + 4, y + 5);
            doc.font("Helvetica").fontSize(8).text(valueText, valueX, y + 5, { width: valueW, align: 'left' });
            y += h;
        };

        // JCC Number Row (was VOUCHER NO.)
        row2Col("JCC No.", d.voucher_number);

        // Company Address (full width)
        doc.rect(L, y, W, 18).stroke();
        doc.fontSize(7).font("Helvetica")
            .text("LARSEN AND TOUBRO LIMITED PES IC,SAKI VIHAR ROAD, POWAI,GATE NO. 1-G4,MUMBAI MAHARASHTRA,INDIA 400072",
                L + 6, y + 6, { width: W - 12 });
        y += 18;

        y += 5; // Spacing

        /* ---------- INITIATOR'S DETAIL ---------- */
        // Helper for section headers
        const section = (t) => {
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

            let cx = L;
            doc.rect(cx, y, w1, h).stroke();
            doc.font("Helvetica-Bold").fontSize(8).text(l1, cx + 4, y + 5);
            cx += w1;
            doc.rect(cx, y, w2, h).stroke();
            doc.font("Helvetica").fontSize(8).text(v1 || "", cx + 4, y + 5);
            cx += w2;
            doc.rect(cx, y, w3, h).stroke();
            doc.font("Helvetica-Bold").fontSize(6).text(l2, cx + 4, y + 5);
            cx += w3;
            doc.rect(cx, y, w4, h).stroke();
            doc.font("Helvetica").fontSize(8).text(v2 || "", cx + 4, y + 5);

            y += h;
        };

        // 2-column row in the initiator section (full width split in half)
        const row2ColInitiator = (l1, v1, l2, v2, h = 18) => {
            const half = W / 2;
            const lblW = 120;
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
            doc.font("Helvetica-Bold").fontSize(6).text(l2, cx + 4, y + 5);
            cx += lblW;
            // Right cell value
            doc.rect(cx, y, W - half - lblW, h).stroke();
            doc.font("Helvetica").fontSize(8).text(v2 || "", cx + 4, y + 5);
            y += h;
        };

        row4Col("CLAIMED BY", d.claimed_by, "PS NO.", d.ps_number);
        // SBU NO. removed — now show DEPT and EXPENSE BOOKING LOCATION in this row
        row4Col("DEPT.", d.department, "EXPENSE BOOKING LOCATION", d.expense_booking_location);
        row2ColInitiator("CLAIMED DATE", d.claimed_date, "", "");

        y += 5; // Spacing

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

        doc.rect(L, y, W, ahHeight).fillAndStroke("#e0e0e0", "#000");

        tx = L;
        doc.fillColor("#000").font("Helvetica-Bold").fontSize(7);
        actCols.forEach(col => {
            doc.rect(tx, y, col.w, ahHeight).stroke();
            doc.text(col.h, tx + 4, y + 6, { width: col.w - 8, align: 'left' });
            tx += col.w;
        });
        y += ahHeight;

        doc.font("Helvetica").fontSize(7);
        if (d.actions && d.actions.length) {
            d.actions.forEach(act => {
                const aVals = [
                    (act.action_by || "").toUpperCase(),
                    (act.person || "").toUpperCase(),
                    act.psno || "-",
                    act.action || "",
                    act.date || ""
                ];

                const rH = 18;
                tx = L;

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

        y += 5;

        /* ---------- INVOICE & DESCRIPTION ---------- */
        row4Col("INVOICE NO.", d.invoice_no, "INVOICE DATE", d.invoice_date);
        row4Col("NATURE OF EXPENSES", d.nature_of_expenses, "SERVICE CATEGORY", d.service_category);

        // Description Row (2 Col)
        row2Col("DESCRIPTION", d.description || "", 30, 120);

        y += 5;

        /* ---------- ITEMS TABLE ----------
           Removed: LEDGER ACCOUNT, ENTERPRISE UNIT, CSR PROJECT, EXCISE EXEMPT, EMPLOYEE
           Kept/Added: SR.No, LOCATION, DEPT, DEPT CODE, PROJECT, PROJECT CODE, AMOUNT
           Total W = 515
        */
        const iCols = [
            { h: "SR.\nNo.", w: 25 },
            { h: "LOCATION", w: 65 },
            { h: "DEPT", w: 50 },
            { h: "DEPT\nCODE", w: 60 },
            { h: "PROJECT\nNAME", w: 75 },
            { h: "PROJECT\nCODE", w: 75 },
            { h: "AMOUNT", w: 165 }
        ];

        // Header
        const hHeight = 30;

        doc.rect(L, y, W, hHeight).fillAndStroke("#e0e0e0", "#000");

        tx = L;
        doc.fillColor("#000").font("Helvetica-Bold").fontSize(6);
        iCols.forEach(col => {
            doc.rect(tx, y, col.w, hHeight).stroke();
            doc.text(col.h, tx + 2, y + 4, { width: col.w - 4, align: 'center' });
            tx += col.w;
        });
        y += hHeight;

        // Item Rows
        doc.font("Helvetica").fontSize(7);
        const itemsToRender = (d.items && d.items.length) ? d.items : [{}, {}];

        itemsToRender.forEach((it, idx) => {
            const rowH = 25;
            const vals = [
                idx + 1,
                it.loc || "",
                it.dept || "",
                it.dept_code || "",
                it.project || "",
                it.project_code || "",
                it.amount || ""
            ];

            tx = L;
            vals.forEach((v, i) => {
                doc.rect(tx, y, iCols[i].w, rowH).stroke();
                doc.text(String(v), tx + 2, y + 8, {
                    width: iCols[i].w - 4,
                    align: 'center'
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

        /* ---------- FOOTER ---------- */
        doc.rect(L, y, W, 40).stroke();
        doc.font("Helvetica-Bold").fontSize(8).text("INITIATOR'S SIGNATURE", L + 4, y + 4);

        doc.end();

        stream.on("finish", () => res(out));
        stream.on("error", rej);
        doc.on("error", rej);
    });
