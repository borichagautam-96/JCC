import React, { useState, useEffect, useCallback } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { formatDate } from '../utils/datetime';
import CostEditor from '../components/CostEditor';
import DatePicker from '../components/DatePicker';

// Printing cost — the entry point for the costing module.
//
// The rate card in force, the annexures issued against it, and what is still waiting
// on someone. Rate Card is gated to the printing module; Annexures is a separate,
// broader permission.

// Ordered to mirror the New Printing Job form, so a card can be read top-to-bottom
// against what a requestor actually fills in.
// annexure_approvals.role stores the workflow step. Spelled out for the trail, where
// "returned" on its own reads like a status rather than "the requestor sent it back".
const APPROVAL_STEP = {
    prepared: 'Prepared',
    reviewed: 'Sent for approval',
    approved: 'Approved',
    returned: 'Rejected',
};

const GROUP_LABEL = {
    printing: 'Paper & Printing',
    binding: 'Binding',
    finishing: 'Finishing',
    misc: 'Other services',
};

// Money is stored as integer paise; only the display divides.
const formatMoney = (paise) =>
    `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Rows → manager → team member, with rollups at both levels.
//
// The server already orders by manager, then requestor, then job, so this walks the
// list rather than sorting it — insertion order into the Maps IS the display order,
// including "Unassigned" last. Summing in paise and formatting once at the end avoids
// the rounding drift you get from adding up already-rounded rupee strings.
const groupByManager = (rows) => {
    const managers = new Map();
    for (const row of rows) {
        const mKey = row.manager_id != null ? `m${row.manager_id}` : 'unassigned';
        if (!managers.has(mKey)) {
            managers.set(mKey, {
                key: mKey,
                name: row.manager_name || 'Unassigned',
                ps: row.manager_ps || null,
                members: new Map(),
                jobCount: 0,
                totals: { printing: 0, binding: 0, finishing: 0, grand: 0 },
            });
        }
        const mgr = managers.get(mKey);

        const uKey = row.requestor_id != null ? `u${row.requestor_id}` : `n${row.requestor_name || 'unknown'}`;
        if (!mgr.members.has(uKey)) {
            mgr.members.set(uKey, {
                key: uKey,
                name: row.requestor_name || 'Unknown',
                ps: row.requestor_ps || null,
                rows: [],
                totals: { printing: 0, binding: 0, finishing: 0, grand: 0 },
            });
        }
        const member = mgr.members.get(uKey);
        member.rows.push(row);

        for (const bucket of [mgr.totals, member.totals]) {
            bucket.printing += Number(row.printing_paise || 0);
            bucket.binding += Number(row.binding_paise || 0);
            bucket.finishing += Number(row.finishing_paise || 0);
            bucket.grand += Number(row.grand_total_paise || 0);
        }
        mgr.jobCount += 1;
    }
    return [...managers.values()].map((m) => ({ ...m, members: [...m.members.values()] }));
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
                    <DatePicker name="effective_from" value={effectiveFrom}
                                onChange={(e) => setEffectiveFrom(e.target.value)} />
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
    // The rate master (Rate Card) is seen only by whoever holds the printer coordinator
    // or operator flag — a JCC admin without either flag does not see it, matching the
    // server-side canViewRates/canMaintainRates rule. Annexures is a separate, broader
    // permission and is unaffected.
    const canSeeRates = Number(user?.is_printer_coordinator) === 1 || Number(user?.is_printer_operator) === 1;
    // Maintenance (import, edit, approve a card) stays coordinator-only; an operator
    // reads the card to correct cost lines but does not change it.
    const canMaintain = Number(user?.is_printer_coordinator) === 1;
    // Correcting a job's costing belongs to the printing floor only — the operator who
    // ran it and the coordinator who owns the queue. An admin, manager or final
    // approver reaching this page can read the annexures but not restate them, and the
    // server enforces the same rule.
    const canCorrect = Number(user?.is_printer_coordinator) === 1 || Number(user?.is_printer_operator) === 1;
    // A manager reaches this page for their own team's costs only. The issuing queue
    // and the awaiting-approval queue are printing-floor tools the API refuses them,
    // so the tabs are hidden and the calls are skipped — otherwise the page fires
    // requests that 403 and shows queues that can only ever be empty.
    const isTeamViewOnly = !canCorrect && String(user?.role || '').toLowerCase() !== 'admin';
    // ProtectedRoute only renders this page once `user` is loaded, so this initial
    // value is accurate from the first render — no flash of the wrong default tab.
    const [tab, setTab] = useState(() => (canSeeRates ? 'card' : 'annexures'));
    const [versions, setVersions] = useState([]);
    const [activeCode, setActiveCode] = useState(null);
    const [card, setCard] = useState(null);
    const [loading, setLoading] = useState(true);
    const [annexures, setAnnexures] = useState([]);
    // Filters are applied server-side: the option lists come back from the whole set in
    // scope, so narrowing on one field never empties another field's dropdown.
    const EMPTY_FILTERS = { q: '', manager: '', member: '', status: '', department: '', debit_code: '', from: '', to: '' };
    const [filters, setFilters] = useState(EMPTY_FILTERS);
    const [filterOptions, setFilterOptions] = useState({ managers: [], members: [], departments: [], debit_codes: [], statuses: [] });
    const [totalCount, setTotalCount] = useState(0);
    const activeFilterCount = Object.values(filters).filter((v) => String(v).trim()).length;
    const [candidates, setCandidates] = useState([]);
    // Drafts the requestor has not signed off. Loaded on mount rather than on tab
    // switch so the count sits on the tab itself — the whole point is that these are
    // easy to miss, and a queue you have to open to discover is no better than none.
    const [pending, setPending] = useState({ annexures: [], total_paise: 0, with_printing: 0, with_requestor: 0 });
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
    // Team members collapse independently of their manager. Open by default, like the
    // manager sections — a team is usually a handful of people, so collapsing first
    // would hide more than it helps.
    const [closedMemberGroups, setClosedMemberGroups] = useState(() => new Set());
    const toggleMemberGroup = (key) => setClosedMemberGroups((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
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
            const params = new URLSearchParams(
                Object.entries(filters).filter(([, v]) => String(v).trim())
            ).toString();
            const [reg, cand] = await Promise.all([
                fetch(`/api/annexures${params ? `?${params}` : ''}`, { headers: authHeaders() }),
                isTeamViewOnly ? Promise.resolve(null) : fetch('/api/annexures/candidates', { headers: authHeaders() }),
            ]);
            if (reg.ok) {
                const data = await reg.json();
                setAnnexures(data.annexures || []);
                setFilterOptions(data.filters || filterOptions);
                setTotalCount(data.total_count || 0);
            }
            if (cand?.ok) setCandidates(await cand.json());
        } catch (e) { console.warn('annexure load failed', e); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getToken, filters, isTeamViewOnly]);

    useEffect(() => { if (tab === 'annexures') loadAnnexures(); }, [tab, loadAnnexures]);

    const loadPending = useCallback(async () => {
        if (isTeamViewOnly) return;
        try {
            const res = await fetch('/api/annexures/pending', { headers: authHeaders() });
            if (res.ok) setPending(await res.json());
        } catch (e) { console.warn('pending annexure load failed', e); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getToken]);

    useEffect(() => { loadPending(); }, [loadPending]);

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
            await loadPending();
        });

    // The handover: the operator has checked the figures against the actual print and
    // is putting them to the requestor. Until this happens the requestor cannot approve.
    const sendForApproval = (a) =>
        act(`/api/annexures/${a.annexure_no}/send-for-approval`, { method: 'POST', body: '{}' }, async () => {
            await loadPending();
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
                    {/* Rate Card is only offered to whoever holds the printer coordinator
                        or operator flag — everyone else lands straight on Annexures,
                        which is a separate permission. */}
                    {(canSeeRates
                        ? [['card', 'Rate Card'], ['annexures', 'Annexures'],
                           ['pending', 'Awaiting Approval']]
                        : isTeamViewOnly
                            ? [['annexures', 'Annexures']]
                            : [['annexures', 'Annexures'], ['pending', 'Awaiting Approval']])
                        .map(([key, label]) => {
                        const count = key === 'pending' ? pending.annexures.length : 0;
                        const overdue = key === 'pending' && pending.annexures.some((a) => a.overdue);
                        return (
                            <button key={key} className={`btn btn-sm ${tab === key ? 'btn-primary' : 'btn-outline'}`}
                                    onClick={() => setTab(key)}>
                                {label}
                                {count > 0 && (
                                    /* Red only when something has passed the escalation
                                       threshold — a badge that is always red stops being read.
                                       Colour carries the text, not the fill: --stat-red/amber
                                       inverts to a pale tint in dark mode, where a solid fill
                                       with white text would be illegible. On the selected tab
                                       neither works — the button is already a solid accent —
                                       so the badge switches to white-on-translucent there. */
                                    <span style={{
                                        marginLeft: '0.4rem', padding: '0.05rem 0.45rem', borderRadius: '999px',
                                        fontSize: '0.72rem', fontWeight: 700, lineHeight: 1.5,
                                        ...(tab === key
                                            ? { color: '#fff', background: 'rgba(255,255,255,0.28)' }
                                            : {
                                                color: overdue ? 'var(--stat-red)' : 'var(--stat-amber)',
                                                background: `color-mix(in srgb, ${overdue ? 'var(--stat-red)' : 'var(--stat-amber)'} 18%, transparent)`,
                                            }),
                                    }}>{count}</span>
                                )}
                            </button>
                        );
                    })}
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
                                {/* Approving is a separate duty from maintaining: whoever imported
                                    or edited this card cannot be the one who puts it in force,
                                    because an approved card then prices every job that follows.
                                    The server decides; this only explains the outcome, since a
                                    disabled button with no reason reads as a bug. */}
                                {card.can_approve ? (
                                    <button className="btn btn-sm btn-primary" style={{ marginTop: '0.6rem' }}
                                            disabled={busy} onClick={approveCard}>
                                        Approve card
                                    </button>
                                ) : (
                                    <p style={{ fontSize: '0.82rem', margin: '0.6rem 0 0', color: 'var(--text-muted)' }}>
                                        {card.approval_block === 'you_prepared_it' ? (
                                            <>You {card.prepared_by?.length > 1 ? 'helped prepare' : 'prepared'} this
                                            card, so it needs a different rate approver to review and put it in force.
                                            {card.eligible_approvers === 0 && (
                                                <strong style={{ color: 'var(--stat-red)' }}>
                                                    {' '}No other rate approver is set up — ask an administrator to designate one.
                                                </strong>
                                            )}</>
                                        ) : (
                                            <>Approving a rate card is a designated duty.
                                            {card.prepared_by?.length > 0 && ` Prepared by ${card.prepared_by.join(', ')}.`}</>
                                        )}
                                    </p>
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

                {/* ── Awaiting approval ──
                    Every annexure that has not been signed off yet, oldest first. Two
                    stages share the list because either can stall the job: a draft is
                    still with the printing team, an under_review is with the requestor. */}
                {tab === 'pending' && (
                    pending.annexures.length === 0 ? (
                        <div className="glass-card">
                            <h3 style={{ marginTop: 0, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
                                Awaiting approval (0)
                            </h3>
                            <p className="text-muted" style={{ fontSize: '0.88rem', margin: 0 }}>
                                Nothing is outstanding. Every issued annexure has been checked and signed off.
                            </p>
                        </div>
                    ) : (
                        <div className="glass-card">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                                          flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.9rem' }}>
                                <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
                                    Awaiting approval ({pending.annexures.length})
                                </h3>
                                <span className="text-muted" style={{ fontSize: '0.82rem' }}>
                                    {pending.with_printing} with the printing team · {pending.with_requestor} with the requestor
                                    {' · '}{formatMoney(pending.total_paise)} unbooked
                                </span>
                            </div>
                            <div className="table-container">
                                <table className="table table-compact">
                                    <thead>
                                        <tr>
                                            <th>Annexure</th><th>Job No</th><th>Stage</th><th>Waiting on</th><th>Manager</th>
                                            <th style={{ textAlign: 'right' }}>Amount</th>
                                            <th style={{ textAlign: 'center' }}>Waiting</th>
                                            {canCorrect && <th style={{ textAlign: 'center' }}>Action</th>}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {pending.annexures.map((a) => (
                                            <tr key={a.id}>
                                                <td style={{ fontWeight: 600 }}>
                                                    {a.annexure_no}
                                                    {a.version > 1 && (
                                                        <span className="text-muted" style={{ fontSize: '0.75rem' }}> v{a.version}</span>
                                                    )}
                                                </td>
                                                <td>{a.job_number}</td>
                                                <td>
                                                    {/* A draft has not reached the requestor yet — the operator
                                                        still has to check it against the actual print. */}
                                                    <span style={{
                                                        padding: '0.1rem 0.5rem', borderRadius: '999px', fontWeight: 700,
                                                        fontSize: '0.72rem', whiteSpace: 'nowrap',
                                                        color: a.with_requestor ? 'var(--stat-blue)' : 'var(--stat-amber)',
                                                        background: `color-mix(in srgb, ${a.with_requestor ? 'var(--stat-blue)' : 'var(--stat-amber)'} 16%, transparent)`,
                                                    }}>
                                                        {a.with_requestor ? 'With requestor' : 'Needs your review'}
                                                    </span>
                                                </td>
                                                <td>
                                                    {a.with_requestor
                                                        ? (a.requestor_name || '—')
                                                        : <span className="text-muted">printing team</span>}
                                                </td>
                                                <td className="text-muted">{a.manager_name || '—'}</td>
                                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                                    {a.grand_total_display}
                                                </td>
                                                <td style={{ textAlign: 'center' }}>
                                                    <span style={{
                                                        padding: '0.1rem 0.5rem', borderRadius: '999px', fontWeight: 700,
                                                        fontSize: '0.75rem', whiteSpace: 'nowrap',
                                                        color: 'var(--stat-amber)',
                                                        background: 'color-mix(in srgb, var(--stat-amber) 18%, transparent)',
                                                    }}>
                                                        {a.waiting_days === 0 ? 'today' : `${a.waiting_days}d`}
                                                    </span>
                                                </td>
                                                {canCorrect && (
                                                    <td style={{ textAlign: 'center' }}>
                                                        {a.with_requestor ? (
                                                            <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                                                                Awaiting requestor
                                                            </span>
                                                        ) : (
                                                            <button className="btn btn-sm btn-primary" disabled={busy}
                                                                    onClick={() => sendForApproval(a)}>
                                                                Send for approval
                                                            </button>
                                                        )}
                                                    </td>
                                                )}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )
                )}

                {tab === 'annexures' && (
                    <>
                        {/* Filtering happens on the server, so the hierarchy and its rollups
                            always describe exactly the rows on screen. The manager filter is
                            hidden from a manager: their scope is already fixed to their own
                            team, and offering it would imply they could widen it. */}
                        <div className="glass-card" style={{ marginBottom: '1rem' }}>
                            <div style={{ display: 'grid', gap: '0.6rem',
                                          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                                <input className="input-field" placeholder="Job no, annexure or project…"
                                       value={filters.q}
                                       onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
                                {!isTeamViewOnly && (
                                    <select className="input-field" value={filters.manager}
                                            onChange={(e) => setFilters((f) => ({ ...f, manager: e.target.value }))}>
                                        <option value="">All managers</option>
                                        {filterOptions.managers.map((m) => (
                                            <option key={m.value} value={m.value}>{m.label}</option>
                                        ))}
                                    </select>
                                )}
                                <select className="input-field" value={filters.member}
                                        onChange={(e) => setFilters((f) => ({ ...f, member: e.target.value }))}>
                                    <option value="">All team members</option>
                                    {filterOptions.members.map((m) => (
                                        <option key={m.value} value={m.value}>{m.label}{m.ps ? ` (${m.ps})` : ''}</option>
                                    ))}
                                </select>
                                <select className="input-field" value={filters.status}
                                        onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
                                    <option value="">All statuses</option>
                                    {filterOptions.statuses.map((o) => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>
                                <select className="input-field" value={filters.department}
                                        onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}>
                                    <option value="">All departments</option>
                                    {filterOptions.departments.map((o) => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>
                                <select className="input-field" value={filters.debit_code}
                                        onChange={(e) => setFilters((f) => ({ ...f, debit_code: e.target.value }))}>
                                    <option value="">All debit codes</option>
                                    {filterOptions.debit_codes.map((o) => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>
                                {/* Bound on completion date — a cost report is about when the
                                    work finished, not when it was requested.
                                    DatePicker rather than <input type="date">: the native
                                    popup cannot be styled, so it looked nothing like the
                                    rest of the app. It emits the same
                                    { target: { name, value } } shape, so the handlers below
                                    are unchanged. */}
                                <DatePicker name="from" value={filters.from} placeholder="Completed from"
                                            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
                                <DatePicker name="to" value={filters.to} placeholder="Completed to"
                                            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
                            </div>
                            {activeFilterCount > 0 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.7rem' }}>
                                    <span className="text-muted" style={{ fontSize: '0.82rem' }}>
                                        Showing {annexures.length} of {totalCount} annexure{totalCount === 1 ? '' : 's'}
                                    </span>
                                    <button className="btn btn-sm btn-outline" onClick={() => setFilters(EMPTY_FILTERS)}>
                                        Clear filters
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Visible to anyone who can read costing, not just coordinators:
                            a completed job with no annexure is a gap everyone needs to
                            see. Only a coordinator gets the button to issue one. */}
                        {candidates.length > 0 && (
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
                                                        {canMaintain ? (
                                                            <button className="btn btn-sm btn-primary" disabled={busy}
                                                                    onClick={() => issueAnnexure(j)}>
                                                                Issue annexure
                                                            </button>
                                                        ) : (
                                                            <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                                                                Awaiting coordinator
                                                            </span>
                                                        )}
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
                                {/* "None exist" and "none match" are different problems with
                                    different fixes, so they must not share a message. */}
                                <p className="text-muted" style={{ fontSize: '0.88rem', margin: 0 }}>
                                    {activeFilterCount > 0
                                        ? `No annexure matches these filters — ${totalCount} exist${totalCount === 1 ? 's' : ''} in total.`
                                        : 'None yet. A completed job with a priceable spec produces one — issue it above.'}
                                </p>
                            </div>
                        ) : (
                            /* Manager → team member → job. Rows arrive sorted in exactly that
                               order, so grouping is a walk rather than a sort. A two-level
                               accordion over one table beats a tree view here: the costs stay
                               in aligned columns, which is what makes them readable. */
                            groupByManager(annexures).map((mgrGroup) => {
                                const open = !closedManagerGroups.has(mgrGroup.key);
                                return (
                                    <div className="glass-card" key={mgrGroup.key} style={{ marginBottom: '1rem' }}>
                                        <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.05rem', cursor: 'pointer',
                                                     display: 'flex', alignItems: 'center', gap: '0.4rem', userSelect: 'none',
                                                     flexWrap: 'wrap' }}
                                            onClick={() => toggleManagerGroup(mgrGroup.key)}>
                                            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{open ? '▾' : '▸'}</span>
                                            {mgrGroup.name}
                                            {mgrGroup.ps && <span className="text-muted" style={{ fontWeight: 400 }}> ({mgrGroup.ps})</span>}
                                            <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 400, marginLeft: 'auto' }}>
                                                {mgrGroup.members.length} team member{mgrGroup.members.length === 1 ? '' : 's'}
                                                {' · '}{mgrGroup.jobCount} job{mgrGroup.jobCount === 1 ? '' : 's'}
                                                {' · '}Print {formatMoney(mgrGroup.totals.printing)}
                                                {' · '}Bind {formatMoney(mgrGroup.totals.binding)}
                                                {' · '}Fin {formatMoney(mgrGroup.totals.finishing)}
                                            </span>
                                            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--stat-emerald)',
                                                           fontSize: '0.95rem' }}>
                                                {formatMoney(mgrGroup.totals.grand)}
                                            </span>
                                        </h3>

                                        {open && mgrGroup.members.map((member) => {
                                            const memberKey = `${mgrGroup.key}|${member.key}`;
                                            const memberOpen = !closedMemberGroups.has(memberKey);
                                            return (
                                                <div key={memberKey} style={{ marginTop: '0.85rem', paddingLeft: '1rem',
                                                                              borderLeft: '2px solid var(--border)' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem',
                                                                  cursor: 'pointer', userSelect: 'none', flexWrap: 'wrap' }}
                                                         onClick={() => toggleMemberGroup(memberKey)}>
                                                        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                                            {memberOpen ? '▾' : '▸'}
                                                        </span>
                                                        <strong style={{ color: 'var(--text-strong)', fontSize: '0.92rem' }}>
                                                            {member.name}
                                                        </strong>
                                                        {member.ps && (
                                                            <span className="text-muted" style={{ fontSize: '0.75rem' }}>{member.ps}</span>
                                                        )}
                                                        <span className="text-muted" style={{ fontSize: '0.78rem', marginLeft: 'auto' }}>
                                                            {member.rows.length} job{member.rows.length === 1 ? '' : 's'}
                                                        </span>
                                                        <span style={{ fontFamily: 'monospace', fontWeight: 700,
                                                                       color: 'var(--stat-emerald)', fontSize: '0.85rem' }}>
                                                            {formatMoney(member.totals.grand)}
                                                        </span>
                                                    </div>

                                                    {memberOpen && (
                                                        <div className="table-container" style={{ marginTop: '0.5rem' }}>
                                                            <table className="table table-compact">
                                                                <thead>
                                                                    <tr><th>Job</th><th>Project</th><th>Department</th><th>Debit code</th>
                                                                        <th>Status</th><th>Completed</th>
                                                                        <th style={{ textAlign: 'right' }}>Print</th>
                                                                        <th style={{ textAlign: 'right' }}>Bind</th>
                                                                        <th style={{ textAlign: 'right' }}>Finish</th>
                                                                        <th style={{ textAlign: 'right' }}>Total (₹)</th>
                                                                        <th style={{ textAlign: 'center' }}>Action</th></tr>
                                                                </thead>
                                                                <tbody>
                                                                    {member.rows.map((a) => (
                                                                        <tr key={a.annexure_no}>
                                                                            <td style={{ fontWeight: 700 }}>
                                                                                {a.job_number || a.request_id}
                                                                                {a.version > 1 && <span className="text-muted" style={{ fontWeight: 400 }}> v{a.version}</span>}
                                                                            </td>
                                                                            <td>{a.project_name || '—'}</td>
                                                                            <td>{a.department_name || '—'}</td>
                                                                            <td>{a.debit_code || '—'}</td>
                                                                            <td><StatusPill status={a.status} /></td>
                                                                            <td className="text-muted" style={{ fontSize: '0.78rem' }}>
                                                                                {a.completed_at ? formatDate(a.completed_at) : '—'}
                                                                            </td>
                                                                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                                                                {formatMoney(a.printing_paise)}
                                                                            </td>
                                                                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                                                                {formatMoney(a.binding_paise)}
                                                                            </td>
                                                                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                                                                {formatMoney(a.finishing_paise)}
                                                                            </td>
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
                                        })}
                                    </div>
                                );
                            })
                        )}

                        {detail && (
                            <AnnexureDetail
                                data={detail}
                                authHeaders={authHeaders}
                                onClose={() => setDetail(null)}
                                canCorrect={canCorrect}
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
const AnnexureDetail = ({ data, onClose, authHeaders, onEdited, canCorrect = false }) => {
    const { annexure: a, totals_display: t, lines, approvals, documents } = data;
    // Who signed it off, for the confirmation banner below.
    const approvedBy = approvals?.find((ap) => ap.role === 'approved');
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
                    {a.status === 'draft' && canCorrect && (
                        <>
                            <button className="btn btn-sm btn-outline" style={{ marginTop: '0.6rem' }}
                                    onClick={() => setEditing((v) => !v)}>
                                {editing ? 'Done correcting' : 'Correct to actual print'}
                            </button>
                            <p className="text-muted" style={{ fontSize: '0.8rem', margin: '0.5rem 0 0' }}>
                                Awaiting the requestor's approval. Saving a correction asks them to review it again.
                            </p>
                        </>
                    )}
                    {a.status === 'draft' && !canCorrect && (
                        <p className="text-muted" style={{ fontSize: '0.82rem', marginTop: '0.6rem' }}>
                            Awaiting the requestor's approval.
                        </p>
                    )}
                    {a.status === 'approved' && (
                        <div style={{ marginTop: '0.6rem', padding: '0.55rem 0.85rem', borderRadius: '8px',
                                      background: 'var(--surface-2)', borderLeft: '3px solid var(--stat-emerald)' }}>
                            <strong style={{ color: 'var(--stat-emerald)', fontSize: '0.85rem' }}>
                                Approved by {approvedBy?.user_name || 'the requestor'}
                                {approvedBy?.acted_at ? ` on ${formatDate(approvedBy.acted_at)}` : ''}
                            </strong>
                            <p className="text-muted" style={{ fontSize: '0.8rem', margin: '0.15rem 0 0' }}>
                                These figures are locked. Reissue the annexure to correct them.
                            </p>
                        </div>
                    )}
                </div>

                {/* The editor lives INSIDE the scrolling body, not above it. Sitting
                    outside with flex:none, a job with a dozen services grew tall enough
                    to consume the whole modal and squeeze the job details, documents and
                    totals below it down to nothing. */}
                <div style={{ overflowY: 'auto', minHeight: 0, flex: '1 1 auto', marginTop: '1rem' }}>
                    {editing && a.status === 'draft' && (
                        <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid var(--border)' }}>
                            {/* Save and Discard both leave edit mode, so the annexure below is
                                always showing saved figures rather than a half-edited draft. */}
                            <CostEditor jobId={a.job_id} authHeaders={authHeaders} canEdit
                                        onChanged={onEdited} onClose={() => setEditing(false)} />
                        </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: '0.6rem',
                                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                                  borderRadius: '8px', padding: '0.8rem 0.9rem', marginBottom: '1rem', fontSize: '0.82rem' }}>
                        {/* Mirrors the workbook's "D&T LEAD / INITIATOR" header block, so an
                            operator can see whose job this is and who owns it. */}
                        {[['Job', a.job_number || a.request_id],
                          ['Initiator', a.requestor_name && `${a.requestor_name}${a.requestor_ps ? ` (${a.requestor_ps})` : ''}`],
                          ['D&T Lead', a.lead_name],
                          ['Manager', a.manager_name && `${a.manager_name}${a.manager_ps ? ` (${a.manager_ps})` : ''}`],
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

                    {/* Hidden while correcting: the editor above lists these exact lines
                        in editable form, so showing both doubles the modal's length for
                        no gain and buries the job details below. */}
                    {!editing && (<>
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
                    </>)}

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
