// Comparing two submissions of the same printing request.
//
// A job can be submitted more than once: the requestor recalls it to fix something,
// or the coordinator returns it for correction. On the resubmit, whoever verifies it
// should not have to re-read the whole form to find what moved. This produces that
// list of differences.
//
// The awkward part is matching documents across two snapshots. A document has no
// stable id from the requestor's point of view — they may rename it, replace its
// PDF, reorder the list, or delete one and add another. Matching purely by name
// reports a rename as one removal plus one addition, which reads like far more
// churn than actually happened. So: match by name, then by identical PDF hash
// (catches a pure rename), then by position.

// Request fields the requestor can actually edit. Dispatch, receipt and approval
// columns are deliberately absent — those are set later by other roles and are not
// part of "what the requestor changed".
export const HEADER_FIELDS = [
    ['employee_name', 'Requestor name'],
    ['employee_id', 'Employee ID'],
    ['department_name', 'Department'],
    ['department_code', 'Department code'],
    ['debit_code', 'Debit code'],
    ['project_name', 'Project'],
    ['dt_number', 'DT number'],
    ['request_date', 'Request date'],
    ['location_id', 'Location'],
    ['shipset_batch', 'Shipset / batch'],
    ['classification', 'Classification'],
    ['number_of_pages', 'Declared page count'],
    ['lead_name', 'Lead'],
    ['edc', 'EDC'],
    ['recipient_name', 'Recipient'],
    ['recipient_contact', 'Recipient contact'],
    ['recipient_address', 'Recipient address'],
    ['vl_review', 'VL review'],
    ['pre_printing_checklist', 'Pre-printing checklist'],
    ['purpose', 'Purpose'],
    ['printing_form_available', 'Printing form available'],
    ['remarks', 'Remarks'],
];

export const DOCUMENT_FIELDS = [
    ['quantity', 'Copies'],
    ['num_pages', 'Pages'],
    ['print_side', 'Side'],
    ['paper_size', 'Paper size'],
    ['paper_gsm', 'Paper (gsm)'],
    ['color_mode', 'Colour'],
    ['cover_page', 'Cover page'],
    ['soft_lamination', 'Soft lamination'],
    ['separators', 'Separators'],
    ['separator_thickness', 'Separator thickness'],
    ['hole_punch', 'Hole punch'],
    ['binding_type', 'Binding'],
    ['file_colour', 'File colour'],
    ['remarks', 'Remarks'],
];

// null, undefined, '' and '   ' all mean "not filled in" — moving between them is
// not a change the verifier needs to look at.
const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/** True when two stored values differ in a way worth reporting. */
export const changed = (a, b) => {
    if (blank(a) && blank(b)) return false;
    if (blank(a) !== blank(b)) return true;
    // "80" and 80 are the same paper weight; 0 and "0" the same flag.
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
        return na !== nb;
    }
    return String(a).trim() !== String(b).trim();
};

const show = (v) => (blank(v) ? '—' : String(v).trim());

/** Roll-ups: documents, total copies, total page-prints. Mirrors GET /:id/log. */
export const rollUps = (docs = []) => docs.reduce(
    (acc, d) => ({
        books: acc.books + 1,
        copies: acc.copies + (Number(d.quantity) || 0),
        pages: acc.pages + (Number(d.num_pages) || 0) * (Number(d.quantity) || 0),
    }),
    { books: 0, copies: 0, pages: 0 },
);

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Pair up documents between two snapshots. Returns { pairs, added, removed }.
 * Each pass removes what it consumed, so later passes only see leftovers.
 */
export const matchDocuments = (prevDocs = [], nextDocs = []) => {
    const left = [...prevDocs];
    const right = [...nextDocs];
    const pairs = [];

    const take = (predicate) => {
        for (let i = left.length - 1; i >= 0; i -= 1) {
            const j = right.findIndex((r) => predicate(left[i], r));
            if (j !== -1) {
                pairs.push({ prev: left[i], next: right[j] });
                left.splice(i, 1);
                right.splice(j, 1);
            }
        }
    };

    // 1. Same name — the ordinary case.
    take((a, b) => norm(a.document_name) === norm(b.document_name));
    // 2. Same PDF, different name — a rename, not a delete plus an add.
    take((a, b) => a.pdf_sha256 && b.pdf_sha256 && a.pdf_sha256 === b.pdf_sha256);
    // 3. Whatever is left, in order — a rename with a replaced file.
    while (left.length && right.length) {
        pairs.push({ prev: left.shift(), next: right.shift() });
    }

    return { pairs, removed: left, added: right };
};

