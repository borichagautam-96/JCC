import React, { useState, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

// Status → badge. Covers the full Phase 3–10 lifecycle; Slice A only produces
// draft / submitted, but the map is complete so later slices need no change here.
const STATUS_BADGE = {
    draft: { cls: 'bg-slate-100 text-slate-700', label: 'Draft' },
    submitted: { cls: 'bg-blue-100 text-blue-800', label: 'Pending Verification' },
    returned: { cls: 'bg-orange-100 text-orange-800', label: '↩ Returned' },
    rejected: { cls: 'bg-red-100 text-red-800', label: 'Rejected' },
    accepted: { cls: 'bg-teal-100 text-teal-800', label: 'Accepted (Queued)' },
    assigned: { cls: 'bg-indigo-100 text-indigo-800', label: 'Assigned' },
    printing: { cls: 'bg-purple-100 text-purple-800', label: 'Printing' },
    paused: { cls: 'bg-amber-100 text-amber-800', label: 'Paused' },
    printing_completed: { cls: 'bg-teal-100 text-teal-800', label: 'Printed' },
    ready_for_collection: { cls: 'bg-green-100 text-green-800', label: 'Ready for Collection' },
    dispatched: { cls: 'bg-purple-100 text-purple-800', label: 'In Transit' },
    completed: { cls: 'bg-green-100 text-green-800', label: 'Completed' },
    cancelled: { cls: 'bg-slate-100 text-slate-500', label: 'Cancelled' },
};

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
const actionMeta = (action) => ACTION_META[action] || { label: action, color: 'var(--text-muted)' };

const JobHistoryPage = () => {
    const { getToken } = useAuth();
    const navigate = useNavigate();
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(null);
    const [details, setDetails] = useState({});
    const [logs, setLogs] = useState({}); // jobId -> { events, totals }
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');

    const cloneJob = async (job) => {
        try {
            const res = await fetch(`/api/jobs/${job.id}/clone`, { method: 'POST', headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Clone failed');
            navigate('/job-creation', { state: { jobId: data.id } });
        } catch (e) {
            console.error('clone failed', e);
        }
    };

    const authHeaders = () => ({
        Authorization: `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
    });

    const fetchJobs = async () => {
        try {
            const res = await fetch('/api/jobs/mine', { headers: authHeaders() });
            if (res.ok) setJobs(await res.json());
            else setJobs([]);
        } catch (e) {
            console.error('fetch jobs failed', e);
            setJobs([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchJobs();
        const interval = setInterval(fetchJobs, 30000);
        return () => clearInterval(interval);
    }, []);

    // File endpoint requires the Bearer header, so fetch as a blob and open it
    // (a plain <a href> can't attach the Authorization header).
    const openDocument = async (jobId, docId) => {
        try {
            const res = await fetch(`/api/jobs/${jobId}/documents/${docId}/file`, { headers: authHeaders() });
            if (!res.ok) return;
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            window.open(url, '_blank', 'noopener');
            setTimeout(() => window.URL.revokeObjectURL(url), 60000);
        } catch (e) {
            console.warn('open document failed', e);
        }
    };

    const toggleDetails = async (job) => {
        if (expanded === job.id) {
            setExpanded(null);
            return;
        }
        setExpanded(job.id);
        if (!details[job.id]) {
            try {
                const res = await fetch(`/api/jobs/${job.id}`, { headers: authHeaders() });
                if (res.ok) {
                    const data = await res.json();
                    setDetails((prev) => ({ ...prev, [job.id]: data.documents || [] }));
                }
            } catch (e) {
                console.warn('detail load failed', e);
            }
        }
        // Always refresh the activity log (it changes as the job progresses).
        try {
            const res = await fetch(`/api/jobs/${job.id}/log`, { headers: authHeaders() });
            if (res.ok) {
                const logData = await res.json();
                setLogs((prev) => ({ ...prev, [job.id]: logData }));
            }
        } catch (e) {
            console.warn('log load failed', e);
        }
    };

    const badge = (status) => STATUS_BADGE[status] || { cls: 'bg-slate-100 text-slate-700', label: status };

    const q = search.trim().toLowerCase();
    const filtered = jobs.filter((j) => {
        if (statusFilter !== 'all' && j.status !== statusFilter) return false;
        if (!q) return true;
        return [(j.job_number || ''), (j.request_id || ''), (j.project_name || '')].some((v) => v.toLowerCase().includes(q));
    });
    const statusOptions = [...new Set(jobs.map((j) => j.status))];

    if (loading) {
        return (
            <div className="flex items-center justify-center" style={{ minHeight: '80vh' }}>
                <div className="spinner"></div>
            </div>
        );
    }

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h1 className="page-title">My Printing Jobs</h1>
                        <p className="page-subtitle">Track your printing requests and their status</p>
                    </div>
                    <button className="btn btn-primary" onClick={() => navigate('/job-creation')}>+ New Printing Job</button>
                </div>

                {/* Search + filter */}
                <div className="glass-card" style={{ marginBottom: '1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input className="input-field premium-search-field" style={{ flex: '1 1 240px' }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search job no or project…" />
                    <select className="input-field" style={{ width: 'auto' }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                        <option value="all">All statuses</option>
                        {statusOptions.map((s) => <option key={s} value={s}>{badge(s).label}</option>)}
                    </select>
                    <span className="text-muted" style={{ fontSize: '0.82rem' }}>{filtered.length} of {jobs.length}</span>
                </div>

                <div className="glass-card">
                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Request / Job No</th>
                                    <th>Project</th>
                                    <th>Docs</th>
                                    <th>Status</th>
                                    <th>Queue</th>
                                    <th>Submitted</th>
                                    <th style={{ textAlign: 'center' }}>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan="7" className="text-center" style={{ color: '#999', padding: '2rem' }}>
                                            {jobs.length === 0 ? 'No printing jobs yet. Click “New Printing Job” to create one.' : 'No jobs match your search.'}
                                        </td>
                                    </tr>
                                ) : (
                                    filtered.map((job) => {
                                        const b = badge(job.status);
                                        const isDraftLike = job.status === 'draft' || job.status === 'returned';
                                        return (
                                            <React.Fragment key={job.id}>
                                                <tr>
                                                    <td style={{ fontWeight: 600 }}>
                                                        {job.job_number || job.request_id}
                                                        {Number(job.priority) === 1 && (
                                                            <span style={{ marginLeft: '0.4rem', fontSize: '0.68rem', fontWeight: 700, color: '#B91C1C', background: '#FEE2E2', borderRadius: '6px', padding: '1px 5px' }}>🔥 RUSH</span>
                                                        )}
                                                        {job.job_number && (
                                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)', fontWeight: 400 }}>{job.request_id}</div>
                                                        )}
                                                    </td>
                                                    <td>{job.project_name || '-'}</td>
                                                    <td>{job.document_count}</td>
                                                    <td>
                                                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${b.cls}`}>{b.label}</span>
                                                    </td>
                                                    <td>{job.queue_position ? `#${job.queue_position}` : '-'}</td>
                                                    <td className="text-muted">{formatDate(job.submitted_at)}</td>
                                                    <td style={{ textAlign: 'center' }}>
                                                        <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                            <button className="btn btn-sm btn-outline" onClick={() => toggleDetails(job)}>
                                                                {expanded === job.id ? 'Hide' : 'View'}
                                                            </button>
                                                            {isDraftLike && (
                                                                <button
                                                                    className="btn btn-sm btn-primary"
                                                                    onClick={() => navigate('/job-creation', { state: { jobId: job.id } })}
                                                                >
                                                                    {job.status === 'returned' ? 'Edit & Resubmit' : 'Continue'}
                                                                </button>
                                                            )}
                                                            <button className="btn btn-sm btn-outline" onClick={() => cloneJob(job)} title="Create a new request copying this one's details">Clone</button>
                                                        </div>
                                                    </td>
                                                </tr>
                                                {expanded === job.id && (
                                                    <tr>
                                                        <td colSpan="7" style={{ background: 'var(--surface-2)' }}>
                                                            {job.return_reason && (
                                                                <div style={{ marginBottom: '0.75rem', color: '#9A3412', background: '#FFF7ED', border: '1px solid #FDBA74', borderRadius: '8px', padding: '0.6rem 0.85rem' }}>
                                                                    <strong>Returned for correction:</strong> {job.return_reason}
                                                                </div>
                                                            )}
                                                            {job.reject_reason && (
                                                                <div style={{ marginBottom: '0.75rem', color: '#7F1D1D', background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: '8px', padding: '0.6rem 0.85rem' }}>
                                                                    <strong>Rejected:</strong> {job.reject_reason}
                                                                </div>
                                                            )}
                                                            {!details[job.id] ? (
                                                                <div className="text-muted" style={{ padding: '0.5rem' }}>Loading documents…</div>
                                                            ) : details[job.id].length === 0 ? (
                                                                <div className="text-muted" style={{ padding: '0.5rem' }}>No documents.</div>
                                                            ) : (
                                                                <table className="table" style={{ margin: 0 }}>
                                                                    <thead>
                                                                        <tr>
                                                                            <th>Document</th><th>Qty</th><th>Pages</th><th>Side</th>
                                                                            <th>Size / GSM</th><th>Colour</th><th>Binding</th><th>PDF</th>
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
                                                                                <td>
                                                                                    <button className="btn btn-sm btn-outline" onClick={() => openDocument(job.id, d.id)}>
                                                                                        Open
                                                                                    </button>
                                                                                </td>
                                                                            </tr>
                                                                        ))}
                                                                    </tbody>
                                                                </table>
                                                            )}

                                                            {/* Totals + Activity Log */}
                                                            {logs[job.id] && (
                                                                <div style={{ marginTop: '1rem' }}>
                                                                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}>
                                                                        <span style={{ background: '#EEF2FF', color: '#4338CA', borderRadius: '8px', padding: '0.4rem 0.75rem', fontSize: '0.82rem', fontWeight: 600 }}>
                                                                            📄 {logs[job.id].totals.documents} document(s)
                                                                        </span>
                                                                        <span style={{ background: '#ECFDF5', color: '#047857', borderRadius: '8px', padding: '0.4rem 0.75rem', fontSize: '0.82rem', fontWeight: 600 }}>
                                                                            📚 {logs[job.id].totals.copies} book(s) / copies
                                                                        </span>
                                                                        <span style={{ background: '#FEF3C7', color: '#92400E', borderRadius: '8px', padding: '0.4rem 0.75rem', fontSize: '0.82rem', fontWeight: 600 }}>
                                                                            🖨 {logs[job.id].totals.pages} total page-prints
                                                                        </span>
                                                                    </div>

                                                                    <div style={{ fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.6rem', fontSize: '0.9rem' }}>Activity Log</div>
                                                                    {logs[job.id].events.length === 0 ? (
                                                                        <div className="text-muted" style={{ fontSize: '0.85rem' }}>No activity recorded yet.</div>
                                                                    ) : (
                                                                        <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                                                                            {logs[job.id].events.map((ev, i) => {
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
                                                )}
                                            </React.Fragment>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default JobHistoryPage;
