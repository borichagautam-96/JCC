import React, { useEffect, useMemo, useState } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';

const ReminderHistoryPage = () => {
    const { getToken } = useAuth();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [moduleFilter, setModuleFilter] = useState('all');
    const [typeFilter, setTypeFilter] = useState('all');
    const [search, setSearch] = useState('');

    const authHeaders = () => ({
        Authorization: `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
    });

    const fetchHistory = async () => {
        setLoading(true);
        setError('');
        try {
            const response = await fetch(`/api/users/reminder-history?limit=500&module=${encodeURIComponent(moduleFilter)}`, {
                headers: authHeaders(),
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to load reminder history');
            }
            setRows(Array.isArray(data) ? data : []);
        } catch (err) {
            setError(err.message || 'Failed to load reminder history');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchHistory();
    }, [moduleFilter]);

    const reminderTypeOptions = useMemo(() => {
        const map = new Map();
        rows.forEach((row) => {
            const code = String(row.reminder_code || '').trim();
            const label = String(row.reminder_label || code).trim();
            if (code) map.set(code, label || code);
        });
        return [...map.entries()].map(([value, label]) => ({ value, label }));
    }, [rows]);

    const filteredRows = useMemo(() => {
        const query = search.trim().toLowerCase();
        return rows.filter((row) => {
            const matchesType = typeFilter === 'all' || row.reminder_code === typeFilter;
            if (!matchesType) return false;
            if (!query) return true;
            return [
                row.reference_no,
                row.subject_name,
                row.party_name,
                row.pending_with,
                row.requester_name,
                row.requester_role,
                row.recipients,
                row.module,
            ]
                .map((value) => String(value || '').toLowerCase())
                .some((value) => value.includes(query));
        });
    }, [rows, search, typeFilter]);

    const formatDateTime = (value) => {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
    };

    const renderTableRows = () => {
        if (loading) {
            return [(
                <tr key="loading-row">
                    <td colSpan="11" style={{ textAlign: 'center', padding: '2rem' }}>Loading reminder history...</td>
                </tr>
            )];
        }

        if (!filteredRows.length) {
            return [(
                <tr key="empty-row">
                    <td colSpan="11" style={{ textAlign: 'center', padding: '2rem', color: '#64748B' }}>
                        No reminder records found for the selected filters.
                    </td>
                </tr>
            )];
        }

        return filteredRows.map((row) => {
            const isJcc = row.module === 'jcc';
            const isOverdue = row.reminder_code === 'overdue';
            const moduleBadgeStyle = {
                padding: '4px 10px',
                borderRadius: '999px',
                fontSize: '0.78rem',
                fontWeight: 600,
                background: isJcc ? '#DBEAFE' : '#E2E8F0',
                color: isJcc ? '#1E40AF' : '#334155',
            };

            const reminderBadgeStyle = {
                padding: '4px 10px',
                borderRadius: '999px',
                fontSize: '0.78rem',
                fontWeight: 600,
                background: '#FEF3C7',
                color: '#92400E',
            };

            if (isOverdue) {
                reminderBadgeStyle.background = '#FEE2E2';
                reminderBadgeStyle.color = '#991B1B';
            } else if (isJcc) {
                reminderBadgeStyle.background = '#EDE9FE';
                reminderBadgeStyle.color = '#5B21B6';
            }

            return (
                <tr key={row.row_id || `${row.module}-${row.id}`}>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td>
                        <span style={moduleBadgeStyle}>
                            {String(row.module || 'asset').toUpperCase()}
                        </span>
                    </td>
                    <td>
                        <span style={reminderBadgeStyle}>
                            {row.reminder_label || row.reminder_code || 'Reminder'}
                        </span>
                    </td>
                    <td>{row.reference_no || '-'}</td>
                    <td>{row.subject_name || '-'}</td>
                    <td>{row.party_name || '-'}</td>
                    <td>{row.pending_with || '-'}</td>
                    <td>{row.pending_since_or_due || '-'}</td>
                    <td>
                        {row.requester_name || '-'}
                        {row.requester_role ? (
                            <span style={{ color: '#64748B' }}> ({row.requester_role})</span>
                        ) : null}
                    </td>
                    <td>{row.status_text || '-'}</td>
                    <td>{row.recipients || '-'}</td>
                </tr>
            );
        });
    };

    return (
        <div className="container page-shell fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.35rem', color: '#0F172A' }}>Reminder History</h1>
                    <p style={{ margin: '0.35rem 0 0 0', color: '#64748B', fontSize: '0.92rem' }}>
                        Track what reminders were sent for both Asset returns and pending JCC approvals.
                    </p>
                </div>
                <button className="btn btn-primary" onClick={fetchHistory} disabled={loading}>
                    {loading ? 'Refreshing...' : 'Refresh'}
                </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '220px 260px 1fr', gap: '0.8rem', marginBottom: '1rem' }}>
                <div>
                    <label className="input-label" htmlFor="reminder-module-filter">Module</label>
                    <select id="reminder-module-filter" className="input-field" value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)}>
                        <option value="all">All</option>
                        <option value="asset">Asset</option>
                        <option value="jcc">JCC</option>
                    </select>
                </div>
                <div>
                    <label className="input-label" htmlFor="reminder-type-filter">Reminder Type</label>
                    <select id="reminder-type-filter" className="input-field" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                        <option value="all">All</option>
                        {reminderTypeOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="input-label" htmlFor="reminder-history-search">Search</label>
                    <input
                        id="reminder-history-search"
                        className="input-field"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by JCC/Asset, vendor, pending with, requester, recipients"
                    />
                </div>
            </div>

            {error && (
                <div style={{
                    marginBottom: '1rem',
                    border: '1px solid #FECACA',
                    background: '#FEF2F2',
                    color: '#991B1B',
                    borderRadius: '8px',
                    padding: '0.8rem'
                }}>
                    {error}
                </div>
            )}

            <div style={{
                background: 'white',
                border: '1px solid #E2E8F0',
                borderRadius: '10px',
                overflow: 'auto'
            }}>
                <table className="table" style={{ minWidth: '1280px' }}>
                    <thead>
                        <tr>
                            <th>Sent At</th>
                            <th>Module</th>
                            <th>Reminder</th>
                            <th>Reference</th>
                            <th>Subject</th>
                            <th>Vendor/Supplier</th>
                            <th>Pending With</th>
                            <th>Due/Pending Since</th>
                            <th>Requester</th>
                            <th>Status</th>
                            <th>Recipients</th>
                        </tr>
                    </thead>
                    <tbody>{renderTableRows()}</tbody>
                </table>
            </div>
        </div>
    );
};

export default ReminderHistoryPage;
