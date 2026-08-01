import React, { useState, useEffect, useCallback } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { formatDateTime } from '../utils/datetime';
import CostEditor from '../components/CostEditor';

const STATUS_LABEL = {
    accepted: { cls: 'bg-sky-100 text-sky-800', label: 'Available — pick up' },
    assigned: { cls: 'bg-indigo-100 text-indigo-800', label: 'Assigned' },
    printing: { cls: 'bg-purple-100 text-purple-800', label: 'Printing' },
    paused: { cls: 'bg-amber-100 text-amber-800', label: 'Paused' },
    printing_completed: { cls: 'bg-teal-100 text-teal-800', label: 'Printed' },
    ready_for_collection: { cls: 'bg-green-100 text-green-800', label: 'Ready for Collection' },
    awaiting_receipt: { cls: 'bg-amber-100 text-amber-800', label: 'Awaiting Receipt' },
    proof_review: { cls: 'bg-blue-100 text-blue-800', label: 'Proof Review' },
    recalled: { cls: 'bg-slate-100 text-slate-700', label: 'Recalled' },
    rework_requested: { cls: 'bg-orange-100 text-orange-800', label: 'Rework Pending' },
    rework_printing: { cls: 'bg-purple-100 text-purple-800', label: 'Rework Printing' },
};