/**
 * Compare two snapshots.
 * Each snapshot: { header: {...}, documents: [...] }.
 */
export const diffSubmissions = (prev, next) => {
    const prevHeader = prev?.header || {};
    const nextHeader = next?.header || {};
    const prevDocs = prev?.documents || [];
    const nextDocs = next?.documents || [];

    const headerChanges = [];
    for (const [field, label] of HEADER_FIELDS) {
        if (changed(prevHeader[field], nextHeader[field])) {
            headerChanges.push({ field, label, from: show(prevHeader[field]), to: show(nextHeader[field]) });
        }
    }

    const { pairs, added, removed } = matchDocuments(prevDocs, nextDocs);
    const documentChanges = [];

    for (const doc of added) {
        documentChanges.push({
            kind: 'added',
            documentName: doc.document_name || 'Untitled',
            pages: Number(doc.num_pages) || null,
            copies: Number(doc.quantity) || null,
            fieldChanges: [],
        });
    }
    for (const doc of removed) {
        documentChanges.push({
            kind: 'removed',
            documentName: doc.document_name || 'Untitled',
            pages: Number(doc.num_pages) || null,
            copies: Number(doc.quantity) || null,
            fieldChanges: [],
        });
    }
    for (const { prev: a, next: b } of pairs) {
        const fieldChanges = [];
        if (changed(a.document_name, b.document_name)) {
            fieldChanges.push({ field: 'document_name', label: 'Name', from: show(a.document_name), to: show(b.document_name) });
        }
        for (const [field, label] of DOCUMENT_FIELDS) {
            if (changed(a[field], b[field])) {
                fieldChanges.push({ field, label, from: show(a[field]), to: show(b[field]) });
            }
        }
        // The file itself, independent of its specs.
        const pdfReplaced = !!(a.pdf_sha256 && b.pdf_sha256 && a.pdf_sha256 !== b.pdf_sha256);
        if (pdfReplaced || fieldChanges.length) {
            documentChanges.push({
                kind: pdfReplaced && !fieldChanges.length ? 'pdf_replaced' : 'modified',
                documentName: b.document_name || a.document_name || 'Untitled',
                pdfReplaced,
                fieldChanges,
            });
        }
    }

    const before = rollUps(prevDocs);
    const after = rollUps(nextDocs);
    const totals = {};
    for (const key of ['books', 'copies', 'pages']) {
        totals[key] = { from: before[key], to: after[key], delta: after[key] - before[key] };
    }

    const changeCount = headerChanges.length
        + documentChanges.reduce((n, d) => n + Math.max(1, d.fieldChanges.length), 0);

    return {
        headerChanges,
        documentChanges,
        totals,
        changeCount,
        isNoOp: changeCount === 0,
    };
};

/** One-line summaries for an audit string or a compact timeline row. */
export const summariseDiff = (diff) => {
    if (!diff || diff.isNoOp) return 'no changes';
    const bits = [];
    const t = diff.totals || {};
    if (t.books?.delta) bits.push(`${t.books.delta > 0 ? '+' : ''}${t.books.delta} document${Math.abs(t.books.delta) === 1 ? '' : 's'}`);
    if (t.pages?.delta) bits.push(`${t.pages.delta > 0 ? '+' : ''}${t.pages.delta} pages`);
    if (t.copies?.delta) bits.push(`${t.copies.delta > 0 ? '+' : ''}${t.copies.delta} copies`);
    const specs = diff.documentChanges.filter((d) => d.kind === 'modified' || d.kind === 'pdf_replaced').length;
    if (specs) bits.push(`${specs} document${specs === 1 ? '' : 's'} amended`);
    if (diff.headerChanges.length) bits.push(`${diff.headerChanges.length} request field${diff.headerChanges.length === 1 ? '' : 's'}`);
    return bits.length ? bits.join(', ') : `${diff.changeCount} change${diff.changeCount === 1 ? '' : 's'}`;
};
