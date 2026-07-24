import React, { useState, useEffect, useCallback } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const TABS = [
    { key: 'pending', label: 'Pending Verification' },
    { key: 'queue', label: 'Print Queue' },
    { key: 'ready', label: 'Ready for Collection' },
    { key: 'dispatched', label: 'In Transit' },
];

const formatDate = (v) => {
    if (!v) return '-';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
};

// Audit action code → friendly label + dot colour for the activity timeline.
const ACTION_META = {
    CREATE_PRINT_REQUEST: { label: 'Request created', color: 'var(--text-muted)' },
    SUBMIT_PRINT_JOB: { label: 'Submitted for verification', color: '#2563EB' },
    ACCEPT_PRINT_JOB: { label: 'Accepted & queued', color: '#0D9488' },
    RETURN_PRINT_JOB: { label: 'Returned for correction', color: '#EA580C' },
    REJECT_PRINT_JOB: { label: 'Rejected', color: '#DC2626' },
    ASSIGN_PRINT_JOB: { label: 'Assigned to operator', color: '#4F46E5' },
    START_PRINTING: { label: 'Printing started', color: '#7C3AED' },
    PAUSE_PRINTING: { label: 'Printing paused', color: '#D97706' },
    RESUME_PRINTING: { label: 'Printing resumed', color: '#7C3AED' },
    COMPLETE_PRINTING: { label: 'Printing completed', color: '#0891B2' },
    READY_FOR_COLLECTION: { label: 'Ready for collection', color: '#16A34A' },
    DISPATCH_PRINT_JOB: { label: 'Dispatched (courier)', color: '#7C3AED' },
    DELIVER_PRINT_JOB: { label: 'Delivered', color: '#15803D' },
    COMPLETE_PRINT_JOB: { label: 'Collected & closed', color: '#15803D' },
};
const actionMeta = (a) => ACTION_META[a] || { label: a, color: 'var(--text-muted)' };

