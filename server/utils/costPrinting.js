// Printing domain adapter.
//
// The one place that knows about paper, binding and lamination. It answers a single
// question — for this job, what quantities of which service codes were consumed? —
// and never computes money. The kernel (costEngine.js) does that.
//
// Keeping the two apart is what lets Documentation or Media reuse the costing engine
// later by supplying their own adapter.

import { priceItem } from './costEngine.js';

/** The form stores 'Black & White' / 'Colour'; the rate card keys on BW / COLOUR. */
export const normaliseColour = (mode) => {
    const m = String(mode || '').toLowerCase();
    if (!m) return null;
    if (m.includes('black') || m === 'bw' || m.includes('b&w')) return 'BW';
    if (m.includes('colour') || m.includes('color')) return 'COLOUR';
    return null;
};

/** Binding type on the form → service code on the card. None means no charge. */
export const BINDING_SERVICE = {
    'spiral': 'BIND_SPIRAL',
    'wiro': 'BIND_WIRO',
    'screw': 'BIND_SCREW',
    'tape': 'BIND_TAPE',
    'perfect / glue': 'BIND_PERFECT',
    'hard case': 'BIND_HARDCASE',
    'hard rexine': 'BIND_REXINE',
    'staple': 'BIND_STAPLE',
    're-binding': 'BIND_REBIND',
    'box file': 'BOX_FILE',
    'digital embossing': 'EMBOSSING',
};

const bindingService = (type) => {
    const key = String(type || '').trim().toLowerCase();
    if (!key || key === 'none') return null;
    return BINDING_SERVICE[key] || null;
};

/**
 * Billable items for one document.
 * `copies` and `pages` come from the document; a rework overrides the page count with
 * only the pages being reprinted.
 */
export const itemsForDocument = (doc, { pagesOverride = null, copiesOverride = null } = {}) => {
    const copies = Number(copiesOverride ?? doc.quantity) || 0;
    const pages = Number(pagesOverride ?? doc.num_pages) || 0;
    const colour = normaliseColour(doc.color_mode);
    const items = [];

    // Printing — priced per impression (page x copies). See OD-01: if the shop prices
    // per physical sheet instead, halve this for duplex and add a paper-stock line.
    if (pages > 0 && copies > 0) {
        items.push({
            serviceCode: 'PRINT',
            label: 'Printing',
            costGroup: 'printing',
            quantity: pages * copies,
            uom: 'page',
            dimensions: { size: doc.paper_size, gsm: doc.paper_gsm, colour },
            detail: `${doc.paper_size || '?'} / ${doc.paper_gsm || '?'} / ${colour || '?'} · ${pages}pp × ${copies}`,
        });
    }

    // Binding — per finished book.
    const bind = bindingService(doc.binding_type);
    if (bind && copies > 0) {
        // A box file is priced on spine thickness, not paper size, so the variant the
        // requestor picked is what identifies the rate. Bindings without variants send
        // null and match on size alone.
        const variant = doc.binding_variant || null;
        items.push({
            serviceCode: bind,
            label: `${doc.binding_type} binding`,
            costGroup: 'binding',
            quantity: copies,
            uom: 'copy',
            dimensions: { size: variant ? null : doc.paper_size, gsm: null, colour: null, variant },
            detail: `${doc.binding_type}${variant ? ` · ${variant}` : ''} × ${copies}`,
        });
    }

    // Finishing — each flag is one chargeable service per copy.
    if (Number(doc.soft_lamination) === 1 && copies > 0) {
        // The sheet prices "Soft Lamination" and "Plastik Pouch" separately; the form's
        // soft_lamination flag means the former.
        items.push({
            serviceCode: 'LAMINATE_SOFT', label: 'Soft lamination', costGroup: 'finishing',
            quantity: copies, uom: 'piece',
            dimensions: { size: doc.paper_size, gsm: null, colour: null },
            detail: `lamination × ${copies}`,
        });
    }
    if (doc.cover_page && String(doc.cover_page).trim() && copies > 0) {
        items.push({
            serviceCode: 'COLOUR_CARD', label: 'Cover page', costGroup: 'finishing',
            quantity: copies, uom: 'sheet',
            dimensions: { size: doc.paper_size, gsm: null, colour: 'COLOUR' },
            detail: `cover: ${doc.cover_page} × ${copies}`,
        });
    }
    if (Number(doc.separators) === 1 && copies > 0) {
        items.push({
            serviceCode: 'SEPARATOR', label: 'Separator sheets', costGroup: 'finishing',
            quantity: copies, uom: 'sheet',
            dimensions: { size: doc.paper_size, gsm: doc.separator_thickness || null, colour: null },
            detail: `separators × ${copies}`,
        });
    }
    if (Number(doc.hole_punch) === 1 && copies > 0) {
        items.push({
            serviceCode: 'HOLE_PUNCH', label: 'Hole punching', costGroup: 'finishing',
            quantity: copies, uom: 'copy',
            dimensions: { size: doc.paper_size, gsm: null, colour: null },
            detail: `hole punch × ${copies}`,
        });
    }

    // Optional extras the requestor added — each carries the exact dimensions it was
    // chosen against, so it resolves the same way whichever card is in force.
    for (const extra of parseExtras(doc.extra_services)) {
        const qty = Number(extra.quantity) || 0;
        if (!extra.code || qty <= 0) continue;
        const detail = [extra.size, extra.gsm && `${extra.gsm} GSM`, extra.colour, extra.variant]
            .filter(Boolean).join(' · ');
        items.push({
            serviceCode: extra.code,
            label: extra.label || extra.code,
            costGroup: extra.costGroup || 'misc',
            quantity: qty,
            uom: extra.uom || 'unit',
            dimensions: {
                size: extra.size || null, gsm: extra.gsm || null,
                colour: extra.colour || null, variant: extra.variant || null,
            },
            detail: detail ? `${detail} × ${qty}` : `× ${qty}`,
        });
    }

    return items;
};

