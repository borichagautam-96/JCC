import React, { useState, useEffect, useCallback } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { formatDate } from '../utils/datetime';
import CostEditor from '../components/CostEditor';

// Printing cost — the entry point for the costing module.
//
// Two tabs, because the first question to answer is not "what does this cost" but
// "what can this card even price". The coverage tab measures that against the specs
// real jobs actually used, rather than assuming the masters line up.

// Ordered to mirror the New Printing Job form, so a card can be read top-to-bottom
// against what a requestor actually fills in.
const GROUP_LABEL = {
    printing: 'Paper & Printing',
    binding: 'Binding',
    finishing: 'Finishing',
    misc: 'Other services',
};

const StatusPill = ({ status }) => {
    const tone = status === 'approved' ? 'var(--stat-emerald)'
        : status === 'superseded' ? 'var(--text-muted)'
        : 'var(--stat-amber)';
    return (
        <span className="status-pill" style={{ background: 'var(--surface-3)', color: tone, fontWeight: 700 }}>
            {status}
        </span>
    );
};

const Tile = ({ label, value, sub, tone }) => (
    <div className="metric-card" style={{ minWidth: '170px' }}>
        <h3 className="metric-label">{label}</h3>
        <p className="metric-value" style={{ color: tone || 'var(--stat-blue)', fontSize: '1.6rem' }}>{value}</p>
        {sub && <span className="text-muted" style={{ fontSize: '0.78rem' }}>{sub}</span>}
    </div>
);

