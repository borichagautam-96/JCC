// Rate card RC-2026-08, transcribed from "Annexure 01 — PRINTING BINDING SERVICES,
// AUGUST 2026".
//
// Loaded as a DRAFT on purpose. It was read off a photograph of a printed sheet, so
// finance must confirm it before it prices anything — and BR-01 says only an approved
// version resolves. Lines that were not clearly legible carry needs_review = 1 and a
// note; they are present so the gaps are visible, not so they can be charged.
//
// Rates are integer millirupees: 1.150 on the sheet is 1150 here.

export const SERVICE_ITEMS = [
    // code,            label,                        uom,     pricing_kind, cost_group
    ['PRINT',           'Printing',                   'page',  'per_unit',  'printing'],
    ['PAPER_STOCK',     'Paper / board stock',        'sheet', 'per_unit',  'printing'],
    ['SCAN',            'Scanning',                   'page',  'per_unit',  'printing'],
    ['SCREEN_PRINT',    'Screen printing',            'piece', 'per_unit',  'printing'],
    ['BIND_SPIRAL',     'Spiral binding',             'copy',  'per_copy',  'binding'],
    ['BIND_SCREW',      'Screw binding',              'copy',  'per_copy',  'binding'],
    ['BIND_WIRO',       'Wiro binding',               'copy',  'per_copy',  'binding'],
    ['LAMINATE_POUCH',  'Pouch lamination',           'piece', 'per_unit',  'finishing'],
    ['POUCH_FLAP',      'Pouch flap',                 'piece', 'per_unit',  'finishing'],
    ['COLOUR_CARD',     'Colour card / cover stock',  'sheet', 'per_unit',  'finishing'],
    ['STICKER',         'Sticker',                    'piece', 'per_unit',  'finishing'],
    ['BOX',             'Box',                        'box',   'per_unit',  'misc'],
    ['PACKING',         'Packing charge',             'box',   'per_unit',  'misc'],

    // Chargeable concepts the job form can already produce, but which the August 2026
    // sheet does not price. Present so the coverage report names them rather than the
    // engine tripping on an unknown service code — they surface as unpriced until
    // finance adds a rate.
    ['BIND_STAPLE',     'Staple binding',             'copy',  'per_copy',  'binding'],
    ['BIND_TAPE',       'Tape binding',               'copy',  'per_copy',  'binding'],
    ['BIND_PERFECT',    'Perfect / glue binding',     'copy',  'per_copy',  'binding'],
    ['BIND_HARDCASE',   'Hard case binding',          'copy',  'per_copy',  'binding'],
    ['BIND_REXINE',     'Hard rexine binding',        'copy',  'per_copy',  'binding'],
    ['SEPARATOR',       'Separator sheets',           'sheet', 'per_unit',  'finishing'],
    ['HOLE_PUNCH',      'Hole punching',              'copy',  'per_copy',  'finishing'],
];

// ── Printing matrix (sheet 1) — clearly legible, transcribed in full ──────────
// [size, gsm, colour, rate_milli]
const PRINT_MATRIX = [
    ['A5/B5', '80',  'BW',      570],
    ['A4',    '80',  'BW',     1150],
    ['A3',    '80',  'BW',     2300],
    ['A2',    '80',  'BW',    33350],
    ['A1',    '80',  'BW',    44850],
    ['A5/B5', '80',  'COLOUR',  2500],
    ['A4',    '80',  'COLOUR',  5000],
    ['A3',    '80',  'COLOUR', 10000],
    ['A2',    '80',  'COLOUR', 55000],
    ['A1',    '80',  'COLOUR', 78200],
    ['A5/B5', '100', 'BW',      720],
    ['A4',    '100', 'BW',     1440],
    ['A3',    '100', 'BW',     2750],
    ['A2',    '100', 'BW',    43700],
    ['A1',    '100', 'BW',    66700],
    ['A5/B5', '100', 'COLOUR',  2730],
    ['A4',    '100', 'COLOUR',  5460],
    ['A3',    '100', 'COLOUR', 10930],
    ['A2',    '100', 'COLOUR', 65000],
    ['A1',    '100', 'COLOUR',100000],
];

