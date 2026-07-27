import React, { useState, useEffect, useCallback } from 'react';
import DatePicker from '../components/DatePicker';
import { useAuth, getDeviceId } from '../contexts/AuthContext';

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
const meta = (a) => ACTION_META[a] || { label: a, color: 'var(--text-muted)' };

const PAGE_SIZE = 25; // jobs per page
const formatDate = (v) => {
    if (!v) return '-';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
};

const PrintLogsPage = () => {
    const { getToken } = useAuth();
    const [groups, setGroups] = useState([]);
    const [totalJobs, setTotalJobs] = useState(0);
    const [actions, setActions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [filters, setFilters] = useState({ search: '', action: '', fromDate: '', toDate: '' });
    const [applied, setApplied] = useState({ search: '', action: '', fromDate: '', toDate: '' });
    const [openGroups, setOpenGroups] = useState({}); // job_id -> expanded?

    const toggleGroup = (jobId) => setOpenGroups((prev) => ({ ...prev, [jobId]: !prev[jobId] }));

    const authHeaders = () => ({ Authorization: `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() });

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
            if (applied.search) params.set('search', applied.search);
            if (applied.action) params.set('action', applied.action);
            if (applied.fromDate) params.set('fromDate', applied.fromDate);
            if (applied.toDate) params.set('toDate', applied.toDate);
            const res = await fetch(`/api/jobs/logs?${params.toString()}`, { headers: authHeaders() });
            if (res.ok) {
                const data = await res.json();
                setGroups(data.groups || []);
                setTotalJobs(data.totalJobs || 0);
                setActions(data.actions || []);
            }
        } catch (e) {
            console.error('logs fetch failed', e);
        } finally {
            setLoading(false);
        }
    }, [page, applied, getToken]);

    useEffect(() => { fetchLogs(); }, [fetchLogs]);

    const applyFilters = () => { setPage(1); setApplied({ ...filters }); };
    const resetFilters = () => {
        const cleared = { search: '', action: '', fromDate: '', toDate: '' };
        setFilters(cleared); setApplied(cleared); setPage(1);
    };

    const exportCsv = () => {
        const header = ['Job No', 'Time', 'Action', 'User', 'Details'];
        const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = [header.map(escape).join(',')];
        groups.forEach((g) => {
            g.events.forEach((ev) => {
                lines.push([g.job_number || g.request_id || '-', formatDate(ev.created_at), meta(ev.action).label, ev.user_name || '-', ev.details || ''].map(escape).join(','));
            });
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'printing-activity-log.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => window.URL.revokeObjectURL(url), 5000);
    };

    const totalPages = Math.max(1, Math.ceil(totalJobs / PAGE_SIZE));

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h1 className="page-title">Printing Activity Log</h1>
                        <p className="page-subtitle">All activity, grouped by job — every step from request to collection</p>
                    </div>
                    <button className="btn btn-outline" onClick={exportCsv} disabled={groups.length === 0}>Export CSV</button>
                </div>

                {/* Filters */}
                <div className="glass-card" style={{ marginBottom: '1.25rem' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.85rem', alignItems: 'end' }}>
                        <div className="input-group">
                            <label className="input-label">Search</label>
                            <input className="input-field" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Job no, user, details…" onKeyDown={(e) => e.key === 'Enter' && applyFilters()} />
                        </div>
                        <div className="input-group">
                            <label className="input-label">Action</label>
                            <select className="input-field" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
                                <option value="">All actions</option>
                                {actions.map((a) => <option key={a} value={a}>{meta(a).label}</option>)}
                            </select>
                        </div>
                        <div className="input-group">
                            <label className="input-label">From</label>
                            <DatePicker value={filters.fromDate} onChange={(e) => setFilters({ ...filters, fromDate: e.target.value })} />
                        </div>
                        <div className="input-group">
                            <label className="input-label">To</label>
                            <DatePicker value={filters.toDate} onChange={(e) => setFilters({ ...filters, toDate: e.target.value })} />
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button className="btn btn-primary" onClick={applyFilters}>Apply</button>
                            <button className="btn btn-outline" onClick={resetFilters}>Reset</button>
                        </div>
                    </div>
                </div>

                <div className="flex justify-between items-center" style={{ marginBottom: '0.75rem' }}>
                    <span className="text-muted" style={{ fontSize: '0.85rem' }}>{totalJobs} job(s)</span>
                    <span className="text-muted" style={{ fontSize: '0.85rem' }}>Page {page} of {totalPages}</span>
                </div>

                {/* Grouped-by-job cards */}
                {loading ? (
                    <div className="glass-card text-center" style={{ padding: '2rem', color: '#999' }}>Loading…</div>
                ) : groups.length === 0 ? (
                    <div className="glass-card text-center" style={{ padding: '2rem', color: '#999' }}>No activity found.</div>
                ) : groups.map((g) => {
                    const open = !!openGroups[g.job_id];
                    const latest = g.events[g.events.length - 1];
                    return (
                        <div className="glass-card" style={{ marginBottom: '0.85rem', padding: open ? undefined : '0.9rem 1.25rem' }} key={g.job_id}>
                            {/* Clickable header (dropdown) */}
                            <div
                                onClick={() => toggleGroup(g.job_id)}
                                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', gap: '0.75rem', ...(open ? { marginBottom: '0.85rem', paddingBottom: '0.6rem', borderBottom: '1px solid #EEF2F7' } : {}) }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{open ? '▾' : '▸'}</span>
                                    <div style={{ minWidth: 0 }}>
                                        <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
                                            {g.job_number || g.request_id}
                                            {g.job_number && g.request_id && g.job_number !== g.request_id && (
                                                <span style={{ fontSize: '0.75rem', color: 'var(--text-faint)', fontWeight: 400, marginLeft: '0.5rem' }}>{g.request_id}</span>
                                            )}
                                        </h3>
                                        {!open && latest && (
                                            <div className="text-muted" style={{ fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                Latest: {meta(latest.action).label} · {formatDate(latest.created_at)}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <span className="text-muted" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{g.events.length} event(s)</span>
                            </div>

                            {open && (
                                <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                                    {g.events.map((ev) => {
                                        const m = meta(ev.action);
                                        return (
                                            <div key={ev.id} style={{ position: 'relative' }}>
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
                    );
                })}

                {/* Pagination */}
                {totalPages > 1 && (
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                        <button className="btn btn-sm btn-outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
                        <span style={{ alignSelf: 'center', fontSize: '0.85rem', color: 'var(--text-muted)' }}>{page} / {totalPages}</span>
                        <button className="btn btn-sm btn-outline" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next →</button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PrintLogsPage;
