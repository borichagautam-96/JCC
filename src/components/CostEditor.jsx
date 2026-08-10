import React, { useEffect, useState } from 'react';

// Correcting a job's costing to what was actually printed.
//
// The requestor's spec is an estimate. Printing a manual, the operator decides how many
// pages really run A3 vs A4 and which are colour, so this is where that reality is
// recorded. Editing is offered to printer operators and coordinators; the server
// enforces the same rule and refuses once the annexure is approved.
//
// Edits are held LOCALLY until saved. Every change used to commit the moment it was
// made, which meant an experimental click could not be taken back — so this keeps a
// working copy and offers a real Save / Discard choice. Discard simply throws the
// working copy away without ever calling the server.

const CELL = { padding: '0.25rem 0.4rem', fontSize: '0.82rem' };
const NOT_SET = '__unset__';

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

const money = (paise) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CostEditor = ({ jobId, authHeaders, canEdit = false, onChanged, onClose }) => {
    const [serverLines, setServerLines] = useState(null);  // last known saved state
    const [rows, setRows] = useState([]);                  // the working copy being edited
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
            let data = body;
            if (canEdit && body.source === 'preview') {
                const acc = await fetch(`/api/jobs/${jobId}/cost/accrue`, {
                    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: '{}',
                });
                if (acc.ok) data = await acc.json();
            }
            setServerLines(data.lines || []);
            setRows((data.lines || []).map((l) => ({ ...l })));
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

    // Local edits only — nothing reaches the server until Save.
    const patchRow = (key, patch) =>
        setRows((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, ...patch, _dirty: true } : r)));
    const dropRow = (key) => setRows((prev) => prev.filter((r) => rowKey(r) !== key));
    const rowKey = (r) => (r.id != null ? `id:${r.id}` : `new:${r._tmp}`);

    const addRow = () => {
        const qty = Number(draft.quantity);
        if (!Number.isFinite(qty) || qty <= 0) return;
        setRows((prev) => [...prev, {
            _tmp: Date.now(), _dirty: true, service_code: draft.service_code, label: 'Printing',
            cost_group: 'printing', uom: 'page', quantity: qty,
            paper_size: draft.paper_size, paper_gsm: draft.paper_gsm, colour_mode: draft.colour_mode,
            rate_display: '—', amount_display: '—',
        }]);
        setAdding(false);
        setDraft({ ...draft, quantity: '' });
    };

    const dirty = JSON.stringify(rows.map((r) => [r.id ?? null, Number(r.quantity), r.paper_size ?? null, r.paper_gsm ?? null, r.colour_mode ?? null]))
        !== JSON.stringify((serverLines || []).map((r) => [r.id ?? null, Number(r.quantity), r.paper_size ?? null, r.paper_gsm ?? null, r.colour_mode ?? null]));

    const save = async () => {
        setBusy(true); setError(null);
        try {
            const payload = rows.map((r) => ({
                id: r.id ?? undefined, service_code: r.service_code, quantity: Number(r.quantity),
                paper_size: r.paper_size ?? null, paper_gsm: r.paper_gsm ?? null, colour_mode: r.colour_mode ?? null,
            }));
            const res = await fetch(`/api/jobs/${jobId}/cost/lines`, {
                method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ lines: payload }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Could not save');
            setServerLines(body.lines || []);
            setRows((body.lines || []).map((l) => ({ ...l })));
            if (onChanged) onChanged(body);
            if (onClose) onClose();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const discard = () => {
        setRows((serverLines || []).map((l) => ({ ...l })));
        setAdding(false);
        setError(null);
        if (onClose) onClose();
    };

    if (error && !serverLines) return <div style={{ padding: '0.6rem', color: 'var(--stat-red)' }}>{error}</div>;
    if (!serverLines) return <div className="text-muted" style={{ padding: '0.6rem' }}>Loading costing…</div>;

    const editable = canEdit && !busy;
    // Totals are recomputed by the server on save; until then show the last saved
    // figure for untouched rows and leave edited ones to be re-priced.
    const total = rows.reduce((sum, r) => sum + (r._dirty ? 0 : (r.amount_paise || 0)), 0);
    const hasDirty = rows.some((r) => r._dirty);

    return (
        <div style={{ marginTop: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
                <strong style={{ color: 'var(--text-strong)', fontSize: '0.9rem' }}>Printing cost — as actually printed</strong>
                {canEdit && (
                    <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                        Adjust the pages, size and colour to what really ran, then Save. ✱ marks a corrected line.
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
                        {rows.map((l) => {
                            const isPrint = l.service_code === 'PRINT';
                            const key = rowKey(l);
                            // A legacy line can have no stored size/GSM/colour at all. Offer an
                            // explicit "not set" option so the select shows the truth instead of
                            // silently falling back to displaying its first option (A1), which
                            // reads as a real spec the line does not actually have.
                            const sizeOpts = [...new Set([...sizes, l.paper_size].filter(Boolean))];
                            const gsmOpts = [...new Set([...gsmsFor(l.paper_size, l.colour_mode), l.paper_gsm].filter(Boolean))];
                            return (
                                <tr key={key}>
                                    <td style={{ fontWeight: 600 }}>
                                        {(!!l.is_manual || l._dirty) && (
                                            <span style={{ color: 'var(--stat-amber)', marginRight: '0.3rem' }}
                                                  title={l._dirty ? 'Edited — not saved yet' : l.manual_reason}>✱</span>
                                        )}
                                        {l.label}
                                    </td>
                                    <td>
                                        {editable ? (
                                            <input className="input-field" type="number" min="0" style={{ ...CELL, width: '4rem' }}
                                                   value={l.quantity ?? ''}
                                                   onChange={(e) => patchRow(key, { quantity: e.target.value })} />
                                        ) : l.quantity}
                                    </td>
                                    <td>
                                        {editable && isPrint ? (
                                            <select className="input-field" style={{ ...CELL, width: '3.8rem' }}
                                                    value={l.paper_size || NOT_SET}
                                                    onChange={(e) => patchRow(key, { paper_size: e.target.value === NOT_SET ? null : e.target.value })}>
                                                {!l.paper_size && <option value={NOT_SET}>—</option>}
                                                {sizeOpts.map((s) => <option key={s} value={s}>{s}</option>)}
                                            </select>
                                        ) : (l.paper_size || '—')}
                                    </td>
                                    <td>
                                        {editable && isPrint ? (
                                            <select className="input-field" style={{ ...CELL, width: '3.8rem' }}
                                                    value={l.paper_gsm || NOT_SET}
                                                    onChange={(e) => patchRow(key, { paper_gsm: e.target.value === NOT_SET ? null : e.target.value })}>
                                                {!l.paper_gsm && <option value={NOT_SET}>—</option>}
                                                {gsmOpts.map((g) => <option key={g} value={g}>{g}</option>)}
                                            </select>
                                        ) : (l.paper_gsm || '—')}
                                    </td>
                                    <td>
                                        {editable && isPrint ? (
                                            <select className="input-field" style={{ ...CELL, width: '4.2rem' }}
                                                    value={l.colour_mode || NOT_SET}
                                                    onChange={(e) => patchRow(key, { colour_mode: e.target.value === NOT_SET ? null : e.target.value })}>
                                                {!l.colour_mode && <option value={NOT_SET}>—</option>}
                                                <option value="BW">B/W</option>
                                                <option value="COLOUR">Colour</option>
                                            </select>
                                        ) : (l.colour_mode || '—')}
                                    </td>
                                    <td style={{ textAlign: 'right', fontFamily: 'monospace',
                                                 color: l.unpriced ? 'var(--stat-amber)' : 'var(--text-strong)' }}>
                                        {l._dirty ? <span className="text-muted">on save</span> : l.rate_display}
                                    </td>
                                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                                        {l._dirty ? <span className="text-muted">on save</span> : l.amount_display}
                                    </td>
                                    {editable && (
                                        <td style={{ textAlign: 'center' }}>
                                            <RemoveButton onClick={() => dropRow(key)} />
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                        {rows.length === 0 && (
                            <tr><td colSpan={editable ? 8 : 7} className="text-muted" style={{ textAlign: 'center', padding: '1.2rem' }}>
                                No lines. Add what was printed, or discard to restore.
                            </td></tr>
                        )}
                        <tr>
                            <td colSpan={editable ? 6 : 5} style={{ textAlign: 'right', fontWeight: 700 }}>Total</td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-strong)' }}>
                                {hasDirty ? <span className="text-muted" style={{ fontWeight: 400 }}>on save</span> : money(total)}
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
                            <option value="BW">B/W</option>
                            <option value="COLOUR">Colour</option>
                        </select>
                    </div>
                    <button className="btn btn-sm btn-primary" disabled={!draft.quantity} onClick={addRow}>Add</button>
                    <button className="btn btn-sm btn-outline" onClick={() => setAdding(false)}>Cancel</button>
                </div>
            )}

            {editable && (
                <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginTop: '1rem',
                              paddingTop: '0.85rem', borderTop: '1px solid var(--border)' }}>
                    <button className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={save}>
                        {busy ? 'Saving…' : 'Save & exit'}
                    </button>
                    <button className="btn btn-sm btn-outline" disabled={busy} onClick={discard}>
                        Discard changes
                    </button>
                    <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                        {dirty
                            ? 'Unsaved changes — Save writes them to the annexure, Discard throws them away.'
                            : 'No changes yet.'}
                    </span>
                </div>
            )}
        </div>
    );
};

export default CostEditor;