// ── Sheet 2 — service lines. `review` marks a value I could not read with certainty.
// [service_code, size, gsm, colour, variant, rate_milli, review, note]
const SERVICE_LINES = [
    ['PRINT',          'A4',    '130', 'COLOUR', null,     10000, 0, null],
    ['PRINT',          'A3',    '130', 'COLOUR', null,     20000, 0, null],
    ['LAMINATE_POUCH', 'A4',    null,  null,     'NORMAL', 11500, 0, null],
    ['LAMINATE_POUCH', 'A4',    null,  null,     'VIP',    13800, 0, null],
    ['POUCH_FLAP',     'A4',    null,  null,     'VIP',      710, 0, null],
    ['SCAN',           'A3',    null,  null,     'NORMAL',   810, 0, null],
    ['SCAN',           'A4',    null,  null,     'NORMAL',   400, 0, null],
    ['COLOUR_CARD',    'A4',    '200', 'COLOUR', 'Y/W/B/P', 5750, 0, null],
    ['PAPER_STOCK',    '12X18', '130', 'COLOUR', 'F/B',    46000, 0, null],
    ['PAPER_STOCK',    '12X18', '170', 'COLOUR', 'F/B',    50600, 0, null],
    ['PAPER_STOCK',    '12X18', '250', 'COLOUR', 'F/B',    55200, 0, null],
    ['BOX',            'A4',    null,  null,     '5PLY',   86250, 0, null],
    ['PACKING',        'A4/A3', null,  null,     'PER_BOX',57500, 0, null],
    ['SCREEN_PRINT',   'A4',    null,  null,     null,     11500, 0, null],
    ['BIND_SPIRAL',    'A4',    null,  null,     'BLUE',   17250, 0, null],

    // Present so the gap is visible, but unconfirmed — do not charge on these.
    ['PAPER_STOCK',    '12X18', '350', 'COLOUR', 'F/B',    57500, 1, 'Sheet 2: value unclear in photo'],
    ['PRINT',          'A3',    null,  null,     'B&W/COL',18000, 1, 'Sheet 2 "B&W OR COLOU" — dimension ambiguous'],
    ['STICKER',        '5X4',   null,  null,     null,   1475000, 1, 'Sheet 2: very large value, confirm unit'],
    ['STICKER',        'A4',    null,  'COLOUR', null,     18000, 1, 'Sheet 2: row label unclear'],
    ['BIND_SCREW',     'A4',    null,  null,     'BLUE',  230000, 1, 'Sheet 2: confirm — implausibly high vs spiral'],
];

export const RATE_LINES = [
    ...PRINT_MATRIX.map(([size, gsm, colour, rate]) =>
        ['PRINT', size, gsm, colour, null, rate, 0, null]),
    ...SERVICE_LINES,
];

export const VERSION = {
    code: 'RC-2026-08',
    label: 'Printing & Binding Services — August 2026',
    effective_from: '2026-08-01',
    status: 'draft',
    source_note: 'Transcribed from photographed sheet "Annexure 01". Needs finance confirmation before approval.',
};

/** Idempotent: safe to run on every boot. Never touches an approved version. */
export const seedRateCard = (db) => {
    const insertItem = db.prepare(
        `INSERT INTO service_items (code, label, uom, pricing_kind, cost_group)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET label = excluded.label, uom = excluded.uom,
              pricing_kind = excluded.pricing_kind, cost_group = excluded.cost_group`
    );
    for (const [code, label, uom, kind, group] of SERVICE_ITEMS) {
        insertItem.run(code, label, uom, kind, group);
    }

    const existing = db.prepare('SELECT id, status FROM rate_versions WHERE code = ?').get(VERSION.code);
    if (existing && existing.status !== 'draft') return { skipped: 'already approved' };

    let versionId = existing?.id;
    if (!versionId) {
        versionId = Number(db.prepare(
            `INSERT INTO rate_versions (code, label, effective_from, status, source_note)
             VALUES (?, ?, ?, ?, ?)`
        ).run(VERSION.code, VERSION.label, VERSION.effective_from, VERSION.status, VERSION.source_note).lastInsertRowid);
    }

    // Rebuild the draft's lines so re-seeding reflects corrections to this file.
    db.prepare('DELETE FROM rate_lines WHERE version_id = ?').run(versionId);
    const insertLine = db.prepare(
        `INSERT INTO rate_lines (version_id, service_code, paper_size, paper_gsm, colour_mode,
                                 variant, rate_milli, needs_review, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [code, size, gsm, colour, variant, rate, review, note] of RATE_LINES) {
        insertLine.run(versionId, code, size, gsm, colour, variant, rate, review, note);
    }

    return {
        versionId,
        services: SERVICE_ITEMS.length,
        lines: RATE_LINES.length,
        needsReview: RATE_LINES.filter((l) => l[6] === 1).length,
    };
};
