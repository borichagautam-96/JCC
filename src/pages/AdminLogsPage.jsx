import React, { useEffect, useMemo, useRef, useState } from 'react';
import DatePicker from '../components/DatePicker';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import * as XLSX from 'xlsx';
import { parseServerDate } from '../utils/datetime';

const DEFAULT_FILTERS = {
    userName: '',
    eventName: '',
    eventType: 'all',
    module: 'all',
    success: 'all',
    fromDate: '',
    toDate: '',
    search: '',
};

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const AdminLogsPage = () => {
    const { getToken } = useAuth();
    const viewedAuditRef = useRef(false);
    const [filters, setFilters] = useState(DEFAULT_FILTERS);
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);
    const [total, setTotal] = useState(0);
    const [timezone, setTimezone] = useState('local');
    const [exporting, setExporting] = useState('');

    const authHeaders = () => ({
        Authorization: `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
    });

    const logAdminActivity = async (eventName, metadata = {}) => {
        try {
            await fetch('/api/users/activity', {
                method: 'POST',
                headers: {
                    ...authHeaders(),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    eventName,
                    module: 'admin-logs',
                    screen: '/admin-logs',
                    entityType: 'activity_logs',
                    success: true,
                    metadata,
                }),
            });
        } catch {
            // Non-blocking on purpose.
        }
    };

    const buildQueryParams = (isExport = false) => {
        const params = new URLSearchParams();
        if (!isExport) params.set('page', String(page));
        params.set('limit', String(isExport ? 10000 : pageSize));

        if (filters.userName.trim()) params.set('userName', filters.userName.trim());
        if (filters.eventName.trim()) params.set('eventName', filters.eventName.trim());
        if (filters.eventType !== 'all') params.set('eventType', filters.eventType);
        if (filters.module !== 'all') params.set('module', filters.module);
        if (filters.success !== 'all') params.set('success', filters.success);
        if (filters.fromDate) params.set('fromDate', filters.fromDate);
        if (filters.toDate) params.set('toDate', filters.toDate);
        if (filters.search.trim()) params.set('search', filters.search.trim());

        return params;
    };

    const fetchLogs = async () => {
        setLoading(true);
        setError('');
        try {
            const params = buildQueryParams(false);

            const response = await fetch(`/api/users/activity-logs?${params.toString()}`, {
                headers: authHeaders(),
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to load activity logs');
            }

            setRows(Array.isArray(data.rows) ? data.rows : []);
            setTotal(Number.isFinite(data.total) ? data.total : 0);
        } catch (err) {
            setError(err.message || 'Failed to load activity logs');
            setRows([]);
            setTotal(0);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchLogs();
    }, [page, pageSize, filters]);

    useEffect(() => {
        if (viewedAuditRef.current) return;
        viewedAuditRef.current = true;
        logAdminActivity('admin.logs.view', {
            note: 'Admin opened logs page',
        });
    }, []);

    const moduleOptions = useMemo(() => {
        const unique = new Set(rows.map((row) => String(row.module || '').trim()).filter(Boolean));
        return ['all', ...[...unique].sort((a, b) => a.localeCompare(b))];
    }, [rows]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const canGoPrev = page > 1;
    const canGoNext = page < totalPages;

    const updateFilter = (key, value) => {
        setPage(1);
        setFilters((prev) => ({ ...prev, [key]: value }));
    };

    const clearFilters = () => {
        setPage(1);
        setFilters(DEFAULT_FILTERS);
    };

    const toInputDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const applyDatePreset = (preset) => {
        const now = new Date();
        const today = toInputDate(now);

        if (preset === 'today') {
            setPage(1);
            setFilters((prev) => ({ ...prev, fromDate: today, toDate: today }));
            return;
        }

        if (preset === 'last7') {
            const from = new Date(now);
            from.setDate(from.getDate() - 6);
            setPage(1);
            setFilters((prev) => ({ ...prev, fromDate: toInputDate(from), toDate: today }));
            return;
        }

        if (preset === 'last30') {
            const from = new Date(now);
            from.setDate(from.getDate() - 29);
            setPage(1);
            setFilters((prev) => ({ ...prev, fromDate: toInputDate(from), toDate: today }));
            return;
        }

        if (preset === 'thisMonth') {
            const from = new Date(now.getFullYear(), now.getMonth(), 1);
            setPage(1);
            setFilters((prev) => ({ ...prev, fromDate: toInputDate(from), toDate: today }));
        }
    };

    const formatDateTime = (value) => {
        const date = parseServerDate(value);
        if (!date) return value ? String(value) : '-';

        if (timezone === 'utc' || timezone === 'ist') {
            return new Intl.DateTimeFormat('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'medium',
                timeZone: timezone === 'utc' ? 'UTC' : 'Asia/Kolkata',
            }).format(date);
        }

        return date.toLocaleString();
    };

    const handleExport = async (format) => {
        setExporting(format);
        try {
            const params = buildQueryParams(true);
            const response = await fetch(`/api/users/activity-logs/export?${params.toString()}`, {
                headers: authHeaders(),
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to export logs');
            }

            const exportRows = (Array.isArray(data.rows) ? data.rows : []).map((row) => {
                const entityLabel = row.entity_type || '';
                const entityIdSuffix = row.entity_id ? ` (${row.entity_id})` : '';
                return {
                    time: formatDateTime(row.created_at),
                    user: row.user_name || '',
                    eventType: row.event_type || '',
                    event: row.event_name || '',
                    module: row.module || '',
                    screen: row.screen || '',
                    entity: `${entityLabel}${entityIdSuffix}`,
                    result: row.success === 1 || row.success === true ? 'Success' : 'Failure',
                    durationMs: row.duration_ms || '',
                    status: row.status_code || '',
                    ip: row.ip_address || '',
                    metadata: row.metadata || '',
                };
            });

            const worksheet = XLSX.utils.json_to_sheet(exportRows);
            const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');

            if (format === 'csv') {
                const csv = XLSX.utils.sheet_to_csv(worksheet);
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `admin-logs-${timestamp}.csv`;
                link.click();
                URL.revokeObjectURL(url);
            } else {
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, 'AdminLogs');
                XLSX.writeFile(workbook, `admin-logs-${timestamp}.xlsx`);
            }

            await logAdminActivity('admin.logs.export', {
                format,
                exportedRows: exportRows.length,
                filters,
            });
        } catch (err) {
            setError(err.message || 'Failed to export logs');
        } finally {
            setExporting('');
        }
    };

    const renderTableRows = () => {
        if (loading) {
            return [(
                <tr key="loading-row">
                    <td colSpan="7" style={{ textAlign: 'center', padding: '2rem' }}>Loading activity logs...</td>
                </tr>
            )];
        }

        if (rows.length === 0) {
            return [(
                <tr key="empty-row">
                    <td colSpan="7" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                        No activity logs found for selected filters.
                    </td>
                </tr>
            )];
        }

        return rows.map((row) => {
            const success = row.success === 1 || row.success === true;
            return (
                <tr key={row.id}>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td>{row.user_name || `User #${row.user_id || '-'}`}</td>
                    <td>{row.module || '-'}</td>
                    <td>
                        {row.entity_type || '-'}
                        {row.entity_id ? ` (${row.entity_id})` : ''}
                    </td>
                    <td>
                        <span style={{
                            padding: '4px 10px',
                            borderRadius: '999px',
                            fontSize: '0.78rem',
                            fontWeight: 600,
                            background: success ? '#DCFCE7' : '#FEE2E2',
                            color: success ? '#166534' : '#991B1B',
                        }}>
                            {success ? 'Success' : 'Failure'}
                        </span>
                    </td>
                    <td>{row.duration_ms ? `${row.duration_ms}ms` : '-'}</td>
                    <td>{row.status_code || '-'}</td>
                </tr>
            );
        });
    };

    return (
        <div className="container page-shell fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.35rem', color: 'var(--text-strong)' }}>Admin Logs</h1>
                    <p style={{ margin: '0.35rem 0 0 0', color: 'var(--text-muted)', fontSize: '0.92rem' }}>
                        View and filter application activity by user, event, module, date range, and success/failure.
                    </p>
                </div>
                <button className="btn btn-primary" onClick={fetchLogs} disabled={loading}>
                    {loading ? 'Refreshing...' : 'Refresh'}
                </button>
            </div>

            <div style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: '10px',
                padding: '1rem',
                marginBottom: '1rem'
            }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                    <div>
                        <label className="input-label" htmlFor="activity-user-filter">User</label>
                        <input
                            id="activity-user-filter"
                            className="input-field"
                            placeholder="Name contains"
                            value={filters.userName}
                            onChange={(e) => updateFilter('userName', e.target.value)}
                        />
                    </div>

                    <div>
                        <label className="input-label" htmlFor="activity-event-filter">Event</label>
                        <input
                            id="activity-event-filter"
                            className="input-field"
                            placeholder="e.g. auth.login, screen.view"
                            value={filters.eventName}
                            onChange={(e) => updateFilter('eventName', e.target.value)}
                        />
                    </div>

                    <div>
                        <label className="input-label" htmlFor="activity-event-type-filter">Event Type</label>
                        <select
                            id="activity-event-type-filter"
                            className="input-field"
                            value={filters.eventType}
                            onChange={(e) => updateFilter('eventType', e.target.value)}
                        >
                            <option value="all">All</option>
                            <option value="auth">Auth</option>
                            <option value="screen">Screen</option>
                            <option value="action">Action</option>
                            <option value="error">Error</option>
                        </select>
                    </div>

                    <div>
                        <label className="input-label" htmlFor="activity-module-filter">Module</label>
                        <select
                            id="activity-module-filter"
                            className="input-field"
                            value={filters.module}
                            onChange={(e) => updateFilter('module', e.target.value)}
                        >
                            {moduleOptions.map((option) => (
                                <option key={option} value={option}>
                                    {option === 'all' ? 'All' : option}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="input-label" htmlFor="activity-success-filter">Result</label>
                        <select
                            id="activity-success-filter"
                            className="input-field"
                            value={filters.success}
                            onChange={(e) => updateFilter('success', e.target.value)}
                        >
                            <option value="all">All</option>
                            <option value="true">Success</option>
                            <option value="false">Failure</option>
                        </select>
                    </div>

                    <div>
                        <label className="input-label" htmlFor="activity-from-date">From Date</label>
                        <DatePicker
                            id="activity-from-date"
                            value={filters.fromDate}
                            onChange={(e) => updateFilter('fromDate', e.target.value)}
                        />
                    </div>

                    <div>
                        <label className="input-label" htmlFor="activity-to-date">To Date</label>
                        <DatePicker
                            id="activity-to-date"
                            value={filters.toDate}
                            onChange={(e) => updateFilter('toDate', e.target.value)}
                        />
                    </div>

                    <div style={{ gridColumn: '1 / -1' }}>
                        <label className="input-label" htmlFor="activity-search">Search</label>
                        <input
                            id="activity-search"
                            className="input-field premium-search-field"
                            placeholder="Search in event/module/screen/entity/metadata"
                            value={filters.search}
                            onChange={(e) => updateFilter('search', e.target.value)}
                        />
                    </div>

                    <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button type="button" className="btn btn-outline" onClick={() => applyDatePreset('today')}>Today</button>
                        <button type="button" className="btn btn-outline" onClick={() => applyDatePreset('last7')}>Last 7 days</button>
                        <button type="button" className="btn btn-outline" onClick={() => applyDatePreset('last30')}>Last 30 days</button>
                        <button type="button" className="btn btn-outline" onClick={() => applyDatePreset('thisMonth')}>This month</button>
                    </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.9rem', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <div style={{ color: 'var(--text-body)', fontSize: '0.9rem' }}>
                        Showing {rows.length} of {total} logs
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <label className="input-label" htmlFor="activity-timezone" style={{ marginBottom: 0 }}>Timezone</label>
                        <select
                            id="activity-timezone"
                            className="input-field"
                            style={{ width: '130px', padding: '0.5rem 0.75rem' }}
                            value={timezone}
                            onChange={(e) => setTimezone(e.target.value)}
                        >
                            <option value="local">Local</option>
                            <option value="ist">IST</option>
                            <option value="utc">UTC</option>
                        </select>

                        <label className="input-label" htmlFor="activity-page-size" style={{ marginBottom: 0 }}>Rows</label>
                        <select
                            id="activity-page-size"
                            className="input-field"
                            style={{ width: '100px', padding: '0.5rem 0.75rem' }}
                            value={pageSize}
                            onChange={(e) => {
                                setPage(1);
                                setPageSize(Number.parseInt(e.target.value, 10));
                            }}
                        >
                            {PAGE_SIZE_OPTIONS.map((size) => (
                                <option key={size} value={size}>{size}</option>
                            ))}
                        </select>

                        <button type="button" className="btn btn-outline" onClick={clearFilters}>Clear Filters</button>
                        <button type="button" className="btn btn-outline" onClick={() => handleExport('csv')} disabled={Boolean(exporting)}>
                            {exporting === 'csv' ? 'Exporting CSV...' : 'Export CSV'}
                        </button>
                        <button type="button" className="btn btn-outline" onClick={() => handleExport('xlsx')} disabled={Boolean(exporting)}>
                            {exporting === 'xlsx' ? 'Exporting Excel...' : 'Export Excel'}
                        </button>
                    </div>
                </div>
            </div>

            {error && (
                <div style={{
                    marginBottom: '1rem',
                    border: '1px solid #FECACA',
                    background: '#FEF2F2',
                    color: '#991B1B',
                    borderRadius: '8px',
                    padding: '0.8rem',
                }}>
                    {error}
                </div>
            )}

            <div className="table-container" style={{ marginBottom: '1rem' }}>
                <table className="table" style={{ minWidth: '1000px' }}>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>User</th>
                            <th>Module</th>
                            <th>Entity</th>
                            <th>Result</th>
                            <th>Duration</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>{renderTableRows()}</tbody>
                </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={{ color: 'var(--text-body)', fontSize: '0.9rem' }}>
                    Page {page} of {totalPages}
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button type="button" className="btn btn-outline" disabled={!canGoPrev} onClick={() => setPage((prev) => Math.max(prev - 1, 1))}>
                        Previous
                    </button>
                    <button type="button" className="btn btn-primary" disabled={!canGoNext} onClick={() => setPage((prev) => prev + 1)}>
                        Next
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AdminLogsPage;
