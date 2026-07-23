import React, { useState, useEffect, useCallback } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';

// Status → label + accent, ordered along the workflow.
const STATUS_META = [
    { key: 'submitted', label: 'Pending Verification', color: '#2563EB' },
    { key: 'returned', label: 'Returned', color: '#EA580C' },
    { key: 'rejected', label: 'Rejected', color: '#DC2626' },
    { key: 'accepted', label: 'In Queue', color: '#0D9488' },
    { key: 'assigned', label: 'Assigned', color: '#4F46E5' },
    { key: 'printing', label: 'Printing', color: '#7C3AED' },
    { key: 'paused', label: 'Paused', color: '#D97706' },
    { key: 'printing_completed', label: 'Printed', color: '#0891B2' },
    { key: 'ready_for_collection', label: 'Ready', color: '#16A34A' },
    { key: 'completed', label: 'Completed', color: '#15803D' },
    { key: 'draft', label: 'Draft', color: 'var(--text-muted)' },
    { key: 'cancelled', label: 'Cancelled', color: 'var(--text-faint)' },
];

const PrintReportsPage = () => {
    const { getToken } = useAuth();
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchStats = useCallback(async () => {
        try {
            const res = await fetch('/api/jobs/stats', {
                headers: { Authorization: `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() },
            });
            if (res.ok) setStats(await res.json());
        } catch (e) {
            console.error('stats fetch failed', e);
        } finally {
            setLoading(false);
        }
    }, [getToken]);

    useEffect(() => {
        fetchStats();
        const interval = setInterval(fetchStats, 30000);
        return () => clearInterval(interval);
    }, [fetchStats]);

    if (loading) {
        return <div className="flex items-center justify-center" style={{ minHeight: '80vh' }}><div className="spinner"></div></div>;
    }

    const byStatus = {};
    (stats?.byStatus || []).forEach((r) => { byStatus[r.status] = r.c; });
    const total = stats?.total ?? Object.values(byStatus).reduce((a, b) => a + b, 0);
    const maxStatus = Math.max(1, ...STATUS_META.map((s) => byStatus[s.key] || 0));
    const isCoordinatorView = stats?.scope === 'all';

    const activeInPipeline = ['submitted', 'accepted', 'assigned', 'printing', 'paused', 'printing_completed', 'ready_for_collection']
        .reduce((sum, k) => sum + (byStatus[k] || 0), 0);

    const summaryCards = [
        { label: 'Total Jobs', value: total, color: '#1E3A5F' },
        { label: 'In Pipeline', value: activeInPipeline, color: '#7C3AED' },
        { label: 'Pending Verification', value: byStatus.submitted || 0, color: '#2563EB' },
        { label: 'In Queue', value: byStatus.accepted || 0, color: '#0D9488' },
        { label: 'Completed', value: byStatus.completed || 0, color: '#15803D' },
    ];

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header">
                    <div>
                        <h1 className="page-title">Printing Reports</h1>
                        <p className="page-subtitle">
                            {isCoordinatorView ? 'Overview of all printing jobs, workload, and turnaround' : 'Your printing job summary'}
                        </p>
                    </div>
                </div>

                {/* Summary cards */}
                <div className="card-grid mb-xl" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: 'var(--spacing-xl)' }}>
                    {summaryCards.map((c) => (
                        <div key={c.label} className="metric-card">
                            <h3 className="metric-label">{c.label}</h3>
                            <p className="metric-value" style={{ color: c.color }}>{c.value}</p>
                        </div>
                    ))}
                </div>

                {/* Status breakdown */}
                <div className="glass-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                    <h3 style={{ marginTop: 0, color: 'var(--text-strong)' }}>Jobs by Status</h3>
                    {total === 0 ? (
                        <p className="text-muted" style={{ margin: 0 }}>No jobs yet.</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                            {STATUS_META.filter((s) => (byStatus[s.key] || 0) > 0).map((s) => {
                                const count = byStatus[s.key] || 0;
                                return (
                                    <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                        <div style={{ width: '160px', fontSize: '0.85rem', color: 'var(--text-body)', flexShrink: 0 }}>{s.label}</div>
                                        <div style={{ flex: 1, height: '22px', background: 'var(--surface-3)', borderRadius: '6px', overflow: 'hidden' }}>
                                            <div style={{ height: '100%', width: `${(count / maxStatus) * 100}%`, background: s.color, borderRadius: '6px', transition: 'width 0.3s ease' }} />
                                        </div>
                                        <div style={{ width: '44px', textAlign: 'right', fontWeight: 700, color: s.color }}>{count}</div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {isCoordinatorView && (
                    <>
                        {/* Turnaround */}
                        <div className="card-grid mb-xl" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: 'var(--spacing-xl)' }}>
                            <div className="metric-card">
                                <h3 className="metric-label">Avg. time to verify</h3>
                                <p className="metric-value" style={{ color: '#2563EB' }}>
                                    {stats?.turnaround?.avg_verify_hrs != null ? `${stats.turnaround.avg_verify_hrs} h` : '—'}
                                </p>
                            </div>
                            <div className="metric-card">
                                <h3 className="metric-label">Avg. total turnaround</h3>
                                <p className="metric-value" style={{ color: '#15803D' }}>
                                    {stats?.turnaround?.avg_total_hrs != null ? `${stats.turnaround.avg_total_hrs} h` : '—'}
                                </p>
                            </div>
                            <div className="metric-card">
                                <h3 className="metric-label">Jobs completed</h3>
                                <p className="metric-value" style={{ color: '#15803D' }}>{stats?.turnaround?.completed_count ?? 0}</p>
                            </div>
                        </div>

                        {/* Operator workload */}
                        <div className="glass-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                            <h3 style={{ marginTop: 0, color: 'var(--text-strong)' }}>Operator Workload</h3>
                            <div className="table-container">
                                <table className="table">
                                    <thead>
                                        <tr><th>Operator</th><th>Active Jobs</th><th>Completed</th></tr>
                                    </thead>
                                    <tbody>
                                        {(stats?.operators || []).length === 0 ? (
                                            <tr><td colSpan="3" className="text-center" style={{ color: '#999', padding: '1.5rem' }}>No operators configured.</td></tr>
                                        ) : stats.operators.map((o) => (
                                            <tr key={o.id}>
                                                <td style={{ fontWeight: 600 }}>{o.name}</td>
                                                <td><span style={{ fontWeight: 700, color: o.active > 0 ? '#7C3AED' : '#94A3B8' }}>{o.active}</span></td>
                                                <td>{o.completed}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* Location stats */}
                        <div className="glass-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                            <h3 style={{ marginTop: 0, color: 'var(--text-strong)' }}>Jobs by Location</h3>
                            <div className="table-container">
                                <table className="table">
                                    <thead>
                                        <tr><th>Location</th><th>Jobs</th></tr>
                                    </thead>
                                    <tbody>
                                        {(stats?.locationStats || []).length === 0 ? (
                                            <tr><td colSpan="2" className="text-center" style={{ color: '#999', padding: '1.5rem' }}>No data yet.</td></tr>
                                        ) : stats.locationStats.map((l) => (
                                            <tr key={l.location}>
                                                <td style={{ fontWeight: 600 }}>{l.location}</td>
                                                <td>{l.c}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* Department stats */}
                        <div className="glass-card">
                            <h3 style={{ marginTop: 0, color: 'var(--text-strong)' }}>Jobs by Department</h3>
                            <div className="table-container">
                                <table className="table">
                                    <thead>
                                        <tr><th>Department</th><th>Jobs</th></tr>
                                    </thead>
                                    <tbody>
                                        {(stats?.departmentStats || []).length === 0 ? (
                                            <tr><td colSpan="2" className="text-center" style={{ color: '#999', padding: '1.5rem' }}>No data yet.</td></tr>
                                        ) : stats.departmentStats.map((d) => (
                                            <tr key={d.department}>
                                                <td style={{ fontWeight: 600 }}>{d.department}</td>
                                                <td>{d.c}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default PrintReportsPage;
