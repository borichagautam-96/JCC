import React, { useState, useEffect, useCallback } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { formatDateTime, msSince } from '../utils/datetime';
import SubmissionDiff from '../components/SubmissionDiff';

const TABS = [
    { key: 'pending', label: 'Pending Verification' },
    { key: 'queue', label: 'Print Queue' },
    { key: 'proof', label: 'Proof & Rework' },
    { key: 'ready', label: 'Ready for Collection' },
    { key: 'awaiting', label: 'Awaiting Receipt' },
    { key: 'dispatched', label: 'In Transit' },
];

const formatDate = (v) => formatDateTime(v);

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
    HANDOVER_PRINT_JOB: { label: 'Handed over — awaiting confirmation', color: '#D97706' },
    CONFIRM_PRINT_RECEIPT: { label: 'Receipt confirmed by requestor', color: '#15803D' },
    COMPLETE_PRINT_JOB: { label: 'Collected & closed', color: '#15803D' },
    CLONE_PRINT_REQUEST: { label: 'Cloned from another request', color: 'var(--text-muted)' },
    RECALL_PRINT_JOB: { label: 'Recalled for correction', color: '#D97706' },
    RELEASE_PROOF: { label: 'Proof copy released', color: '#2563EB' },
    PROOF_APPROVED: { label: 'Proof approved', color: '#15803D' },
    REWORK_REQUESTED: { label: 'Corrections reported', color: '#EA580C' },
    REQUEST_REWORK: { label: 'Rework requested by requestor', color: '#D97706' },
    CREATE_REWORK: { label: 'Rework created', color: '#D97706' },
    ASSIGN_REWORK: { label: 'Rework assigned to operator', color: '#4F46E5' },
    START_REWORK: { label: 'Rework printing started', color: '#7C3AED' },
    COMPLETE_REWORK: { label: 'Rework completed', color: '#15803D' },
    CANCEL_REWORK: { label: 'Rework cancelled', color: '#DC2626' },
    REPLACE_DOCUMENT_PDF: { label: 'Document PDF replaced', color: '#D97706' },
};
const actionMeta = (a) => ACTION_META[a] || { label: a, color: 'var(--text-muted)' };