const PrintCoordinatorPage = () => {
    const { getToken } = useAuth();
    const dialog = useDialog();
    const [tab, setTab] = useState('pending');
    const [pending, setPending] = useState([]);
    const [queue, setQueue] = useState([]);
    const [ready, setReady] = useState([]);
    const [dispatched, setDispatched] = useState([]);
    const [operators, setOperators] = useState([]);
    const [assignChoice, setAssignChoice] = useState({}); // jobId -> operatorId
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState('');
    // Dispatch modal
    const [dispatchJob, setDispatchJob] = useState(null);
    const [dispatchForm, setDispatchForm] = useState({ courier_name: '', docket_no: '', books: '', packets: '', remarks: '' });

    const authHeaders = (extra = {}) => ({
        Authorization: `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
        ...extra,
    });

    const fetchAll = useCallback(async () => {
        try {
            const [p, q, r, d, o] = await Promise.all([
                fetch('/api/jobs/pending', { headers: authHeaders() }),
                fetch('/api/jobs/queue', { headers: authHeaders() }),
                fetch('/api/jobs/ready', { headers: authHeaders() }),
                fetch('/api/jobs/dispatched', { headers: authHeaders() }),
                fetch('/api/jobs/operators', { headers: authHeaders() }),
            ]);
            if (p.ok) setPending(await p.json());
            if (q.ok) setQueue(await q.json());
            if (r.ok) setReady(await r.json());
            if (d.ok) setDispatched(await d.json());
            if (o.ok) setOperators(await o.json());
        } catch (e) {
            console.error('coordinator fetch failed', e);
        }
    }, [getToken]);

    useEffect(() => {
        fetchAll();
        const interval = setInterval(fetchAll, 30000);
        return () => clearInterval(interval);
    }, [fetchAll]);

    const act = async (url, options, successMsg) => {
        setBusy(true);
        try {
            const res = await fetch(url, { headers: authHeaders({ 'Content-Type': 'application/json' }), ...options });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Action failed');
            await dialog.alert(successMsg || data.message, { title: 'Done', variant: 'success' });
            await fetchAll();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        } finally {
            setBusy(false);
        }
    };

    const accept = (job) => act(`/api/jobs/${job.id}/accept`, { method: 'POST', body: '{}' }, `${job.job_number} accepted and queued.`);

    const returnJob = async (job) => {
        const reason = await dialog.prompt(`Return ${job.job_number} for correction — reason:`, { title: 'Return for correction', placeholder: 'Reason…', multiline: true });
        if (reason == null) return;
        if (!reason.trim()) { await dialog.alert('A remark is required.', { title: 'Missing remark', variant: 'warning' }); return; }
        act(`/api/jobs/${job.id}/return`, { method: 'POST', body: JSON.stringify({ remarks: reason.trim() }) });
    };

    const reject = async (job) => {
        const reason = await dialog.prompt(`Reject ${job.job_number} — reason (mandatory):`, { title: 'Reject job', placeholder: 'Reason (required)…', variant: 'warning', multiline: true });
        if (reason == null) return;
        if (!reason.trim()) { await dialog.alert('A reason is required.', { title: 'Missing reason', variant: 'warning' }); return; }
        const ok = await dialog.confirm(`Reject ${job.job_number}? This cannot be undone.`, { title: 'Reject job' });
        if (!ok) return;
        act(`/api/jobs/${job.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
    };

    const assign = async (job) => {
        const operatorId = assignChoice[job.id];
        if (!operatorId) { await dialog.alert('Pick an operator first.', { title: 'No operator', variant: 'warning' }); return; }
        act(`/api/jobs/${job.id}/assign`, { method: 'POST', body: JSON.stringify({ operatorId: Number(operatorId) }) });
    };

    const collect = async (job) => {
        const ok = await dialog.confirm(`Confirm ${job.job_number} was handed over to ${job.requestor_name}? It becomes read-only.`, { title: 'Confirm handover' });
        if (!ok) return;
        act(`/api/jobs/${job.id}/collect`, { method: 'POST', body: '{}' });
    };

    const openDispatch = (job) => {
        setDispatchForm({ courier_name: '', docket_no: '', books: '', packets: '', remarks: '' });
        setDispatchJob(job);
    };
    const submitDispatch = async () => {
        if (!dispatchForm.courier_name.trim()) { await dialog.alert('Courier / carrier is required.', { title: 'Missing field', variant: 'warning' }); return; }
        const job = dispatchJob;
        setDispatchJob(null);
        act(`/api/jobs/${job.id}/dispatch`, { method: 'POST', body: JSON.stringify(dispatchForm) });
    };
    const markDelivered = async (job) => {
        const receivedBy = await dialog.prompt(`Confirm delivery of ${job.job_number}. Received by (name):`, { title: 'Confirm delivery', placeholder: 'Received by (name)' });
        if (receivedBy == null) return;
        act(`/api/jobs/${job.id}/deliver`, { method: 'POST', body: JSON.stringify({ received_by: receivedBy.trim() }) });
    };

    // ── Document review (expand a job to see every document + open its PDF) ──────
    const [openJob, setOpenJob] = useState(null);
    const [jobDocs, setJobDocs] = useState({});
    const [jobInfo, setJobInfo] = useState({}); // jobId -> full job (recipient, request details)
    const [jobLogs, setJobLogs] = useState({}); // jobId -> { events, totals }

    const toggleDocs = async (job) => {
        if (openJob === job.id) { setOpenJob(null); return; }
        setOpenJob(job.id);
        if (!jobDocs[job.id]) {
            try {
                const res = await fetch(`/api/jobs/${job.id}`, { headers: authHeaders() });
                if (res.ok) {
                    const data = await res.json();
                    setJobDocs((prev) => ({ ...prev, [job.id]: data.documents || [] }));
                    setJobInfo((prev) => ({ ...prev, [job.id]: data }));
                }
            } catch (e) {
                console.warn('docs load failed', e);
            }
        }
        // Always refresh the activity log (operator actions change over time).
        try {
            const res = await fetch(`/api/jobs/${job.id}/log`, { headers: authHeaders() });
            if (res.ok) {
                const logData = await res.json();
                setJobLogs((prev) => ({ ...prev, [job.id]: logData }));
            }
        } catch (e) {
            console.warn('log load failed', e);
        }
    };

    const openDocument = async (jobId, docId) => {
        try {
            const res = await fetch(`/api/jobs/${jobId}/documents/${docId}/file`, { headers: authHeaders() });
            if (!res.ok) return;
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            window.open(url, '_blank', 'noopener');
            setTimeout(() => window.URL.revokeObjectURL(url), 60000);
        } catch (e) {
            console.warn('open failed', e);
        }
    };

    // Clickable "Docs" count that toggles the document panel.
    const docsCell = (job) => (
        <td>
            <button
                onClick={() => toggleDocs(job)}
                style={{ background: 'none', border: 'none', color: '#2563EB', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                title="View documents"
            >
                {job.document_count} {openJob === job.id ? '▾' : '▸'}
            </button>
        </td>
    );

    // Expandable documents sub-row (spans the whole table).
    const docsRow = (jobId, colSpan) => {
        if (openJob !== jobId) return null;
        const docs = jobDocs[jobId];
        const info = jobInfo[jobId];
        return (
            <tr>
                <td colSpan={colSpan} style={{ background: 'var(--surface-2)' }}>
                    {/* Recipient + key request details */}
                    {info && (
                        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
                            <div style={{ flex: '1 1 260px', background: '#EFF6FF', border: '1px solid #DBEAFE', borderRadius: '8px', padding: '0.65rem 0.85rem' }}>
                                <div style={{ fontWeight: 700, color: '#1E3A5F', fontSize: '0.82rem', marginBottom: '0.3rem' }}>Recipient Details</div>
                                {(info.recipient_name || info.recipient_contact || info.recipient_address) ? (
                                    <>
                                        <div style={{ fontSize: '0.85rem', color: 'var(--text-strong)', fontWeight: 600 }}>{info.recipient_name || '-'}{info.recipient_contact ? ` · ${info.recipient_contact}` : ''}</div>
                                        {info.recipient_address && <div style={{ fontSize: '0.82rem', color: 'var(--text-body)', marginTop: '2px' }}>{info.recipient_address}</div>}
                                    </>
                                ) : <div className="text-muted" style={{ fontSize: '0.82rem' }}>No recipient details provided.</div>}
                            </div>
                            <div style={{ flex: '1 1 260px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.65rem 0.85rem' }}>
                                <div style={{ fontWeight: 700, color: 'var(--text-body)', fontSize: '0.82rem', marginBottom: '0.3rem' }}>Request Info</div>
                                <div style={{ fontSize: '0.82rem', color: 'var(--text-body)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 10px' }}>
                                    <span>Initiator: <strong>{info.employee_name || '-'}</strong></span>
                                    <span>PS No: {info.employee_id || '-'}</span>
                                    <span>Dept Code: {info.department_code || '-'}</span>
                                    <span>Classification: {info.classification || '-'}</span>
                                    <span>Purpose: {info.purpose || '-'}</span>
                                    <span>Pages: {info.number_of_pages || '-'}</span>
                                    <span>Lead: {info.lead_name || '-'}</span>
                                    <span>VL Review: {info.vl_review || '-'}</span>
                                </div>
                            </div>
                        </div>
                    )}
                    {!docs ? (
                        <div className="text-muted" style={{ padding: '0.5rem' }}>Loading documents…</div>
                    ) : docs.length === 0 ? (
                        <div className="text-muted" style={{ padding: '0.5rem' }}>No documents.</div>
                    ) : (
                        <table className="table" style={{ margin: 0 }}>
                            <thead>
                                <tr>
                                    <th>Document</th><th>Qty</th><th>Pages</th><th>Side</th><th>Size / GSM</th>
                                    <th>Colour</th><th>Binding</th><th>Extras</th><th>PDF</th>
                                </tr>
                            </thead>
                            <tbody>
                                {docs.map((d) => (
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
                                        <td><button className="btn btn-sm btn-outline" onClick={() => openDocument(jobId, d.id)}>Open</button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {/* Activity log — every step, including the operator's actions */}
                    {jobLogs[jobId] && (
                        <div style={{ marginTop: '1rem' }}>
                            <div style={{ fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.6rem', fontSize: '0.9rem' }}>Activity Log</div>
                            {jobLogs[jobId].events.length === 0 ? (
                                <div className="text-muted" style={{ fontSize: '0.85rem' }}>No activity recorded yet.</div>
                            ) : (
                                <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                                    {jobLogs[jobId].events.map((ev, i) => {
                                        const m = actionMeta(ev.action);
                                        return (
                                            <div key={i} style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: '-1.28rem', top: '3px', width: '10px', height: '10px', borderRadius: '50%', background: m.color, border: '2px solid var(--surface)' }} />
                                                <div style={{ fontSize: '0.87rem', fontWeight: 600, color: 'var(--text-strong)' }}>{m.label}</div>
                                                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                                    {formatDate(ev.created_at)}{ev.user_name ? ` · ${ev.user_name}` : ''}
                                                </div>
                                                {ev.details && <div style={{ fontSize: '0.78rem', color: 'var(--text-body)', marginTop: '2px' }}>{ev.details}</div>}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </td>
            </tr>
        );
    };

    const jobCell = (job) => (
        <td style={{ fontWeight: 600 }}>
            {job.job_number || job.request_id}
            {Number(job.priority) === 1 && (
                <span style={{ marginLeft: '0.4rem', fontSize: '0.68rem', fontWeight: 700, color: '#B91C1C', background: '#FEE2E2', borderRadius: '6px', padding: '1px 5px' }}>🔥 RUSH</span>
            )}
            <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)', fontWeight: 400 }}>{job.request_id}</div>
            {job.location_name && (
                <div style={{ fontSize: '0.72rem', color: '#0369A1', fontWeight: 600 }}>📍 {job.location_name}</div>
            )}
        </td>
    );

    // Search across the active tab; rush toggle; SLA aging colour on timestamps.
    const q = search.trim().toLowerCase();
    const filterList = (list) => (!q ? list : list.filter((j) => [(j.job_number || ''), (j.request_id || ''), (j.requestor_name || '')].some((v) => v.toLowerCase().includes(q))));
    const toggleRush = (job) => act(`/api/jobs/${job.id}/priority`, { method: 'POST', body: JSON.stringify({ rush: Number(job.priority) === 1 ? 0 : 1 }) });
    const agingCell = (dateStr) => {
        if (!dateStr) return { color: 'var(--text-muted)' };
        const hrs = (Date.now() - new Date(dateStr).getTime()) / 3.6e6;
        if (hrs >= 48) return { color: '#B91C1C', fontWeight: 600 }; // > 2 days
        if (hrs >= 24) return { color: '#B45309', fontWeight: 600 }; // > 1 day
        return { color: 'var(--text-muted)' };
    };
    const rushBtn = (job) => (
        <button className="btn btn-sm btn-outline" style={Number(job.priority) === 1 ? { color: '#B91C1C', borderColor: '#FCA5A5' } : {}} disabled={busy} onClick={() => toggleRush(job)} title="Toggle rush priority">
            {Number(job.priority) === 1 ? 'Unrush' : 'Rush'}
        </button>
    );

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header">
                    <div>
                        <h1 className="page-title">Printing Coordinator</h1>
                        <p className="page-subtitle">Verify requests, manage the queue, assign operators, and close jobs</p>
                    </div>
                </div>

                {/* Tabs */}
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
                    {TABS.map((t) => {
                        const counts = { pending: pending.length, queue: queue.length, ready: ready.length, dispatched: dispatched.length };
                        const count = counts[t.key] || 0;
                        return (
                            <button
                                key={t.key}
                                onClick={() => setTab(t.key)}
                                style={{
                                    padding: '0.55rem 1rem', borderRadius: '10px', fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer',
                                    border: tab === t.key ? '1px solid #1E3A5F' : '1px solid #E2E8F0',
                                    background: tab === t.key ? '#1E3A5F' : '#fff',
                                    color: tab === t.key ? '#fff' : '#475569',
                                }}
                            >
                                {t.label} {count > 0 && <span style={{ opacity: 0.85 }}>({count})</span>}
                            </button>
                        );
                    })}
                </div>

                {/* Search */}
                <div className="glass-card" style={{ marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <input className="input-field premium-search-field" style={{ flex: '1 1 260px' }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search job no or requestor…" />
                    {search && <button className="btn btn-sm btn-outline" onClick={() => setSearch('')}>Clear</button>}
                </div>

                {/* Pending */}
                {tab === 'pending' && (
                    <div className="glass-card">
                        <div className="table-container">
                            <table className="table">
                                <thead>
                                    <tr><th>Job No</th><th>Requestor</th><th>Project</th><th>Docs</th><th>Debit Code</th><th>Submitted</th><th style={{ textAlign: 'center' }}>Action</th></tr>
                                </thead>
                                <tbody>
                                    {filterList(pending).length === 0 ? (
                                        <tr><td colSpan="7" className="text-center" style={{ color: '#999', padding: '2rem' }}>No jobs awaiting verification.</td></tr>
                                    ) : filterList(pending).map((job) => (
                                        <React.Fragment key={job.id}>
                                        <tr>
                                            {jobCell(job)}
                                            <td>{job.requestor_name}</td>
                                            <td>{job.project_name || '-'}</td>
                                            {docsCell(job)}
                                            <td>{job.debit_code || '-'}</td>
                                            <td style={agingCell(job.submitted_at)}>{formatDate(job.submitted_at)}</td>
                                            <td style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => accept(job)}>Accept</button>
                                                    <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => returnJob(job)}>Return</button>
                                                    <button className="btn btn-sm btn-outline" style={{ color: '#DC2626', borderColor: '#FCA5A5' }} disabled={busy} onClick={() => reject(job)}>Reject</button>
                                                    {rushBtn(job)}
                                                </div>
                                            </td>
                                        </tr>
                                        {docsRow(job.id, 7)}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Queue + assign */}
                {tab === 'queue' && (
                    <div className="glass-card">
                        <div className="table-container">
                            <table className="table">
                                <thead>
                                    <tr><th>#</th><th>Job No</th><th>Requestor</th><th>Docs</th><th>Submitted</th><th style={{ minWidth: '260px', textAlign: 'center' }}>Assign Operator</th></tr>
                                </thead>
                                <tbody>
                                    {filterList(queue).length === 0 ? (
                                        <tr><td colSpan="6" className="text-center" style={{ color: '#999', padding: '2rem' }}>Queue is empty.</td></tr>
                                    ) : filterList(queue).map((job) => (
                                        <React.Fragment key={job.id}>
                                        <tr>
                                            <td style={{ fontWeight: 700 }}>{job.queue_position}</td>
                                            {jobCell(job)}
                                            <td>{job.requestor_name}</td>
                                            {docsCell(job)}
                                            <td style={agingCell(job.submitted_at)}>{formatDate(job.submitted_at)}</td>
                                            <td>
                                                <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
                                                    <select
                                                        className="input-field"
                                                        style={{ width: 'auto', minWidth: '150px' }}
                                                        value={assignChoice[job.id] || ''}
                                                        onChange={(e) => setAssignChoice((prev) => ({ ...prev, [job.id]: e.target.value }))}
                                                    >
                                                        <option value="">Select operator…</option>
                                                        {operators.map((o) => (
                                                            <option key={o.id} value={o.id}>{o.name} — {o.location_name || 'no site'} ({o.active_jobs} active)</option>
                                                        ))}
                                                    </select>
                                                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => assign(job)}>Assign</button>
                                                    {rushBtn(job)}
                                                </div>
                                            </td>
                                        </tr>
                                        {docsRow(job.id, 6)}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {operators.length === 0 && (
                            <p className="text-muted" style={{ marginTop: '0.75rem' }}>
                                No printer operators configured. An admin can mark users as operators in User Management.
                            </p>
                        )}
                    </div>
                )}

                {/* Ready for collection */}
                {tab === 'ready' && (
                    <div className="glass-card">
                        <div className="table-container">
                            <table className="table">
                                <thead>
                                    <tr><th>Job No</th><th>Requestor</th><th>Operator</th><th>Docs</th><th>Ready At</th><th style={{ textAlign: 'center' }}>Action</th></tr>
                                </thead>
                                <tbody>
                                    {filterList(ready).length === 0 ? (
                                        <tr><td colSpan="6" className="text-center" style={{ color: '#999', padding: '2rem' }}>Nothing awaiting collection.</td></tr>
                                    ) : filterList(ready).map((job) => (
                                        <React.Fragment key={job.id}>
                                        <tr>
                                            {jobCell(job)}
                                            <td>{job.requestor_name}</td>
                                            <td>{job.operator_name || '-'}</td>
                                            {docsCell(job)}
                                            <td className="text-muted">{formatDate(job.ready_at)}</td>
                                            <td style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => collect(job)}>Confirm Handover</button>
                                                    <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => openDispatch(job)}>Dispatch</button>
                                                </div>
                                            </td>
                                        </tr>
                                        {docsRow(job.id, 6)}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* In Transit (dispatched) */}
                {tab === 'dispatched' && (
                    <div className="glass-card">
                        <div className="table-container">
                            <table className="table">
                                <thead>
                                    <tr><th>Job No</th><th>Requestor</th><th>Courier</th><th>Docket</th><th>Books/Packets</th><th>Dispatched</th><th style={{ textAlign: 'center' }}>Action</th></tr>
                                </thead>
                                <tbody>
                                    {filterList(dispatched).length === 0 ? (
                                        <tr><td colSpan="7" className="text-center" style={{ color: '#999', padding: '2rem' }}>Nothing in transit.</td></tr>
                                    ) : filterList(dispatched).map((job) => (
                                        <React.Fragment key={job.id}>
                                        <tr>
                                            {jobCell(job)}
                                            <td>{job.requestor_name}</td>
                                            <td>{job.courier_name || '-'}</td>
                                            <td>{job.docket_no || '-'}</td>
                                            <td>{[job.dispatch_books && `${job.dispatch_books} book(s)`, job.dispatch_packets && `${job.dispatch_packets} pkt`].filter(Boolean).join(', ') || '-'}</td>
                                            <td className="text-muted">{formatDate(job.dispatched_at)}</td>
                                            <td style={{ textAlign: 'center' }}>
                                                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => markDelivered(job)}>Mark Delivered</button>
                                            </td>
                                        </tr>
                                        {docsRow(job.id, 7)}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Dispatch modal */}
                {dispatchJob && (
                    <div className="app-modal-backdrop" onClick={() => setDispatchJob(null)}>
                        <div className="app-modal app-modal-sm" style={{ maxWidth: '460px' }} onClick={(e) => e.stopPropagation()}>
                            <h2 className="app-modal-title">Dispatch {dispatchJob.job_number}</h2>
                            <div className="input-group">
                                <label className="input-label">Courier / Carrier <span style={{ color: '#DC2626' }}>*</span></label>
                                <input className="input-field" value={dispatchForm.courier_name} onChange={(e) => setDispatchForm({ ...dispatchForm, courier_name: e.target.value })} placeholder="e.g. Blue Dart, DTDC, By hand" />
                            </div>
                            <div className="input-group">
                                <label className="input-label">Docket / AWB No.</label>
                                <input className="input-field" value={dispatchForm.docket_no} onChange={(e) => setDispatchForm({ ...dispatchForm, docket_no: e.target.value })} />
                            </div>
                            <div style={{ display: 'flex', gap: '0.75rem' }}>
                                <div className="input-group" style={{ flex: 1 }}>
                                    <label className="input-label">No. of Books</label>
                                    <input className="input-field" type="number" min="0" value={dispatchForm.books} onChange={(e) => setDispatchForm({ ...dispatchForm, books: e.target.value })} />
                                </div>
                                <div className="input-group" style={{ flex: 1 }}>
                                    <label className="input-label">No. of Packets/Boxes</label>
                                    <input className="input-field" value={dispatchForm.packets} onChange={(e) => setDispatchForm({ ...dispatchForm, packets: e.target.value })} />
                                </div>
                            </div>
                            <div className="input-group">
                                <label className="input-label">Remarks</label>
                                <textarea className="input-field" rows="2" value={dispatchForm.remarks} onChange={(e) => setDispatchForm({ ...dispatchForm, remarks: e.target.value })} style={{ resize: 'vertical' }} />
                            </div>
                            {dispatchJob.recipient_name && (
                                <p className="text-muted" style={{ fontSize: '0.8rem' }}>
                                    To: <strong>{dispatchJob.recipient_name}</strong>{dispatchJob.recipient_contact ? ` · ${dispatchJob.recipient_contact}` : ''}{dispatchJob.recipient_address ? ` · ${dispatchJob.recipient_address}` : ''}
                                </p>
                            )}
                            <div className="app-modal-actions">
                                <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy} onClick={submitDispatch}>Dispatch</button>
                                <button className="btn" onClick={() => setDispatchJob(null)}>Cancel</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PrintCoordinatorPage;
