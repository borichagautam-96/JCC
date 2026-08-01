// Rate master import from the annexure workbook.
//
// Reads PRINTING_ANNEXURE and BINDING_ANNEXURE and produces service items and rate
// lines. Re-runnable: dropping in an updated workbook and importing again creates a
// new draft rate version, so changing a price never needs a code change.
//
// Two things about the sheets drive this parser:
//   * Merged cells. The Paper / Type columns are blank on continuation rows and mean
//     "same as above", so they are forward-filled.
//   * Free text. The sheets carry real-world spellings ("wiro bianding", "PLASTIK
//     POUCH"). The source label is preserved for display; matching happens on a
//     normalised key so a typo does not create a second service.

import XLSX from 'xlsx';

const PRINT_SHEET = 'PRINTING_ANNEXURE';
const BIND_SHEET = 'BINDING_ANNEXURE';
const HEADER_ROW = 6;               // 0-indexed; row 7 onward carries rates

// The printing sheet carries two independent rate blocks. `annexure` is the 2022
// card; `po` is the "Service Category As per PO" block parked off to the right at
// column HU. They price the same services differently, so each must be imported as
// its own card — see the `block` option on importRateWorkbook.
export const PRINT_BLOCKS = {
    annexure: { col: 0, headerRow: HEADER_ROW, label: '2022 annexure' },
    po: { col: 228, headerRow: 76, label: 'As per PO' },
};

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => clean(v).toLowerCase();

/** "0.57" -> 570 millirupees. Returns null when the cell is not a number. */
export const toMilli = (v) => {
    if (v === null || v === undefined || clean(v) === '') return null;
    const n = Number(String(v).replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 1000);
};

/** Plain paper weights price the ordinary PRINT service; everything else is its own. */
const GSM_ONLY = /^(\d{2,3})\s*gsm\s*$/i;

/** Colour column -> the card's colour dimension. */
export const colourOf = (type) => {
    const t = norm(type);
    if (!t) return null;
    // A cell naming both modes ("B&W or Clr", "COLOUR B/W") is one rate that applies
    // either way. Store it as NULL — resolveLine treats NULL as a wildcard, so it
    // answers both a B&W and a Colour lookup. This test must come first: the plain
    // B&W pattern below also matches "B&W or Clr" and would pin it to B&W alone.
    const hasBw = /(b\s*&\s*w|b\s*\/\s*w|\bbw\b|black)/.test(t);
    const hasColour = /(colou?r|clr|\bcou\b)/.test(t);
    if (hasBw && hasColour) return null;
    if (hasBw) return 'BW';
    if (hasColour) return 'COLOUR';
    return null;
};

// Binding descriptions in the sheet -> service codes the job form can produce.
// Anything absent here still imports, under a generated code, so the rate exists even
// though no form field selects it yet.
const BINDING_MAP = [
    [/soft\s*lamination/,            'LAMINATE_SOFT',  'Soft lamination',       'finishing'],
    [/spiral/,                       'BIND_SPIRAL',    'Spiral binding',        'binding'],
    [/wiro/,                         'BIND_WIRO',      'Wiro binding',          'binding'],
    [/screw/,                        'BIND_SCREW',     'Screw binding',         'binding'],
    [/hard\s*rexin/,                 'BIND_REXINE',    'Hard rexine binding',   'binding'],
    [/hard\s*bianding|hard\s*bind/,  'BIND_HARDCASE',  'Hard case binding',     'binding'],
    [/english/,                      'BIND_PERFECT',   'Perfect / glue binding','binding'],
    [/center\s*pin|centre\s*pin/,    'BIND_STAPLE',    'Staple binding',        'binding'],
    [/re\s*bianding|re\s*bind/,      'BIND_REBIND',    'Re-binding',            'binding'],
    [/digital\s*embossing/,          'EMBOSSING',      'Digital embossing',     'finishing'],
    [/box\s*file/,                   'BOX_FILE',       'Box file',              'misc'],
    [/ohp/,                          'OHP',            'OHP sheet',             'finishing'],
];

const bindingService = (label) => {
    const l = norm(label);
    for (const [re, code, name, group] of BINDING_MAP) {
        if (re.test(l)) return { code, name, group };
    }
    if (!l) return null;
    // Unmapped but real: keep it, so the rate is not lost.
    return {
        code: 'BIND_' + clean(label).toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 24),
        name: clean(label),
        group: 'binding',
    };
};