const PrintCoordinatorPage = () => {
    const { getToken } = useAuth();
    const dialog = useDialog();
    const [tab, setTab] = useState('pending');
    const [pending, setPending] = useState([]);
    const [queue, setQueue] = useState([]);
    const [ready, setReady] = useState([]);
    const [awaiting, setAwaiting] = useState([]);
    const [proof, setProof] = useState([]);
    const [versions, setVersions] = useState({});      // jobId -> version rows
    const [changeLog, setChangeLog] = useState({});   // jobId -> submissions[]
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
            const [p, q, r, w, d, o, pr] = await Promise.all([
                fetch('/api/jobs/pending', { headers: authHeaders() }),
                fetch('/api/jobs/queue', { headers: authHeaders() }),
                fetch('/api/jobs/ready', { headers: authHeaders() }),
                fetch('/api/jobs/awaiting-receipt', { headers: authHeaders() }),
                fetch('/api/jobs/dispatched', { headers: authHeaders() }),
                fetch('/api/jobs/operators', { headers: authHeaders() }),
                fetch('/api/jobs/proof-review', { headers: authHeaders() }),
            ]);
            if (pr.ok) setProof(await pr.json());
            if (p.ok) setPending(await p.json());
            if (q.ok) setQueue(await q.json());
            if (r.ok) setReady(await r.json());
            if (w.ok) setAwaiting(await w.json());
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

    // Assigning the open rework is a different endpoint from assigning the job itself,
    // and its dropdown is keyed `rw-<jobId>` so the two selects on the same row cannot
    // collide. Note the payload key is operator_id here, not operatorId.
    const assignRework = async (job) => {
        const operatorId = assignChoice[`rw-${job.id}`];
        if (!operatorId) { await dialog.alert('Pick an operator first.', { title: 'No operator', variant: 'warning' }); return; }
        // open_rework_row_id is the rework's numeric primary key; open_rework_id is the
        // human reference ("RWK0013"), which this route does not accept.
        act(`/api/jobs/${job.id}/reworks/${job.open_rework_row_id}/assign`,
            { method: 'POST', body: JSON.stringify({ operator_id: Number(operatorId) }) });
    };

    const collect = async (job) => {
        const ok = await dialog.confirm(
            `Confirm you handed ${job.job_number} to ${job.requestor_name}? It moves to Awaiting Receipt until they confirm they got it.`,
            { title: 'Confirm handover' }
        );
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
            {job.submission_seq > 1 && (
                <div style={{ fontSize: '0.7rem', color: 'var(--stat-amber)', fontWeight: 600 }}>
                    ↻ Resubmitted (v{job.submission_seq})
                </div>
            )}
            {job.location_name && (
                <div style={{ fontSize: '0.72rem', color: '#0369A1', fontWeight: 600 }}>📍 {job.location_name}</div>
            )}
        </td>
    );

    // ── Proof review + rework ────────────────────────────────────────────────
    const EMPTY_REWORK = {
        file: null, modified_pages: '', additional_pages: '0',
        insert_mode: 'end', insert_page: '', change_description: '',
        coordinator_remarks: '', operator_id: '',
    };

    // Loads the submission history so the latest diff can be shown against the row.
    // Clicking again collapses it, so the list stays scannable.
    const toggleChanges = async (jobId) => {
        if (changeLog[jobId]) {
            setChangeLog((prev) => { const next = { ...prev }; delete next[jobId]; return next; });
            return;
        }
        try {
            const res = await fetch(`/api/jobs/${jobId}/submissions`, { headers: authHeaders() });
            if (!res.ok) return;
            const data = await res.json();
            setChangeLog((prev) => ({ ...prev, [jobId]: data.submissions || [] }));
        } catch (e) {
            console.warn('change log load failed', e);
        }
    };

    const loadVersions = async (jobId) => {
        try {
            const res = await fetch(`/api/jobs/${jobId}/versions`, { headers: authHeaders() });
            if (!res.ok) return;
            const rows = await res.json();
            setVersions((prev) => ({ ...prev, [jobId]: rows }));
        } catch (e) { console.warn('version load failed', e); }
    };

    const releaseProof = async (job) => {
        const ok = await dialog.confirm(
            `Give ${job.job_number} to ${job.requestor_name} as a proof copy? It moves to Proof & Rework until they report back.`,
            { title: 'Send for proof review', confirmLabel: 'Send for review' }
        );
        if (!ok) return;
        act(`/api/jobs/${job.id}/release-proof`, { method: 'POST', body: '{}' });
    };

    const proofVerdict = async (job, approved) => {
        if (approved) {
            const ok = await dialog.confirm(
                `Mark ${job.job_number} approved? It moves to Ready for Collection.`,
                { title: 'Proof approved' }
            );
            if (!ok) return;
        }
        act(`/api/jobs/${job.id}/proof-verdict`, { method: 'POST', body: JSON.stringify({ approved }) });
    };

    const cancelRework = async (job) => {
        const reason = await dialog.prompt(`Cancel ${job.open_rework_id}? Give a reason for the record:`,
            { title: 'Cancel rework', placeholder: 'e.g. wrong PDF attached', multiline: true });
        if (reason == null) return;
        if (!reason.trim()) { await dialog.alert('A reason is required.', { title: 'Missing reason', variant: 'warning' }); return; }
        act(`/api/jobs/${job.id}/reworks/${job.open_rework_row_id}/cancel`,
            { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
    };

    const openVersionPdf = async (jobId, v) => {
        const url = v.rework_row_id
            ? `/api/jobs/${jobId}/reworks/${v.rework_row_id}/file`
            : `/api/jobs/${jobId}/documents/${v.document_id}/file`;
        try {
            const res = await fetch(url, { headers: authHeaders() });
            if (!res.ok) return;
            const blob = await res.blob();
            const objectUrl = window.URL.createObjectURL(blob);
            window.open(objectUrl, '_blank', 'noopener');
            setTimeout(() => window.URL.revokeObjectURL(objectUrl), 60000);
        } catch (e) { console.warn('open version failed', e); }
    };

    // Search across the active tab; rush toggle; SLA aging colour on timestamps.
    const q = search.trim().toLowerCase();
    const filterList = (list) => (!q ? list : list.filter((j) => [(j.job_number || ''), (j.request_id || ''), (j.requestor_name || '')].some((v) => v.toLowerCase().includes(q))));
    const toggleRush = (job) => act(`/api/jobs/${job.id}/priority`, { method: 'POST', body: JSON.stringify({ rush: Number(job.priority) === 1 ? 0 : 1 }) });
    // How long a handover has sat unconfirmed — the coordinator's cue to chase.
    const waitingLabel = (dateStr) => {
        const elapsed = msSince(dateStr);
        if (elapsed === null) return '-';
        const hrs = Math.floor(elapsed / 3.6e6);
        if (hrs < 1) return 'just now';
        if (hrs < 24) return `${hrs}h`;
        const days = Math.floor(hrs / 24);
        return `${days} day${days === 1 ? '' : 's'}`;
    };

    const agingCell = (dateStr) => {
        const elapsed = msSince(dateStr);
        if (elapsed === null) return { color: 'var(--text-muted)' };
        const hrs = elapsed / 3.6e6;
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
                        const counts = { pending: pending.length, queue: queue.length, proof: proof.length, ready: ready.length, awaiting: awaiting.length, dispatched: dispatched.length };
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
                                                    {job.submission_seq > 1 && (
                                                        <button className="btn btn-sm btn-outline"
                                                                style={{ color: 'var(--stat-amber)', borderColor: 'var(--stat-amber)' }}
                                                                onClick={() => toggleChanges(job.id)}
                                                                title="This was resubmitted after an edit \u2014 see what changed">
                                                            {changeLog[job.id] ? 'Hide changes' : 'What changed?'}
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                        {changeLog[job.id] && (
                                            <tr>
                                                <td colSpan="7" style={{ background: 'var(--surface-2)' }}>
                                                    <div style={{ padding: '0.6rem 0.2rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                                                        {[...changeLog[job.id]].reverse().map((sub) => (
                                                            <SubmissionDiff key={sub.seq} submission={sub} />
                                                        ))}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
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
                                                    <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => releaseProof(job)}
                                                            title="Give the requestor a proof copy to check before final handover">Send for proof review</button>
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

                {/* Proof review + rework — the correction loop */}
                {tab === 'proof' && (
                    <div className="glass-card">
                        <p className="text-muted" style={{ margin: '0 0 0.85rem', fontSize: '0.85rem' }}>
                            Jobs whose proof copy is with the requestor. Record their verdict here; when they
                            send a revised PDF it appears below for you to assign to an operator.
                        </p>
                        <div className="table-container">
                            <table className="table">
                                <thead>
                                    <tr><th>Job No</th><th>Requestor</th><th>Ver</th><th>State</th><th>Proof Released</th><th style={{ textAlign: 'center' }}>Action</th></tr>
                                </thead>
                                <tbody>
                                    {filterList(proof).length === 0 ? (
                                        <tr><td colSpan="6" className="text-center" style={{ color: 'var(--text-muted)', padding: '2rem' }}>Nothing under proof review.</td></tr>
                                    ) : filterList(proof).map((job) => (
                                        <React.Fragment key={job.id}>
                                        <tr>
                                            {jobCell(job)}
                                            <td>{job.requestor_name}</td>
                                            <td><span className="status-pill" style={{ background: 'var(--surface-3)', color: 'var(--text-strong)' }}>V{job.current_version || 1}</span></td>
                                            <td>
                                                {job.status === 'proof_review' && <span className="status-pill status-pill-pending">Awaiting verdict</span>}
                                                {job.status === 'rework_requested' && (job.open_rework_id
                                                    ? <span className="status-pill status-pill-pending">
                                                          {job.open_rework_id} {job.open_rework_operator_id ? 'queued' : '\u2014 needs operator'}
                                                      </span>
                                                    : <span className="status-pill status-pill-pending">Awaiting revised PDF</span>)}
                                                {job.status === 'rework_printing' && <span className="status-pill status-pill-pending">Reprinting</span>}
                                            </td>
                                            <td className="text-muted">{formatDate(job.proof_released_at)}</td>
                                            <td style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                    {job.status === 'proof_review' && (
                                                        <>
                                                            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => proofVerdict(job, true)}>Proof approved</button>
                                                            <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => proofVerdict(job, false)}>Corrections required</button>
                                                        </>
                                                    )}
                                                    {/* The picker is only for a rework that still needs an operator.
                                                        Once assigned it is replaced by who it went to — an editable
                                                        control left sitting there reads as work still to be done. */}
                                                    {job.open_rework_id && job.open_rework_status === 'pending' && !job.open_rework_operator_id && (
                                                        <>
                                                            <select
                                                                className="input-field"
                                                                style={{ height: '30px', fontSize: '0.78rem', minWidth: '150px', padding: '0 0.4rem' }}
                                                                value={assignChoice[`rw-${job.id}`] || ''}
                                                                onChange={(e) => setAssignChoice({ ...assignChoice, [`rw-${job.id}`]: e.target.value })}
                                                            >
                                                                <option value="">Assign operator…</option>
                                                                {operators.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                                                            </select>
                                                            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => assignRework(job)}>Assign</button>
                                                        </>
                                                    )}
                                                    {job.open_rework_id && job.open_rework_operator_id && (
                                                        <span className="text-muted" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                                                            Assigned to <strong style={{ color: 'var(--text-strong)' }}>
                                                                {job.open_rework_operator_name || 'operator'}
                                                            </strong>
                                                        </span>
                                                    )}
                                                    {job.open_rework_id && job.open_rework_status === 'pending' && (
                                                        <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => cancelRework(job)}>Cancel rework</button>
                                                    )}
                                                    <button className="btn btn-sm btn-outline" onClick={() => loadVersions(job.id)}>Versions</button>
                                                </div>
                                            </td>
                                        </tr>
                                        {versions[job.id] && (
                                            <tr>
                                                <td colSpan="6" style={{ background: 'var(--surface-2)' }}>
                                                    <div style={{ padding: '0.6rem 0.2rem' }}>
                                                        <strong style={{ fontSize: '0.82rem', color: 'var(--text-strong)' }}>Version history</strong>
                                                        <table className="table" style={{ marginTop: '0.5rem' }}>
                                                            <thead>
                                                                <tr><th>Ver</th><th>Uploaded By</th><th>Date</th><th>Modified Pages</th><th>Addl</th><th>PDF</th></tr>
                                                            </thead>
                                                            <tbody>
                                                                {versions[job.id].map((v) => (
                                                                    <tr key={v.version_no}>
                                                                        <td style={{ fontWeight: 700 }}>V{v.version_no}</td>
                                                                        <td>{v.uploaded_by} <span className="text-muted" style={{ fontSize: '0.75rem' }}>({v.uploaded_by_role})</span></td>
                                                                        <td className="text-muted">{formatDate(v.uploaded_at)}</td>
                                                                        <td>{v.modified_pages || '—'}</td>
                                                                        <td>{v.additional_pages ? `+${v.additional_pages}` : '0'}</td>
                                                                        <td><button className="btn btn-sm btn-outline" onClick={() => openVersionPdf(job.id, v)}>Open</button></td>
                                                                    </tr>
                                                                ))}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Handed over, waiting on the requestor to confirm they got the materials */}
                {tab === 'awaiting' && (
                    <div className="glass-card">
                        <p className="text-muted" style={{ margin: '0 0 0.85rem', fontSize: '0.85rem' }}>
                            Handed over but not yet confirmed by the requestor. These stay open until they confirm —
                            chase anything sitting here more than a day.
                        </p>
                        <div className="table-container">
                            <table className="table">
                                <thead>
                                    <tr><th>Job No</th><th>Requestor</th><th>Handed Over By</th><th>Docs</th><th>Waiting Since</th><th style={{ textAlign: 'center' }}>Waiting</th></tr>
                                </thead>
                                <tbody>
                                    {filterList(awaiting).length === 0 ? (
                                        <tr><td colSpan="6" className="text-center" style={{ color: 'var(--text-muted)', padding: '2rem' }}>Nothing awaiting confirmation.</td></tr>
                                    ) : filterList(awaiting).map((job) => (
                                        <React.Fragment key={job.id}>
                                        <tr>
                                            {jobCell(job)}
                                            <td>{job.requestor_name}</td>
                                            <td>{job.handed_over_by || '-'}</td>
                                            {docsCell(job)}
                                            <td className="text-muted">{formatDate(job.handed_over_at)}</td>
                                            <td style={{ textAlign: 'center' }} className="text-muted">{waitingLabel(job.handed_over_at)}</td>
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