/** Extras are stored as a JSON string; a malformed value must not break costing. */
export const parseExtras = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

/**
 * Billable items for a rework: only the pages actually reprinted, plus any inserted
 * pages, at the document's own spec.
 */
export const itemsForRework = (rework, doc) => {
    const reprinted = (Number(rework.modified_page_count) || 0) + (Number(rework.additional_pages) || 0);
    if (reprinted <= 0 || !doc) return [];
    const copies = Number(doc.quantity) || 1;
    const colour = normaliseColour(doc.color_mode);
    return [{
        serviceCode: 'PRINT',
        label: `Rework V${rework.version_no} — reprint`,
        costGroup: 'printing',
        quantity: reprinted * copies,
        uom: 'page',
        dimensions: { size: doc.paper_size, gsm: doc.paper_gsm, colour },
        detail: `${rework.rework_id} · pages ${rework.modified_pages_norm || rework.modified_pages}`
              + `${rework.additional_pages ? ` +${rework.additional_pages} inserted` : ''} × ${copies}`,
        isRework: true,
        reworkId: rework.id,
    }];
};

/**
 * Price a list of items against a rate card.
 *
 * An item with no rate on the card is NOT dropped and does not block the job. It
 * becomes a line marked `not_configured` with no rate and no amount, so the annexure
 * shows the work that was done and finance can see exactly what still needs a price.
 * Such lines are excluded from every total — an unpriced service must never read as
 * free work.
 *
 * `unconfigured` is returned alongside for callers that want to surface the gap.
 */
export const priceItems = (items, resolve) => {
    const lines = [];
    const unconfigured = [];
    for (const item of items) {
        const qty = Number(item.quantity) || 0;
        const rate = resolve(item.serviceCode, item.dimensions || {});

        if (!rate) {
            if (qty <= 0) continue;
            const missing = [item.serviceCode, item.dimensions?.size, item.dimensions?.gsm, item.dimensions?.colour]
                .filter(Boolean).join('/');
            unconfigured.push({ serviceCode: item.serviceCode, label: item.label, detail: item.detail, missing });
            lines.push({
                serviceCode: item.serviceCode,
                label: item.label,
                costGroup: item.costGroup,
                quantity: qty,
                uom: item.uom,
                dimensions: item.dimensions || {},
                rateMilli: null,
                amountPaise: 0,
                rateStatus: 'not_configured',
                missing,
                minChargeApplied: false,
                detail: item.detail || null,
                isRework: !!item.isRework,
                reworkId: item.reworkId || null,
                rateVersionId: null,
            });
            continue;
        }

        const line = priceItem(item, rate);
        if (!line) continue;
        lines.push({
            ...line,
            dimensions: item.dimensions || {},
            rateStatus: 'priced',
            detail: item.detail || null,
            isRework: !!item.isRework,
            reworkId: item.reworkId || null,
            rateVersionId: rate.version_id || null,
        });
    }
    return { lines, unconfigured, exceptions: [] };
};