// Specialty printing/material rows -> their own services.
const MATERIAL_MAP = [
    [/clr\s*machine/,                 'PRINT_CLR_MACHINE', 'Printing — colour machine', 'printing'],
    [/cardboard/,                     'CARDBOARD',         'Cardboard',                 'finishing'],
    [/plastik\s*pouch\s*flap|pouch\s*flap/, 'POUCH_FLAP',  'Pouch flap',                'finishing'],
    [/plastik\s*pouch|plastic\s*pouch/, 'LAMINATE_POUCH',  'Pouch lamination',          'finishing'],
    [/pla[in]*\s*paper/,              'PLAIN_PAPER',       'Plain paper',               'printing'],
    [/scanning/,                      'SCAN',              'Scanning',                  'printing'],
    [/colour\s*card/,                 'COLOUR_CARD',       'Colour card',               'finishing'],
    [/paper\s*f\/b/,                  'PAPER_STOCK',       'Paper / board stock',       'printing'],
    // Named stocks in the PO block. They carry their weight in the paper cell
    // ("300 GSM Glossy"), so the GSM is picked up by the gsmInPaper match below and
    // the finish is what distinguishes them.
    [/glossy/,                        'PAPER_STOCK',       'Paper / board stock',       'printing'],
    [/gsm\s*white/,                   'PAPER_STOCK',       'Paper / board stock',       'printing'],
    [/^box\b/,                        'BOX',               'Box',                       'misc'],
    [/paking|packing/,                'PACKING',           'Packing charge',            'misc'],
    [/cd\s*sticker/,                  'CD_STICKER',        'CD sticker sheet',          'finishing'],
    [/sepreter|separator/,            'SEPARATOR',         'Separator sheet',           'finishing'],
    [/sticker/,                       'STICKER',           'Sticker',                   'finishing'],
    [/looping/,                       'ECO_LOOPING',       'Eco NT looping',            'misc'],
    [/vinyal|vinyl/,                  'VINYL_LAM',         'HP vinyl lamination',       'finishing'],
];

const materialService = (paper) => {
    const p = norm(paper);
    for (const [re, code, name, group] of MATERIAL_MAP) {
        if (re.test(p)) return { code, name, group };
    }
    return null;
};

/** Forward-fill a column that uses merged cells to mean "same as above". */
const fill = (rows, col) => {
    let last = '';
    return rows.map((r) => {
        const v = clean(r[col]);
        if (v) last = v;
        return last;
    });
};

/**
 * Parse the workbook.
 * Returns { services: Map<code, {...}>, lines: [...], warnings: [...] }.
 */
export const parseRateWorkbook = (filePath, { block = 'annexure' } = {}) => {
    const wb = XLSX.readFile(filePath);
    const services = new Map();
    const lines = [];
    const warnings = [];

    const addService = (code, label, uom, kind, group) => {
        if (!services.has(code)) services.set(code, { code, label, uom, pricing_kind: kind, cost_group: group });
    };

    // ── PRINTING_ANNEXURE: Paper | Type | Size | Rates ──
    //
    // The sheet holds this block twice. The 2022 annexure starts at column A / row 7;
    // a second "Service Category As per PO" block sits far to the right (column ~HU,
    // row 77) with different prices for the same work. Both are parsed the same way,
    // so the block origin is a parameter — but they must never land in one card, since
    // they disagree on price for identical keys.
    const parsePrintingBlock = ({ rows, col, headerRow }) => {
        const body = rows.slice(headerRow + 1);
        const papers = fill(body, col);
        const types = fill(body, col + 1);

        body.forEach((row, i) => {
            const size = clean(row[col + 2]);
            const rate = toMilli(row[col + 3]);
            const paper = papers[i];
            const type = types[i];
            if (!rate || !paper) return;

            const gsmOnly = paper.match(GSM_ONLY);
            if (gsmOnly) {
                // An ordinary paper weight — this is the PRINT service, keyed on the
                // dimensions the job form already captures.
                addService('PRINT', 'Printing', 'page', 'per_unit', 'printing');
                lines.push({
                    service_code: 'PRINT', paper_size: size || null, paper_gsm: gsmOnly[1],
                    colour_mode: colourOf(type), variant: null, rate_milli: rate,
                    source: `${paper} · ${type} · ${size}`,
                });
                return;
            }

            const svc = materialService(paper);
            if (!svc) {
                warnings.push(`No service mapping for paper "${paper}" (${type} ${size}) — skipped`);
                return;
            }
            addService(svc.code, svc.name, svc.group === 'printing' ? 'page' : 'piece', 'per_unit', svc.group);
            // Keep the GSM when the row names one, so 100 GSM plain paper is distinct
            // from 80 GSM plain paper.
            const gsmInType = clean(type).match(/(\d{2,3})\s*gsm/i);
            const gsmInPaper = paper.match(/(\d{2,3})\s*gsm/i);
            lines.push({
                service_code: svc.code,
                paper_size: size || null,
                paper_gsm: gsmInType ? gsmInType[1] : (gsmInPaper ? gsmInPaper[1] : null),
                colour_mode: colourOf(type),
                // Named finishes live in the paper cell, not the type cell — a glossy
                // 300 GSM and a plain 300 GSM board would otherwise share a key and
                // one would overwrite the other.
                variant: (paper.match(/glossy|white|yellow/i)?.[0]
                    || (/clr\s*machine|f\/b|per box|5 play|screen print|per pic|y\/w\/b/i.test(`${paper} ${type}`)
                        ? clean(type) : null) || '').toUpperCase().slice(0, 24) || null,
                rate_milli: rate,
                source: `${paper} · ${type} · ${size}`,
            });
        });
    };

    const pSheet = wb.Sheets[PRINT_SHEET];
    if (!pSheet) warnings.push(`Sheet "${PRINT_SHEET}" not found`);
    else {
        const all = XLSX.utils.sheet_to_json(pSheet, { header: 1, defval: null, raw: true });
        parsePrintingBlock({ rows: all, col: PRINT_BLOCKS[block].col, headerRow: PRINT_BLOCKS[block].headerRow });
    }

    // ── BINDING_ANNEXURE: Type | Size | Pages | Rates ──
    // Only the 2022 annexure has a binding table. The PO block covers paper and
    // printing alone, so its card carries no binding rates — borrowing the annexure's
    // would invent a price nobody agreed to. Those lines surface as unconfigured.
    const bSheet = block === 'annexure' ? wb.Sheets[BIND_SHEET] : null;
    if (block === 'annexure' && !bSheet) warnings.push(`Sheet "${BIND_SHEET}" not found`);
    else if (bSheet) {
        const all = XLSX.utils.sheet_to_json(bSheet, { header: 1, defval: null, raw: true });
        const body = all.slice(HEADER_ROW + 1);
        const typesFilled = fill(body, 0);

        body.forEach((row, i) => {
            const rate = toMilli(row[3]);
            const label = typesFilled[i];
            if (!rate || !label) return;
            if (/basic total/i.test(label)) return;

            const svc = bindingService(label);
            if (!svc) return;
            addService(svc.code, svc.name, svc.group === 'binding' ? 'copy' : 'piece',
                svc.group === 'binding' ? 'per_copy' : 'per_unit', svc.group);

            // Size column carries A4/A3/A5 for most rows, but box file uses it for
            // thickness ("1 inc", "2.5"), which is a variant rather than a paper size.
            const sizeCell = clean(row[1]);
            const isPaperSize = /^(A\d|A\d\/B\d|B\d|\d+X\d+)$/i.test(sizeCell);
            lines.push({
                service_code: svc.code,
                paper_size: isPaperSize ? sizeCell.toUpperCase() : (clean(row[2]).match(/^A\d$/i) ? clean(row[2]).toUpperCase() : null),
                paper_gsm: null,
                colour_mode: null,
                variant: isPaperSize ? null : (sizeCell || null),
                rate_milli: rate,
                source: `${label} · ${sizeCell || '-'}`,
            });
        });
    }

    return { services: [...services.values()], lines, warnings };
};