const PrintOperatorPage = () => {
    const { getToken } = useAuth();
    const dialog = useDialog();
    const [jobs, setJobs] = useState([]);
    const [details, setDetails] = useState({}); // jobId -> documents[]
    const [expanded, setExpanded] = useState(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');

    const authHeaders = (extra = {}) => ({
        Authorization: `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
        ...extra,
    });

    const [reworks, setReworks] = useState({});   // job_id -> open rework

    const openReworkPdf = async (jobId, reworkRowId) => {
        try {
            const res = await fetch(`/api/jobs/${jobId}/reworks/${reworkRowId}/file`, { headers: authHeaders() });
            if (!res.ok) return;
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            window.open(url, '_blank', 'noopener');
            setTimeout(() => window.URL.revokeObjectURL(url), 60000);
        } catch (e) {
            console.warn('open rework pdf failed', e);
        }
    };

    const fetchJobs = useCallback(async () => {
        try {
            const [res, rw] = await Promise.all([
                fetch('/api/jobs/assigned', { headers: authHeaders() }),
                fetch('/api/jobs/reworks/assigned', { headers: authHeaders() }),
            ]);
            if (rw.ok) {
                const rows = await rw.json();
                // Keyed by job so a row can show its rework instructions inline.
                setReworks(Object.fromEntries(rows.map((r) => [r.job_id, r])));
            }
            if (res.ok) setJobs(await res.json());
            else setJobs([]);
        } catch (e) {
            console.error('operator fetch failed', e);
        } finally {
            setLoading(false);
        }
    }, [getToken]);

    useEffect(() => {
        fetchJobs();
        const interval = setInterval(fetchJobs, 30000);
        return () => clearInterval(interval);
    }, [fetchJobs]);

    const loadDetails = async (jobId) => {
        try {
            const res = await fetch(`/api/jobs/${jobId}`, { headers: authHeaders() });
            if (res.ok) {
                const data = await res.json();
                setDetails((prev) => ({ ...prev, [jobId]: data.documents || [] }));
            }
        } catch (e) {
            console.warn('detail load failed', e);
        }
    };

    const toggle = async (job) => {
        if (expanded === job.id) { setExpanded(null); return; }
        setExpanded(job.id);
        await loadDetails(job.id);
    };

    const act = async (url, successMsg) => {
        setBusy(true);
        try {
            const res = await fetch(url, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Action failed');
            await dialog.alert(successMsg || data.message, { title: 'Done', variant: 'success' });
            await fetchJobs();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        } finally {
            setBusy(false);
        }
    };

    const toggleFinishing = async (jobId, doc) => {
        try {
            const res = await fetch(`/api/jobs/${jobId}/documents/${doc.id}/finishing`, {
                method: 'PUT',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ done: !doc.finishing_done }),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed');
            }
            await loadDetails(jobId);
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    // Opens the CURRENT version. The server decides which file that is — once a
    // rework exists the original is superseded, and printing from it reproduces the
    // very output that was rejected.
    const openDocument = async (jobId, doc) => {
        const url = typeof doc === 'object' && doc.current_file_url
            ? doc.current_file_url
            : `/api/jobs/${jobId}/documents/${typeof doc === 'object' ? doc.id : doc}/file`;
        try {
            const res = await fetch(url, { headers: authHeaders() });
            if (!res.ok) return;
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            window.open(url, '_blank', 'noopener');
            setTimeout(() => window.URL.revokeObjectURL(url), 60000);
        } catch (e) {
            console.warn('open failed', e);
        }
    };

    const actionsFor = (job) => {
        switch (job.status) {
            case 'accepted':
                return <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/start`, 'You picked up the job — now printing.')}>Pick up &amp; Start</button>;
            case 'assigned':
                return <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/start`)}>Start Printing</button>;
            case 'printing':
                return (
                    <>
                        <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/pause`)}>Pause</button>
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/complete-printing`, 'Printing marked complete.')}>Complete Printing</button>
                    </>
                );
            case 'paused':
                return (
                    <>
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/resume`)}>Resume</button>
                        <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/complete-printing`, 'Printing marked complete.')}>Complete Printing</button>
                    </>
                );
            case 'rework_requested': {
                const rw = reworks[job.id];
                if (!rw) return <span className="text-muted" style={{ fontSize: '0.82rem' }}>Awaiting rework details</span>;
                return <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/reworks/${rw.id}/start`, `${rw.rework_id} started.`)}>Start Rework {rw.rework_id}</button>;
            }
            case 'rework_printing': {
                const rw = reworks[job.id];
                if (!rw) return null;
                return <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/reworks/${rw.id}/complete`, `${rw.rework_id} completed.`)}>Mark Rework Complete</button>;
            }
            case 'printing_completed':
                return <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/ready`, 'Marked ready for collection.')}>Mark Ready for Collection</button>;
            case 'ready_for_collection':
                return <span className="text-muted" style={{ fontSize: '0.82rem' }}>Awaiting coordinator handover</span>;
            default:
                return null;
        }
    };

    if (loading) {
        return <div className="flex items-center justify-center" style={{ minHeight: '80vh' }}><div className="spinner"></div></div>;
    }

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header">
                    <div>
                        <h1 className="page-title">Printer Operator</h1>
                        <p className="page-subtitle">Your assigned print jobs — execution and finishing</p>
                    </div>
                </div>

                <div className="glass-card" style={{ marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <input className="input-field premium-search-field" style={{ flex: '1 1 260px' }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search job no or requestor…" />
                    {search && <button className="btn btn-sm btn-outline" onClick={() => setSearch('')}>Clear</button>}
                </div>

                <div className="glass-card">
                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr><th>Job No</th><th>Requestor</th><th>Docs</th><th>Status</th><th>Assigned</th><th style={{ textAlign: 'center', minWidth: '260px' }}>Action</th></tr>
                            </thead>
                            <tbody>
                                {(() => {
                                    const q = search.trim().toLowerCase();
                                    const filtered = q ? jobs.filter((j) => [(j.job_number || ''), (j.request_id || ''), (j.requestor_name || '')].some((v) => v.toLowerCase().includes(q))) : jobs;
                                    return filtered.length === 0 ? (
                                    <tr><td colSpan="6" className="text-center" style={{ color: '#999', padding: '2rem' }}>{jobs.length === 0 ? 'No jobs assigned to you.' : 'No jobs match your search.'}</td></tr>
                                ) : filtered.map((job) => {
                                    const b = STATUS_LABEL[job.status] || { cls: 'bg-slate-100 text-slate-700', label: job.status };
                                    const canFinish = job.status === 'printing' || job.status === 'paused';
                                    return (
                                        <React.Fragment key={job.id}>
                                            {reworks[job.id] && (
                                                <tr>
                                                    <td colSpan="6" style={{ padding: 0 }}>
                                                        <div style={{ margin: '0.5rem 0 0', padding: '0.7rem 0.9rem', borderRadius: '8px',
                                                                      background: 'var(--warn-banner-bg, rgba(245,158,11,0.14))',
                                                                      border: '1px solid rgba(245,158,11,0.38)' }}>
                                                            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                                                                <strong style={{ color: 'var(--text-strong)', fontSize: '0.85rem' }}>
                                                                    {reworks[job.id].rework_id} · V{reworks[job.id].version_no} — print only these pages:
                                                                </strong>
                                                                <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--stat-amber)', fontSize: '0.95rem' }}>
                                                                    {reworks[job.id].modified_pages_norm || reworks[job.id].modified_pages}
                                                                </span>
                                                                {reworks[job.id].additional_pages > 0 && (
                                                                    <span style={{ fontSize: '0.82rem', color: 'var(--text-body)' }}>
                                                                        + {reworks[job.id].additional_pages} new page(s), {reworks[job.id].insert_position}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div style={{ fontSize: '0.82rem', color: 'var(--text-body)', marginTop: '0.3rem' }}>
                                                                {reworks[job.id].change_description}
                                                            </div>
                                                            {reworks[job.id].coordinator_remarks && (
                                                                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                                                                    Remarks: {reworks[job.id].coordinator_remarks}
                                                                </div>
                                                            )}
                                                            <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                                <button className="btn btn-sm btn-primary"
                                                                        onClick={() => openReworkPdf(job.id, reworks[job.id].id)}>
                                                                    Open V{reworks[job.id].version_no} PDF (print from this)
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                            <tr>
                                                <td style={{ fontWeight: 600 }}>
                                                    {job.job_number || job.request_id}
                                                    {Number(job.priority) === 1 && (
                                                        <span style={{ marginLeft: '0.4rem', fontSize: '0.68rem', fontWeight: 700, color: '#B91C1C', background: '#FEE2E2', borderRadius: '6px', padding: '1px 5px' }}>🔥 RUSH</span>
                                                    )}
                                                </td>
                                                <td>{job.requestor_name}</td>
                                                <td>{job.document_count}</td>
                                                <td><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${b.cls}`}>{b.label}</span></td>
                                                <td className="text-muted">{formatDateTime(job.assigned_at)}</td>
                                                <td style={{ textAlign: 'center' }}>
                                                    <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center' }}>
                                                        <button className="btn btn-sm btn-outline" onClick={() => toggle(job)}>{expanded === job.id ? 'Hide' : 'Documents'}</button>
                                                        {actionsFor(job)}
                                                    </div>
                                                </td>
                                            </tr>
                                            {expanded === job.id && (
                                                <tr>
                                                    <td colSpan="6" style={{ background: 'var(--surface-2)' }}>
                                                        {!details[job.id] ? (
                                                            <div className="text-muted" style={{ padding: '0.5rem' }}>Loading…</div>
                                                        ) : (
                                                            <table className="table" style={{ margin: 0 }}>
                                                                <thead>
                                                                    <tr>
                                                                        <th>Document</th><th>Qty</th><th>Pages</th><th>Side</th><th>Size/GSM</th>
                                                                        <th>Colour</th><th>Binding</th><th>Extras</th><th>PDF</th>
                                                                        {canFinish && <th>Finishing Done</th>}
                                                                    </tr>
                                                                </thead>
                                                                <tbody>
                                                                    {details[job.id].map((d) => (
                                                                        <tr key={d.id}>
                                                                            <td style={{ fontWeight: 600 }}>{d.document_name}</td>
                                                                            <td>{d.quantity}</td>
                                                                            <td>{d.num_pages || '-'}</td>
                                                                            <td>{d.print_side || '-'}</td>
                                                                            <td>{[d.paper_size, d.paper_gsm].filter(Boolean).join(' / ') || '-'}</td>
                                                                            <td>{d.color_mode || '-'}</td>
                                                                            <td>{d.binding_type || '-'}</td>
                                                                            <td style={{ fontSize: '0.78rem', color: 'var(--text-body)' }}>
                                                                                {[d.soft_lamination && 'Lamination', d.separators && 'Separators', d.hole_punch && 'Hole Punch', d.cover_page && `Cover: ${d.cover_page}`].filter(Boolean).join(', ') || '-'}
                                                                            </td>
                                                                            <td>
                                                                                <button className={`btn btn-sm ${d.superseded ? 'btn-primary' : 'btn-outline'}`}
                                                                                        onClick={() => openDocument(job.id, d)}
                                                                                        title={d.superseded
                                                                                            ? `Opens ${d.current_rework_id} — the revised document. The original is superseded.`
                                                                                            : 'Opens the submitted document'}>
                                                                                    Open V{d.current_version || 1}
                                                                                </button>
                                                                                {d.superseded && (
                                                                                    <div style={{ fontSize: '0.68rem', color: 'var(--stat-amber)', fontWeight: 600, marginTop: '0.15rem' }}>
                                                                                        revised — do not print V1
                                                                                    </div>
                                                                                )}
                                                                            </td>
                                                                            {canFinish && (
                                                                                <td style={{ textAlign: 'center' }}>
                                                                                    <input type="checkbox" checked={!!d.finishing_done} onChange={() => toggleFinishing(job.id, d)} />
                                                                                </td>
                                                                            )}
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        )}

                                                        {/* The spec above is what the requestor asked for. What
                                                            actually ran is decided at the machine, so the costing
                                                            is corrected here by the operator who printed it. */}
                                                        <CostEditor
                                                            jobId={job.id}
                                                            authHeaders={authHeaders}
                                                            canEdit
                                                        />
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    );
                                });
                                })()}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PrintOperatorPage;