// Upload a rate workbook. The spreadsheet fills every rate field automatically; the
// result always lands as a draft so the figures can be checked (and edited) before
// anything is priced against them.
const ImportPanel = ({ busy, info, onUpload, onClose }) => {
    const [file, setFile] = useState(null);
    const [code, setCode] = useState('');
    const [label, setLabel] = useState('');
    const [effectiveFrom, setEffectiveFrom] = useState('');

    const submit = (e) => {
        e.preventDefault();
        onUpload(file, { code: code.trim().toUpperCase(), label: label.trim(), effective_from: effectiveFrom });
    };

    return (
        <form className="glass-card" style={{ marginBottom: '1rem' }} onSubmit={submit}>
            <h3 style={{ marginTop: 0, color: 'var(--text-strong)', fontSize: '1rem' }}>Import rates from Excel</h3>
            <p className="text-muted" style={{ fontSize: '0.82rem', marginTop: 0 }}>
                Every rate in the workbook is read and filled in for you. It is saved as a
                draft — review or edit the figures, then approve it to put it in force.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.75rem' }}>
                <div className="input-group">
                    <label className="input-label">Workbook (.xlsx) *</label>
                    <input className="input-field" type="file" accept=".xlsx,.xlsm,.xls" required
                           onChange={(e) => setFile(e.target.files?.[0] || null)} />
                </div>
                <div className="input-group">
                    <label className="input-label">New card code *</label>
                    <input className="input-field" required placeholder="e.g. RC-2027"
                           value={code} onChange={(e) => setCode(e.target.value)} />
                </div>
                <div className="input-group">
                    <label className="input-label">Description</label>
                    <input className="input-field" placeholder="e.g. 2027 rate revision"
                           value={label} onChange={(e) => setLabel(e.target.value)} />
                </div>
                <div className="input-group">
                    <label className="input-label">Effective from</label>
                    <input className="input-field" type="date"
                           value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
                </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.85rem' }}>
                <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !file || !code.trim()}>
                    {busy ? 'Reading workbook…' : 'Import'}
                </button>
                <button className="btn btn-sm btn-outline" type="button" onClick={onClose}>Close</button>
            </div>
            {info && (
                <div style={{ marginTop: '0.85rem', borderLeft: '3px solid var(--stat-green)', paddingLeft: '0.75rem' }}>
                    <strong style={{ color: 'var(--stat-green)' }}>{info.message}</strong>
                    {info.warnings?.length > 0 && (
                        <ul className="text-muted" style={{ fontSize: '0.8rem', margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
                            {info.warnings.map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                    )}
                </div>
            )}
        </form>
    );
};

const PrintingCostPage = () => {
    const { user, getToken } = useAuth();
    // The rate master (Rate Card, Coverage) is seen only by whoever holds the printer
    // coordinator or operator flag — a JCC admin without either flag does not see it,
    // matching the server-side canViewRates/canMaintainRates rule. Annexures is a
    // separate, broader permission and is unaffected.
    const canSeeRates = Number(user?.is_printer_coordinator) === 1 || Number(user?.is_printer_operator) === 1;
    // Maintenance (import, edit, approve a card) stays coordinator-only; an operator
    // reads the card to correct cost lines but does not change it.
    const canMaintain = Number(user?.is_printer_coordinator) === 1;
    // ProtectedRoute only renders this page once `user` is loaded, so this initial
    // value is accurate from the first render — no flash of the wrong default tab.
    const [tab, setTab] = useState(() => (canSeeRates ? 'card' : 'annexures'));
    const [versions, setVersions] = useState([]);
    const [activeCode, setActiveCode] = useState(null);
    const [card, setCard] = useState(null);
    const [coverage, setCoverage] = useState(null);
    const [loading, setLoading] = useState(true);
    const [annexures, setAnnexures] = useState([]);
    const [candidates, setCandidates] = useState([]);
    const [detail, setDetail] = useState(null);
    const [importInfo, setImportInfo] = useState(null);
    const [showImport, setShowImport] = useState(false);
    // Rate card sections (Paper & Printing, Binding, Finishing, Other services) collapse
    // by default — Paper & Printing alone can run 40+ lines, too long to scan flat.
    const [openGroups, setOpenGroups] = useState({});
    const toggleGroup = (g) => setOpenGroups((prev) => ({ ...prev, [g]: !prev[g] }));

    // Annexures grouped by the requestor's manager (single level — manager_id on the
    // user, not a full org-chart rollup). Sorted server-side, manager-less last, so
    // grouping here just has to walk the rows in the order they already arrive.
    // These groups open by default — unlike the 44-line rate card, a manager's team is
    // usually a handful of rows, so collapsing first would hide more than it helps.
    const [closedManagerGroups, setClosedManagerGroups] = useState(() => new Set());
    const toggleManagerGroup = (key) => setClosedManagerGroups((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const authHeaders = () => ({
        Authorization: `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
    });

    const load = useCallback(async () => {
        // Skip the call entirely rather than let a 403 surface as a page-level error
        // banner for someone who was never meant to see this data.
        if (!canSeeRates) { setLoading(false); return; }
        try {
            const res = await fetch('/api/rates/versions', { headers: authHeaders() });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || 'Could not load rate cards');
            }
            const rows = await res.json();
            setVersions(rows);
            // Rows are newest-effective first, so a future-dated draft would otherwise
            // open by default and show rates nothing is actually charged at. Open the
            // card in force instead, falling back only if none is approved.
            const today = new Date().toISOString().slice(0, 10);
            const inForce = rows.find((r) => r.status === 'approved'
                && (!r.effective_from || r.effective_from <= today)
                && (!r.effective_to || r.effective_to >= today));
            setActiveCode((prev) => prev || inForce?.code
                || rows.find((r) => r.status === 'approved')?.code || rows[0]?.code || null);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [getToken, canSeeRates]);

    useEffect(() => { load(); }, [load]);

    const loadAnnexures = useCallback(async () => {
        try {
            const [reg, cand] = await Promise.all([
                fetch('/api/annexures', { headers: authHeaders() }),
                fetch('/api/annexures/candidates', { headers: authHeaders() }),
            ]);
            if (reg.ok) setAnnexures(await reg.json());
            if (cand.ok) setCandidates(await cand.json());
        } catch (e) { console.warn('annexure load failed', e); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getToken]);

    useEffect(() => { if (tab === 'annexures') loadAnnexures(); }, [tab, loadAnnexures]);

    const act = async (url, options, onDone) => {
        setBusy(true);
        setError('');
        try {
            const res = await fetch(url, {
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                ...options,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Action failed');
            if (onDone) await onDone(data);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const issueAnnexure = (job) =>
        act(`/api/jobs/${job.id}/annexure`, { method: 'POST', body: '{}' }, async () => {
            await loadAnnexures();
        });

    const approveCard = () =>
        act(`/api/rates/versions/${activeCode}/approve`, { method: 'POST', body: '{}' }, async () => {
            await load();
            const res = await fetch(`/api/rates/versions/${activeCode}/lines`, { headers: authHeaders() });
            if (res.ok) setCard(await res.json());
        });

    const isDraft = card?.version?.status === 'draft';

    // Saved on blur. The row is refreshed from the response rather than re-fetching
    // the whole card, so editing a long list stays responsive.
    const saveRate = async (line, value) => {
        const next = String(value ?? '').trim();
        if (!next || Number(next) === Number(line.rate_display)) return;
        setError(null);
        try {
            const res = await fetch(`/api/rates/versions/${activeCode}/lines/${line.id}`, {
                method: 'PATCH',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ rate: next }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not save that rate');
            setCard((prev) => prev && ({
                ...prev,
                lines: prev.lines.map((l) => l.id === line.id
                    ? { ...l, rate_milli: data.rate_milli, rate_display: data.rate_display, needs_review: 0 }
                    : l),
            }));
        } catch (e) {
            setError(e.message);
        }
    };

    const duplicateCard = async () => {
        const code = window.prompt('Code for the new draft card', `${activeCode}-REV`);
        if (!code) return;
        act('/api/rates/versions/' + activeCode + '/duplicate', {
            method: 'POST', body: JSON.stringify({ code: code.trim().toUpperCase() }),
        }, async (data) => { await load(); setActiveCode(data.code); });
    };

    const uploadWorkbook = async (file, meta) => {
        if (!file) return;
        setBusy(true); setError(null); setImportInfo(null);
        try {
            const fd = new FormData();
            fd.append('workbook', file);
            fd.append('code', meta.code);
            fd.append('label', meta.label);
            if (meta.effective_from) fd.append('effective_from', meta.effective_from);
            const res = await fetch('/api/rates/import', { method: 'POST', headers: authHeaders(), body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Import failed');
            setImportInfo(data);
            await load();
            setActiveCode(data.code);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const openDetail = async (no) => {
        try {
            const res = await fetch(`/api/annexures/${no}`, { headers: authHeaders() });
            if (res.ok) setDetail(await res.json());
        } catch (e) { console.warn('detail load failed', e); }
    };

    // Approving is the requestor's action, on their own Job History screen — a
    // coordinator or operator only views and corrects the figures here.

    useEffect(() => {
        if (!canSeeRates || !activeCode) return;
        (async () => {
            try {
                const res = await fetch(`/api/rates/versions/${activeCode}/lines`, { headers: authHeaders() });
                if (res.ok) setCard(await res.json());
            } catch (e) { console.warn('card load failed', e); }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCode, canSeeRates]);

    useEffect(() => {
        if (!canSeeRates || tab !== 'coverage' || !activeCode) return;
        (async () => {
            try {
                const res = await fetch(`/api/rates/coverage?card=${activeCode}`, { headers: authHeaders() });
                if (res.ok) setCoverage(await res.json());
            } catch (e) { console.warn('coverage load failed', e); }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, activeCode, canSeeRates]);

    if (loading) {
        return <div className="flex items-center justify-center" style={{ minHeight: '70vh' }}><div className="spinner"></div></div>;
    }

    const grouped = (card?.lines || []).reduce((acc, l) => {
        (acc[l.cost_group] = acc[l.cost_group] || []).push(l);
        return acc;
    }, {});
    const reviewCount = (card?.lines || []).filter((l) => l.needs_review).length;

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header">
                    <div>
                        <h1 className="page-title">Printing Cost</h1>
                        <p className="page-subtitle">Rate cards and what they can price</p>
                    </div>
                </div>

                {error && (
                    <div className="glass-card" style={{ borderLeft: '3px solid var(--stat-red)', marginBottom: '1rem' }}>
                        <strong style={{ color: 'var(--stat-red)' }}>{error}</strong>
                    </div>
                )}

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
                    {/* Rate Card and Coverage are only offered to whoever holds the printer
                        coordinator or operator flag — everyone else lands straight on
                        Annexures, which is a separate permission. */}
                    {(canSeeRates ? [['card', 'Rate Card'], ['coverage', 'Coverage'], ['annexures', 'Annexures']]
                                  : [['annexures', 'Annexures']]).map(([key, label]) => (
                        <button key={key} className={`btn btn-sm ${tab === key ? 'btn-primary' : 'btn-outline'}`}
                                onClick={() => setTab(key)}>
                            {label}
                        </button>
                    ))}
                </div>

                {/* ── Rate card ──
                    Always the card in force — no version picker. A newly imported or
                    duplicated draft still becomes visible here (import/duplicate switch
                    straight to it), so review and approval are unaffected. */}
                {tab === 'card' && card && (
                    <>
                        <div className="glass-card" style={{ marginBottom: '1rem' }}>
                            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
                                <div>
                                    <div className="text-muted" style={{ fontSize: '0.72rem' }}>Card</div>
                                    <strong style={{ color: 'var(--text-strong)' }}>{card.version.code}</strong>
                                </div>
                                <div>
                                    <div className="text-muted" style={{ fontSize: '0.72rem' }}>Effective from</div>
                                    <strong style={{ color: 'var(--text-strong)' }}>{formatDate(card.version.effective_from)}</strong>
                                </div>
                                <div>
                                    <div className="text-muted" style={{ fontSize: '0.72rem' }}>Lines</div>
                                    <strong style={{ color: 'var(--text-strong)' }}>{card.lines.length}</strong>
                                </div>
                            </div>
                            {card.version.source_note && (
                                <p className="text-muted" style={{ fontSize: '0.82rem', margin: '0.75rem 0 0' }}>
                                    {card.version.source_note}
                                </p>
                            )}
                            {canMaintain && (
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
                                    <button className="btn btn-sm btn-outline" onClick={() => setShowImport((v) => !v)}>
                                        {showImport ? 'Cancel import' : 'Import rates from Excel'}
                                    </button>
                                    {!isDraft && (
                                        <button className="btn btn-sm btn-outline" disabled={busy} onClick={duplicateCard}>
                                            Duplicate as draft to edit
                                        </button>
                                    )}
                                </div>
                            )}
                            {canMaintain && (isDraft ? (
                                <p className="text-muted" style={{ fontSize: '0.8rem', margin: '0.6rem 0 0' }}>
                                    This card is a draft — rates below are editable. Click a rate, type the new
                                    figure and press Enter or click away to save.
                                </p>
                            ) : (
                                <p className="text-muted" style={{ fontSize: '0.8rem', margin: '0.6rem 0 0' }}>
                                    Approved cards are read-only: annexures already issued cite these rates.
                                    Duplicate it to make changes.
                                </p>
                            ))}
                        </div>

                        {canMaintain && showImport && (
                            <ImportPanel busy={busy} info={importInfo}
                                         onUpload={uploadWorkbook} onClose={() => setShowImport(false)} />
                        )}

                        {card.version.status !== 'approved' && (
                            <div className="glass-card" style={{
                                marginBottom: '1rem', borderLeft: '3px solid var(--stat-amber)',
                            }}>
                                <strong style={{ color: 'var(--stat-amber)' }}>Draft — this card does not price anything yet.</strong>
                                <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0.3rem 0 0' }}>
                                    Only an approved card resolves rates. {reviewCount > 0 && (
                                        <>Confirm the <strong>{reviewCount}</strong> line{reviewCount === 1 ? '' : 's'} marked
                                        below before approving — they were transcribed but could not be read with certainty.</>
                                    )}
                                </p>
                                {canMaintain && (
                                    <button className="btn btn-sm btn-primary" style={{ marginTop: '0.6rem' }}
                                            disabled={busy} onClick={approveCard}>
                                        Approve card
                                    </button>
                                )}
                            </div>
                        )}

                        {Object.keys(GROUP_LABEL).filter((g) => grouped[g]?.length).map((g) => {
                            const open = !!openGroups[g];
                            return (
                            <div className="glass-card" key={g} style={{ marginBottom: '1rem' }}>
                                <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.05rem', cursor: 'pointer',
                                             display: 'flex', alignItems: 'center', gap: '0.4rem', userSelect: 'none' }}
                                    onClick={() => toggleGroup(g)}>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{open ? '▾' : '▸'}</span>
                                    {GROUP_LABEL[g]} <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 400 }}>
                                        ({grouped[g].length})
                                    </span>
                                </h3>
                                {open && (
                                <div className="table-container" style={{ marginTop: '0.85rem' }}>
                                    <table className="table">
                                        <thead>
                                            <tr>
                                                <th>Service</th><th>Size</th><th>GSM</th><th>Colour</th><th>Variant</th>
                                                <th style={{ textAlign: 'right' }}>Rate (₹)</th><th>Unit</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {grouped[g].map((l) => (
                                                <tr key={l.id}>
                                                    <td style={{ fontWeight: 600 }}>
                                                        {l.service_label}
                                                        {/* Coerce to boolean: SQLite returns 0, and React
                                                            renders a literal 0 rather than nothing. */}
                                                        {!!l.needs_review && (
                                                            <span title={l.note || 'Needs confirmation'}
                                                                  style={{ marginLeft: '0.4rem', color: 'var(--stat-amber)', fontWeight: 700 }}>
                                                                ⚠
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td>{l.paper_size || '—'}</td>
                                                    <td>{l.paper_gsm || '—'}</td>
                                                    <td>{l.colour_mode || '—'}</td>
                                                    <td>{l.variant || '—'}</td>
                                                    {/* A draft's rates are editable in place; an approved card
                                                        is read-only because issued annexures cite it. */}
                                                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600,
                                                                 color: l.needs_review ? 'var(--stat-amber)' : 'var(--text-strong)' }}>
                                                        {isDraft && canMaintain ? (
                                                            <input
                                                                className="input-field"
                                                                type="number"
                                                                step="0.001"
                                                                min="0"
                                                                defaultValue={l.rate_display}
                                                                disabled={busy}
                                                                onBlur={(ev) => saveRate(l, ev.target.value)}
                                                                onKeyDown={(ev) => { if (ev.key === 'Enter') ev.target.blur(); }}
                                                                style={{
                                                                    width: '7rem', textAlign: 'right', fontFamily: 'monospace',
                                                                    padding: '0.25rem 0.4rem', fontSize: '0.85rem',
                                                                }}
                                                            />
                                                        ) : l.rate_display}
                                                    </td>
                                                    <td className="text-muted">{l.uom}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                )}
                            </div>
                            );
                        })}
                    </>
                )}

                {/* ── Coverage ── */}
                {tab === 'coverage' && (
                    !coverage ? (
                        <div className="glass-card"><div className="spinner"></div></div>
                    ) : (
                        <>
                            <p className="text-muted" style={{ fontSize: '0.88rem', marginBottom: '1rem', maxWidth: '70ch' }}>
                                Every paper spec that real job documents have actually used, checked against
                                this card. A combination with no rate cannot be costed — this is the number
                                to fix before building any calculation.
                            </p>

                            <div className="card-grid mb-xl" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                                <Tile label="Specs seen" value={coverage.summary?.combinations_seen ?? 0}
                                      sub="distinct size / GSM / colour" />
                                <Tile label="Specs priced" value={coverage.summary?.combinations_priced ?? 0}
                                      tone="var(--stat-emerald)" />
                                <Tile label="Spec coverage"
                                      value={coverage.summary?.combination_coverage_pct != null ? `${coverage.summary.combination_coverage_pct}%` : '—'}
                                      tone={(coverage.summary?.combination_coverage_pct ?? 0) >= 90 ? 'var(--stat-emerald)' : 'var(--stat-amber)'} />
                                <Tile label="Volume coverage"
                                      value={coverage.summary?.volume_coverage_pct != null ? `${coverage.summary.volume_coverage_pct}%` : '—'}
                                      sub="weighted by page-prints"
                                      tone={(coverage.summary?.volume_coverage_pct ?? 0) >= 90 ? 'var(--stat-emerald)' : 'var(--stat-amber)'} />
                            </div>

                            <div className="glass-card">
                                <div className="table-container">
                                    <table className="table">
                                        <thead>
                                            <tr>
                                                <th>Paper size</th><th>GSM</th><th>Colour</th>
                                                <th style={{ textAlign: 'right' }}>Docs</th>
                                                <th style={{ textAlign: 'right' }}>Page-prints</th>
                                                <th>Priced?</th><th style={{ textAlign: 'right' }}>Rate (₹)</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {coverage.combinations.length === 0 ? (
                                                <tr><td colSpan="7" className="text-center" style={{ color: 'var(--text-muted)', padding: '2rem' }}>
                                                    No job documents carry a paper spec yet — nothing to measure.
                                                </td></tr>
                                            ) : coverage.combinations.map((c, i) => (
                                                <tr key={i}>
                                                    <td style={{ fontWeight: 600 }}>{c.paper_size || '—'}</td>
                                                    <td>{c.paper_gsm || '—'}</td>
                                                    <td>{c.color_mode || '—'}</td>
                                                    <td style={{ textAlign: 'right' }}>{c.documents}</td>
                                                    <td style={{ textAlign: 'right' }}>{c.page_prints.toLocaleString()}</td>
                                                    <td>
                                                        {c.priced ? (
                                                            <span className="status-pill status-pill-approved">priced</span>
                                                        ) : (
                                                            <span className="status-pill" style={{ background: 'var(--stat-red)', color: '#fff' }}>
                                                                no rate
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                                                        {c.rate_display || '—'}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </>
                    )
                )}
                {/* ── Annexures ── */}
                {tab === 'annexures' && (
                    <>
                        {canMaintain && candidates.length > 0 && (
                            <div className="glass-card" style={{ marginBottom: '1rem' }}>
                                <h3 style={{ marginTop: 0, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
                                    Completed jobs not yet costed ({candidates.length})
                                </h3>
                                <div className="table-container">
                                    <table className="table">
                                        <thead>
                                            <tr><th>Job No</th><th>Requestor</th><th>Project</th><th>Docs</th>
                                                <th>Reworks</th><th>Completed</th>
                                                <th style={{ textAlign: 'center' }}>Action</th></tr>
                                        </thead>
                                        <tbody>
                                            {candidates.map((j) => (
                                                <tr key={j.id}>
                                                    <td style={{ fontWeight: 600 }}>{j.job_number || j.request_id}</td>
                                                    <td>{j.requestor_name || '—'}</td>
                                                    <td>{j.project_name || '—'}</td>
                                                    <td>{j.document_count}</td>
                                                    <td>{j.rework_count || 0}</td>
                                                    <td className="text-muted">{formatDate(j.completed_at)}</td>
                                                    <td style={{ textAlign: 'center' }}>
                                                        <button className="btn btn-sm btn-primary" disabled={busy}
                                                                onClick={() => issueAnnexure(j)}>
                                                            Issue annexure
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {annexures.length === 0 ? (
                            <div className="glass-card">
                                <h3 style={{ marginTop: 0, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
                                    Cost annexures (0)
                                </h3>
                                <p className="text-muted" style={{ fontSize: '0.88rem', margin: 0 }}>
                                    None yet. A completed job with a priceable spec produces one — issue it above.
                                </p>
                            </div>
                        ) : (
                            /* Grouped by the requestor's manager — sorted server-side, unassigned
                               last. Each manager's team is its own collapsible section. */
                            Object.entries(annexures.reduce((acc, a) => {
                                const key = a.manager_name || 'Unassigned';
                                (acc[key] = acc[key] || []).push(a);
                                return acc;
                            }, {})).map(([managerLabel, rows]) => {
                                const open = !closedManagerGroups.has(managerLabel);
                                const managerPs = rows[0]?.manager_ps;
                                return (
                                    <div className="glass-card" key={managerLabel} style={{ marginBottom: '1rem' }}>
                                        <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.05rem', cursor: 'pointer',
                                                     display: 'flex', alignItems: 'center', gap: '0.4rem', userSelect: 'none' }}
                                            onClick={() => toggleManagerGroup(managerLabel)}>
                                            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{open ? '▾' : '▸'}</span>
                                            {managerLabel}{managerPs && <span className="text-muted" style={{ fontWeight: 400 }}> ({managerPs})</span>}
                                            <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 400 }}>
                                                ({rows.length})
                                            </span>
                                        </h3>
                                        {open && (
                                            <div className="table-container" style={{ marginTop: '0.85rem' }}>
                                                <table className="table">
                                                    <thead>
                                                        <tr><th>Job</th><th>Department</th><th>Debit code</th>
                                                            <th>Status</th>
                                                            <th style={{ textAlign: 'right' }}>Grand total (₹)</th>
                                                            <th style={{ textAlign: 'center' }}>Action</th></tr>
                                                    </thead>
                                                    <tbody>
                                                        {rows.map((a) => (
                                                            <tr key={a.annexure_no}>
                                                                <td style={{ fontWeight: 700 }}>
                                                                    {a.job_number || a.request_id}
                                                                    {a.version > 1 && <span className="text-muted" style={{ fontWeight: 400 }}> v{a.version}</span>}
                                                                </td>
                                                                <td>{a.department_name || '—'}</td>
                                                                <td>{a.debit_code || '—'}</td>
                                                                <td><StatusPill status={a.status} /></td>
                                                                <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700,
                                                                             color: 'var(--stat-emerald)' }}>
                                                                    {a.totals_display?.grand_total}
                                                                </td>
                                                                <td style={{ textAlign: 'center' }}>
                                                                    <button className="btn btn-sm btn-outline" onClick={() => openDetail(a.annexure_no)}>View</button>
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}

                        {detail && (
                            <AnnexureDetail
                                data={detail}
                                authHeaders={authHeaders}
                                onClose={() => setDetail(null)}
                                onEdited={() => { openDetail(detail.annexure.annexure_no); loadAnnexures(); }}
                            />
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

// The annexure itself, laid out as the costing sheet it replaces.
const AnnexureDetail = ({ data, onClose, authHeaders, onEdited }) => {
    const { annexure: a, totals_display: t, lines, approvals, documents } = data;
    // A draft annexure can still be corrected to what was actually printed. Once
    // approved it is signed-off evidence and the server refuses any change.
    const [editing, setEditing] = useState(false);
    const groups = ['printing', 'binding', 'finishing', 'misc'];
    const GROUP_TITLE = { printing: 'PRINTING', binding: 'BINDING', finishing: 'FINISHING', misc: 'MISCELLANEOUS' };
    const original = lines.filter((l) => !l.rework_id);
    const rework = lines.filter((l) => l.rework_id);

    // A line with no rate on the card still appears — the work happened. It is called
    // out rather than shown as zero, because zero reads as "free" on a cost document.
    const Row = ({ l }) => (
        <tr>
            <td>
                {l.label}
                {l.detail && <div className="text-muted" style={{ fontSize: '0.75rem' }}>{l.detail}</div>}
            </td>
            <td style={{ textAlign: 'right' }}>{l.quantity.toLocaleString()}</td>
            <td className="text-muted">{l.uom}</td>
            <td style={{ textAlign: 'right', fontFamily: 'monospace',
                         color: l.unpriced ? 'var(--stat-amber)' : undefined,
                         fontSize: l.unpriced ? '0.72rem' : undefined, fontWeight: l.unpriced ? 700 : undefined }}>
                {l.rate_display}
            </td>
            <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600,
                         color: l.unpriced ? 'var(--text-faint)' : undefined }}>
                {l.amount_display}
            </td>
        </tr>
    );

    return (
        <div className="app-modal-backdrop" onClick={onClose}>
            {/* Wider than the shared app-modal-lg: the cost-correction table below has
                seven columns of its own (service, qty, size, GSM, colour, rate, amount)
                plus an action column, which the 900px default squeezed into its own
                horizontal scrollbar. */}
            <div className="app-modal app-modal-lg" onClick={(e) => e.stopPropagation()}
                 style={{ display: 'flex', flexDirection: 'column', maxHeight: '90vh', overflow: 'hidden', maxWidth: '1100px' }}>
                <div style={{ flex: 'none' }}>
                    <h2 className="app-modal-title" style={{ marginBottom: '0.3rem' }}>
                        {a.annexure_no}{a.version > 1 ? ` v${a.version}` : ''}
                    </h2>
                    <p className="text-muted" style={{ fontSize: '0.82rem', margin: 0 }}>
                        Printing Cost Annexure · rate card {a.rate_card || '\u2014'} · <StatusPill status={a.status} />
                    </p>
                    {a.status === 'draft' && (
                        <button className="btn btn-sm btn-outline" style={{ marginTop: '0.6rem' }}
                                onClick={() => setEditing((v) => !v)}>
                            {editing ? 'Done correcting' : 'Correct to actual print'}
                        </button>
                    )}
                    {a.status === 'approved' && (
                        <p className="text-muted" style={{ fontSize: '0.82rem', marginTop: '0.6rem' }}>
                            Approved by the requestor — figures are locked.
                        </p>
                    )}
                </div>

                {editing && a.status === 'draft' && (
                    <div style={{ flex: 'none', marginTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                        <CostEditor jobId={a.job_id} authHeaders={authHeaders} canEdit onChanged={onEdited} />
                    </div>
                )}

                <div style={{ overflowY: 'auto', minHeight: 0, flex: '1 1 auto', marginTop: '1rem' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: '0.6rem',
                                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                                  borderRadius: '8px', padding: '0.8rem 0.9rem', marginBottom: '1rem', fontSize: '0.82rem' }}>
                        {[['Job', a.job_number || a.request_id], ['Requestor', a.requestor_name],
                          ['Department', a.department_name], ['Debit code', a.debit_code],
                          ['Project', a.project_name], ['DT No.', a.dt_number],
                          ['Completed', formatDate(a.completed_at)], ['Location', a.location_name]].map(([k, v]) => (
                            <div key={k}>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>{k}</div>
                                <strong style={{ color: 'var(--text-strong)' }}>{v || '\u2014'}</strong>
                            </div>
                        ))}
                    </div>

                    {documents?.length > 0 && (
                        <div className="table-container" style={{ marginBottom: '1rem' }}>
                            <table className="table">
                                <thead><tr><th>Document</th><th>Copies</th><th>Pages</th><th>Size / GSM</th><th>Side</th><th>Colour</th><th>Binding</th></tr></thead>
                                <tbody>
                                    {documents.map((d, i) => (
                                        <tr key={i}>
                                            <td style={{ fontWeight: 600 }}>{d.document_name}</td>
                                            <td>{d.quantity}</td><td>{d.num_pages || '\u2014'}</td>
                                            <td>{[d.paper_size, d.paper_gsm].filter(Boolean).join(' / ') || '\u2014'}</td>
                                            <td>{d.print_side || '\u2014'}</td><td>{d.color_mode || '\u2014'}</td>
                                            <td>{d.binding_type || '\u2014'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <div className="table-container">
                        <table className="table">
                            <thead><tr><th>Service</th><th style={{ textAlign: 'right' }}>Qty</th><th>Unit</th>
                                <th style={{ textAlign: 'right' }}>Rate (₹)</th>
                                <th style={{ textAlign: 'right' }}>Amount (₹)</th></tr></thead>
                            <tbody>
                                {groups.map((g) => {
                                    const rows = original.filter((l) => l.cost_group === g);
                                    if (!rows.length) return null;
                                    return (
                                        <React.Fragment key={g}>
                                            <tr><td colSpan="5" style={{ background: 'var(--surface-2)', fontFamily: 'monospace',
                                                     fontSize: '0.7rem', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
                                                {GROUP_TITLE[g]}
                                            </td></tr>
                                            {rows.map((l) => <Row key={l.id} l={l} />)}
                                            <tr><td colSpan="4" style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                                                {GROUP_TITLE[g].charAt(0) + GROUP_TITLE[g].slice(1).toLowerCase()} subtotal
                                            </td>
                                            <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700,
                                                         borderTop: '1px solid var(--border-strong)' }}>
                                                {t[g]}
                                            </td></tr>
                                        </React.Fragment>
                                    );
                                })}
                                <tr><td colSpan="4" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--text-strong)' }}>
                                    BASIC TOTAL</td>
                                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 800,
                                                 borderTop: '2px solid var(--border-strong)', color: 'var(--text-strong)' }}>
                                        {t.basic}</td></tr>

                                {rework.length > 0 && (
                                    <>
                                        <tr><td colSpan="5" style={{ background: 'var(--warn-strip, rgba(245,158,11,0.12))',
                                                 fontFamily: 'monospace', fontSize: '0.7rem', letterSpacing: '0.08em',
                                                 color: 'var(--stat-amber)' }}>
                                            REWORK — charged separately
                                        </td></tr>
                                        {rework.map((l) => <Row key={l.id} l={l} />)}
                                        <tr><td colSpan="4" style={{ textAlign: 'right', color: 'var(--text-muted)' }}>Rework subtotal</td>
                                            <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700,
                                                         borderTop: '1px solid var(--border-strong)' }}>{t.rework}</td></tr>
                                    </>
                                )}

                                <tr><td colSpan="4" style={{ textAlign: 'right', fontWeight: 800, color: 'var(--text-strong)' }}>
                                    GRAND TOTAL</td>
                                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 800,
                                                 fontSize: '1.05rem', color: 'var(--stat-emerald)',
                                                 borderTop: '2px solid var(--border-strong)',
                                                 borderBottom: '4px double var(--border-strong)' }}>
                                        {t.grand_total}</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="text-muted" style={{ fontSize: '0.82rem', marginTop: '0.5rem', fontStyle: 'italic' }}>
                        {t.in_words}
                    </p>

                    {lines.some((l) => l.unpriced) && (
                        <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.9rem', borderRadius: '8px',
                                      background: 'var(--surface-2)', borderLeft: '3px solid var(--stat-amber)' }}>
                            <strong style={{ color: 'var(--stat-amber)', fontSize: '0.85rem' }}>
                                {lines.filter((l) => l.unpriced).length} item(s) have no rate configured
                            </strong>
                            <p className="text-muted" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0' }}>
                                They are listed above but excluded from the totals, so this grand total is
                                incomplete. Add the rates to the rate master and reissue to charge them.
                            </p>
                        </div>
                    )}

                    <h4 style={{ marginTop: '1.25rem', marginBottom: '0.4rem', color: 'var(--text-strong)' }}>Approval trail</h4>
                    <div className="table-container">
                        <table className="table">
                            <thead><tr><th>Role</th><th>Name</th><th>PS No.</th><th>Designation</th><th>Department</th><th>When</th></tr></thead>
                            <tbody>
                                {approvals.map((ap) => (
                                    <tr key={ap.id}>
                                        <td style={{ fontWeight: 600, textTransform: 'capitalize' }}>{ap.role}</td>
                                        <td>{ap.user_name}</td><td>{ap.employee_id || '\u2014'}</td>
                                        <td>{ap.designation || '\u2014'}</td><td>{ap.department || '\u2014'}</td>
                                        <td className="text-muted">{formatDate(ap.acted_at)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {a.payload_sha256 && (
                        <p className="text-muted" style={{ fontSize: '0.75rem', fontFamily: 'monospace', marginTop: '0.6rem' }}>
                            Verify: SHA-256 {a.payload_sha256.slice(0, 16)}…
                        </p>
                    )}
                </div>

                <div className="app-modal-actions" style={{ flex: 'none' }}>
                    <button className="btn btn-outline" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
};

export default PrintingCostPage;
