import React, { useEffect, useState } from 'react';

// Correcting a job's costing to what was actually printed.
//
// The requestor's spec is an estimate. Printing a manual, the operator decides how many
// pages really run A3 vs A4 and which are colour, so this is where that reality is
// recorded. Editing is offered to the assigned operator and to coordinators; the server
// enforces the same rule and refuses once the annexure is approved.

const CELL = { padding: '0.25rem 0.4rem', fontSize: '0.82rem' };

// A small, square, danger-toned icon button — an inline text "Remove" button was
// wide enough, across seven other columns, to push itself off the edge of the
// modal on anything narrower than a very wide screen.
const RemoveButton = ({ onClick, disabled }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title="This work was not actually done"
        style={{
            width: '1.9rem', height: '1.9rem', lineHeight: 1, fontSize: '1rem', fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid var(--stat-red)', color: 'var(--stat-red)', background: 'transparent',
            borderRadius: '0.4rem', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        }}
        onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = 'var(--stat-red)'; e.currentTarget.style.color = 'white'; } }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--stat-red)'; }}
    >
        ×
    </button>
);

const CostEditor = ({ jobId, authHeaders, canEdit = false, onChanged }) => {
    const [data, setData] = useState(null);
    const [options, setOptions] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState({ service_code: 'PRINT', quantity: '', paper_size: 'A4', paper_gsm: '80', colour_mode: 'BW' });

    const load = async () => {
        try {
            const res = await fetch(`/api/jobs/${jobId}/cost`, { headers: authHeaders() });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Could not load costing');
            // A preview has no row identity, so nothing on it can be corrected. When the
            // viewer is allowed to edit, turn it into real rows straight away — otherwise
            // the table looks editable-ish but every field is dead.
            if (canEdit && body.source === 'preview') {
                const acc = await fetch(`/api/jobs/${jobId}/cost/accrue`, {
                    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: '{}',
                });
                if (acc.ok) return setData(await acc.json());
            }
            setData(body);
        } catch (e) {
            setError(e.message);
        }
    };

    useEffect(() => { load(); }, [jobId]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/rates/print-options', { headers: authHeaders() });
                if (res.ok) setOptions(await res.json());
            } catch { /* selects fall back to the values already on the line */ }
        })();
    }, []);

    const combos = options?.combinations || [];
    const sizes = [...new Set(combos.map((c) => c.size))];
    // Weights depend on the size and colour chosen, exactly as on the job form.
    const gsmsFor = (size, colour) => [...new Set(combos
        .filter((c) => c.size === size && (!c.colour || !colour || c.colour === colour))
        .map((c) => String(c.gsm)))].sort((a, b) => Number(a) - Number(b));

    const send = async (url, options_) => {
        setBusy(true); setError(null);
        try {
            const res = await fetch(url, { headers: { ...authHeaders(), 'Content-Type': 'application/json' }, ...options_ });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Update failed');
            setData(body);
            if (onChanged) onChanged(body);
            return true;
        } catch (e) {
            setError(e.message);
            return false;
        } finally {
            setBusy(false);
        }
    };

    const patchLine = (line, patch) =>
        send(`/api/jobs/${jobId}/cost/lines/${line.id}`, { method: 'PATCH', body: JSON.stringify(patch) });

    const removeLine = (line) =>
        send(`/api/jobs/${jobId}/cost/lines/${line.id}`, { method: 'DELETE' });

    const addLine = async () => {
        const ok = await send(`/api/jobs/${jobId}/cost/lines`, { method: 'POST', body: JSON.stringify(draft) });
        if (ok) { setAdding(false); setDraft({ ...draft, quantity: '' }); }
    };

    if (error && !data) return <div style={{ padding: '0.6rem', color: 'var(--stat-red)' }}>{error}</div>;
    if (!data) return <div className="text-muted" style={{ padding: '0.6rem' }}>Loading costing…</div>;

    const lines = data.lines || [];
    // Lines only become editable once they exist as rows. A preview has no ids yet — the
    // first edit materialises them server-side, so adding a line is always available.
    const editable = canEdit && !busy;

    return (
        <div style={{ marginTop: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
                <strong style={{ color: 'var(--text-strong)', fontSize: '0.9rem' }}>Printing cost — as actually printed</strong>
                {canEdit && (
                    <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                        Adjust the pages, size and colour to what really ran. ✱ marks a corrected line.
                    </span>
                )}
            </div>
            {error && <div style={{ color: 'var(--stat-red)', fontSize: '0.82rem', margin: '0.4rem 0' }}>{error}</div>}

            <div className="table-container" style={{ marginTop: '0.5rem' }}>
                <table className="table table-compact" style={{ margin: 0 }}>
                    <thead>
                        <tr>
                            <th>Service</th><th style={{ width: '4.5rem' }}>Qty</th><th style={{ width: '4.2rem' }}>Size</th>
                            <th style={{ width: '4.2rem' }}>GSM</th><th style={{ width: '4.5rem' }}>Colour</th>
                            <th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Amount</th>
                            {editable && <th style={{ width: '2.5rem' }} />}
                        </tr>
                    </thead>
                    <tbody>
                        {lines.map((l) => {
                            const isPrint = l.service_code === 'PRINT';
                            const rowEditable = editable && !!l.id;
                            return (
                                <tr key={l.id || `${l.service_code}-${l.detail}`}>
                                    <td style={{ fontWeight: 600 }}>
                                        {!!l.is_manual && <span style={{ color: 'var(--stat-amber)', marginRight: '0.3rem' }} title={l.manual_reason}>✱</span>}
                                        {l.label}
                                    </td>
                                    <td>
                                        {rowEditable ? (
                                            <input className="input-field" type="number" min="0" style={{ ...CELL, width: '4rem' }}
                                                   defaultValue={l.quantity} disabled={busy}
                                                   onBlur={(e) => Number(e.target.value) !== Number(l.quantity)
                                                       && patchLine(l, { quantity: e.target.value })}
                                                   onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
                                        ) : l.quantity}
                                    </td>
                                    <td>
                                        {rowEditable && isPrint && sizes.length ? (
                                            <select className="input-field" style={{ ...CELL, width: '3.8rem' }} value={l.paper_size || ''}
                                                    disabled={busy} onChange={(e) => patchLine(l, { paper_size: e.target.value })}>
                                                {[...new Set([...sizes, l.paper_size].filter(Boolean))].map((s) => <option key={s}>{s}</option>)}
                                            </select>
                                        ) : (l.paper_size || '—')}
                                    </td>
                                    <td>
                                        {rowEditable && isPrint ? (
                                            <select className="input-field" style={{ ...CELL, width: '3.8rem' }} value={l.paper_gsm || ''}
                                                    disabled={busy} onChange={(e) => patchLine(l, { paper_gsm: e.target.value })}>
                                                {[...new Set([...gsmsFor(l.paper_size, l.colour_mode), l.paper_gsm].filter(Boolean))]
                                                    .map((g) => <option key={g}>{g}</option>)}
                                            </select>
                                        ) : (l.paper_gsm || '—')}
                                    </td>
                                    <td>
                                        {rowEditable && isPrint ? (
                                            <select className="input-field" style={{ ...CELL, width: '4.2rem' }} value={l.colour_mode || ''}
                                                    disabled={busy} onChange={(e) => patchLine(l, { colour_mode: e.target.value })}>
                                                <option value="BW">B/W</option>
                                                <option value="COLOUR">Colour</option>
                                            </select>
                                        ) : (l.colour_mode || '—')}
                                    </td>
                                    <td style={{ textAlign: 'right', fontFamily: 'monospace',
                                                 color: l.unpriced ? 'var(--stat-amber)' : 'var(--text-strong)' }}>
                                        {l.rate_display}
                                    </td>
                                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{l.amount_display}</td>
                                    {editable && (
                                        <td style={{ textAlign: 'center' }}>
                                            {!!l.id && <RemoveButton disabled={busy} onClick={() => removeLine(l)} />}
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                        <tr>
                            <td colSpan={editable ? 6 : 5} style={{ textAlign: 'right', fontWeight: 700 }}>Total</td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-strong)' }}>
                                {data.totals_display?.grandTotal ?? data.totals_display?.grand_total}
                            </td>
                            {editable && <td />}
                        </tr>
                    </tbody>
                </table>
            </div>

            {editable && !adding && (
                <button className="btn btn-sm btn-outline" style={{ marginTop: '0.6rem' }} onClick={() => setAdding(true)}>
                    + Add what was printed
                </button>
            )}

            {editable && adding && (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '0.6rem' }}>
                    <div className="input-group" style={{ margin: 0 }}>
                        <label className="input-label">Pages</label>
                        <input className="input-field" type="number" min="1" style={{ ...CELL, width: '6rem' }}
                               value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
                    </div>
                    <div className="input-group" style={{ margin: 0 }}>
                        <label className="input-label">Size</label>
                        <select className="input-field" style={{ ...CELL, width: '6rem' }} value={draft.paper_size}
                                onChange={(e) => setDraft({ ...draft, paper_size: e.target.value })}>
                            {(sizes.length ? sizes : ['A4', 'A3']).map((s) => <option key={s}>{s}</option>)}
                        </select>
                    </div>
                    <div className="input-group" style={{ margin: 0 }}>
                        <label className="input-label">GSM</label>
                        <select className="input-field" style={{ ...CELL, width: '6rem' }} value={draft.paper_gsm}
                                onChange={(e) => setDraft({ ...draft, paper_gsm: e.target.value })}>
                            {(gsmsFor(draft.paper_size, draft.colour_mode).length
                                ? gsmsFor(draft.paper_size, draft.colour_mode) : ['80', '100']).map((g) => <option key={g}>{g}</option>)}
                        </select>
                    </div>
                    <div className="input-group" style={{ margin: 0 }}>
                        <label className="input-label">Colour</label>
                        <select className="input-field" style={{ ...CELL, width: '7rem' }} value={draft.colour_mode}
                                onChange={(e) => setDraft({ ...draft, colour_mode: e.target.value })}>
                            <option value="BW">BW</option>
                            <option value="COLOUR">COLOUR</option>
                        </select>
                    </div>
                    <button className="btn btn-sm btn-primary" disabled={busy || !draft.quantity} onClick={addLine}>Add</button>
                    <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
                </div>
            )}
        </div>
    );
};

export default CostEditor;