/**
 * Write a parsed workbook into a new draft rate version.
 * Never touches an approved version — a price change is a new card, so history and
 * any annexure already issued stay exactly as they were.
 */
export const importRateWorkbook = (db, filePath, { code, label, effectiveFrom, sourceNote, block = 'annexure' }) => {
    const { services, lines, warnings } = parseRateWorkbook(filePath, { block });

    const existing = db.prepare('SELECT id, status FROM rate_versions WHERE code = ?').get(code);
    if (existing && existing.status !== 'draft') {
        return { skipped: `${code} is ${existing.status} and cannot be re-imported`, warnings };
    }

    const upsertService = db.prepare(
        `INSERT INTO service_items (code, label, uom, pricing_kind, cost_group)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET label = excluded.label`
    );
    for (const s of services) upsertService.run(s.code, s.label, s.uom, s.pricing_kind, s.cost_group);

    let versionId = existing?.id;
    if (!versionId) {
        versionId = Number(db.prepare(
            `INSERT INTO rate_versions (code, label, effective_from, status, source_note)
             VALUES (?, ?, ?, 'draft', ?)`
        ).run(code, label, effectiveFrom, sourceNote).lastInsertRowid);
    } else {
        db.prepare('UPDATE rate_versions SET label = ?, effective_from = ?, source_note = ? WHERE id = ?')
            .run(label, effectiveFrom, sourceNote, versionId);
    }

    db.prepare('DELETE FROM rate_lines WHERE version_id = ?').run(versionId);
    const insertLine = db.prepare(
        `INSERT INTO rate_lines (version_id, service_code, paper_size, paper_gsm, colour_mode,
                                 variant, rate_milli, needs_review, note)
         VALUES (?,?,?,?,?,?,?,0,?)
         ON CONFLICT(version_id, service_code, paper_size, paper_gsm, colour_mode, variant)
         DO UPDATE SET rate_milli = excluded.rate_milli, note = excluded.note`
    );
    // The sheet groups sizes that share a rate into one cell ("A5/B5", "A4/A3"). The
    // job form submits a single size, so store one row per size or the lookup misses
    // and an A5 job reads as unpriced.
    const expandSizes = (size) => {
        if (!size) return [null];
        const parts = size.split('/').map((s) => s.trim().toUpperCase()).filter(Boolean);
        return parts.every((p) => /^(A\d|B\d|\d+X\d+)$/.test(p)) && parts.length > 1 ? parts : [size];
    };

    let written = 0;
    for (const l of lines) {
        for (const size of expandSizes(l.paper_size)) {
            insertLine.run(versionId, l.service_code, size, l.paper_gsm,
                l.colour_mode, l.variant, l.rate_milli, l.source);
            written += 1;
        }
    }

    return { versionId, code, services: services.length, lines: written, warnings };
};
