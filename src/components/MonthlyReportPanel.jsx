import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { formatDate } from '../utils/datetime';

// Monthly printing report — preview.
//
// Everything shown here comes from GET /api/annexures/monthly-report. No total is
// recomputed in the browser: the API is the source of truth, so what a coordinator
// checks on screen is exactly what the Excel will contain. The only arithmetic here is
// dividing paise by 100 for display.

const money = (paise) =>
    `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const num = (n) => Number(n || 0).toLocaleString('en-IN');

// The month list is built in IST, not from the browser's clock — a user in another
// timezone must still see the same reporting months as the printing department.
const IST_OFFSET_MS = 330 * 60 * 1000;
const istNow = () => new Date(Date.now() + IST_OFFSET_MS);

const monthOptions = (back = 18, forward = 1) => {
    const now = istNow();
    const out = [];
    for (let i = -forward; i <= back; i += 1) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        out.push({
            key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
            label: d.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        });
    }
    return out;
};

const currentMonthKey = () => {
    const n = istNow();
    return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`;
};

const EMPTY = { month: '', manager: '', member: '', department: '', debit_code: '', project: '' };

const Stat = ({ label, value, tone }) => (
    <div style={{
        padding: '0.6rem 0.9rem', borderRadius: '10px', background: 'var(--surface-2)',
        border: '1px solid var(--border)', minWidth: '128px',
    }}>
        <div className="text-muted" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {label}
        </div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: tone || 'var(--text-strong)',
                      fontVariantNumeric: 'tabular-nums' }}>
            {value}
        </div>
    </div>
);

const MonthlyReportPanel = ({ authHeaders }) => {
    const [filters, setFilters] = useState({ ...EMPTY, month: currentMonthKey() });
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [closedManagers, setClosedManagers] = useState(() => new Set());
    const [closedMembers, setClosedMembers] = useState(() => new Set());
    const [openJob, setOpenJob] = useState(null);
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState('');

    const months = useMemo(() => monthOptions(), []);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams(
                Object.entries(filters).filter(([, v]) => String(v).trim())
            ).toString();
            const res = await fetch(`/api/annexures/monthly-report?${params}`, { headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Unable to load the monthly report.');
            setReport(data);
        } catch (e) {
            // The previous month's figures must not sit on screen under a new month's
            // heading — clearing is the honest response to a failed load.
            setReport(null);
            setError(e.message || 'Unable to load the monthly report.');
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filters]);

    useEffect(() => { load(); }, [load]);

    // The export needs the same Authorization header as every other call, so it cannot
    // be a plain <a href>. Fetch the bytes, then hand them to the browser as a blob.
    const download = useCallback(async () => {
        setDownloading(true);
        setDownloadError('');
        let url = null;
        try {
            const params = new URLSearchParams(
                Object.entries(filters).filter(([, v]) => String(v).trim())
            ).toString();
            const res = await fetch(`/api/annexures/monthly-report/export?${params}`,
                { headers: authHeaders() });
            if (!res.ok) {
                // A failure comes back as JSON even though we asked for a spreadsheet.
                const detail = await res.json().catch(() => ({}));
                throw new Error(detail.error || 'Unable to generate the Excel report.');
            }
            // Prefer the server's filename — it already describes the month and filter.
            const disposition = res.headers.get('Content-Disposition') || '';
            const named = /filename="([^"]+)"/.exec(disposition);
            const blob = await res.blob();

            url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = named ? named[1] : `Printing_Annexure_${filters.month}.xlsx`;
            document.body.appendChild(a);
            a.click();
            a.remove();

            // Any paper the template has no row for is flagged rather than left for
            // someone to discover as a missing line when the totals are checked.
            const unmapped = res.headers.get('X-Unmapped-Paper-Rows');
            if (unmapped) setDownloadError(`Not on the template, excluded: ${unmapped}`);
        } catch (e) {
            setDownloadError(e.message || 'Unable to generate the Excel report.');
        } finally {
            // Revoke after the click has been handled, or the download can be cancelled.
            if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
            setDownloading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filters]);

    const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));

    const options = report?.options || { managers: [], members: [], departments: [], debit_codes: [], projects: [] };

    // Which summary rows the rate template cannot price. Keyed the same way the API
    // keys them, so the marking cannot drift from the warning panel.
    const unmappedKeys = useMemo(
        () => new Set((report?.unmapped_rows || []).map((r) => r.key)),
        [report],
    );

    // Picking a manager narrows the member list to their team. Members carry their
    // manager_id on the option itself, so this needs no extra request.
    const visibleMembers = filters.manager
        ? options.members.filter((m) => String(m.manager_id) === String(filters.manager))
        : options.members;

    const toggle = (setter) => (key) => setter((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    const toggleManager = toggle(setClosedManagers);
    const toggleMember = toggle(setClosedMembers);

    const activeFilterCount = Object.entries(filters)
        .filter(([k, v]) => k !== 'month' && String(v).trim()).length;

    const monthLabel = months.find((m) => m.key === filters.month)?.label || filters.month;

    return (
        <div className="fade-in">
            {/* ── Controls ── */}
            <div className="glass-card" style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                              flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.85rem' }}>
                    <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
                        Monthly Printing Report
                    </h3>
                    <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                        Jobs whose annexure was approved in the selected month (IST)
                    </span>
                </div>

                <div style={{ display: 'grid', gap: '0.6rem',
                              gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))' }}>
                    <select className="input-field" value={filters.month} aria-label="Month"
                            onChange={(e) => setFilter({ month: e.target.value })}>
                        {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                    <select className="input-field" value={filters.manager} aria-label="Manager"
                            onChange={(e) => setFilter({ manager: e.target.value, member: '' })}>
                        <option value="">All managers</option>
                        {options.managers.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                    <select className="input-field" value={filters.member} aria-label="Team member"
                            onChange={(e) => setFilter({ member: e.target.value })}>
                        <option value="">All team members</option>
                        {visibleMembers.map((m) => (
                            <option key={m.value} value={m.value}>{m.label}{m.ps ? ` (${m.ps})` : ''}</option>
                        ))}
                    </select>
                    <select className="input-field" value={filters.department} aria-label="Department"
                            onChange={(e) => setFilter({ department: e.target.value })}>
                        <option value="">All departments</option>
                        {options.departments.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select className="input-field" value={filters.debit_code} aria-label="Debit code"
                            onChange={(e) => setFilter({ debit_code: e.target.value })}>
                        <option value="">All debit codes</option>
                        {options.debit_codes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select className="input-field" value={filters.project} aria-label="Project"
                            onChange={(e) => setFilter({ project: e.target.value })}>
                        <option value="">All projects</option>
                        {options.projects.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.85rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn btn-sm btn-outline" onClick={load} disabled={loading}>
                        {loading ? 'Loading…' : 'Refresh'}
                    </button>
                    {activeFilterCount > 0 && (
                        <button className="btn btn-sm btn-outline"
                                onClick={() => setFilters({ ...EMPTY, month: filters.month })}>
                            Reset filters
                        </button>
                    )}
                    <button className="btn btn-sm btn-primary" onClick={download}
                            disabled={loading || downloading || !report?.counts?.jobs}
                            title={report?.counts?.jobs
                                ? 'Download this month’s printing annexure'
                                : 'There are no approved jobs in this month to export'}>
                        {downloading ? 'Preparing…' : 'Download Excel'}
                    </button>
                    {downloadError && (
                        <span style={{ fontSize: '0.76rem', color: 'var(--danger, #dc2626)' }}>
                            {downloadError}
                        </span>
                    )}
                </div>
            </div>

            {loading && (
                <div className="glass-card" style={{ textAlign: 'center', padding: '2rem' }}>
                    <div className="spinner" style={{ margin: '0 auto 0.75rem' }}></div>
                    <span className="text-muted">Loading {monthLabel} report…</span>
                </div>
            )}

            {!loading && error && (
                <div className="glass-card" style={{ borderLeft: '3px solid var(--stat-red)' }}>
                    <strong style={{ color: 'var(--stat-red)' }}>Unable to load the monthly report.</strong>
                    <p className="text-muted" style={{ fontSize: '0.84rem', margin: '0.35rem 0 0.75rem' }}>{error}</p>
                    <button className="btn btn-sm btn-outline" onClick={load}>Retry</button>
                </div>
            )}

            {!loading && !error && report && report.counts.jobs === 0 && (
                <div className="glass-card">
                    <h3 style={{ marginTop: 0, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
                        {report.month.label}
                    </h3>
                    {/* Deliberately not a row of ₹0 tiles — that reads as a successful
                        report of nothing, rather than "nothing qualified". */}
                    <p className="text-muted" style={{ fontSize: '0.9rem', margin: 0 }}>
                        No approved printing jobs found for {report.month.label}.
                        {activeFilterCount > 0 && ' Try clearing the filters.'}
                    </p>
                </div>
            )}

            {!loading && !error && report && report.counts.jobs > 0 && (
                <>
                    {/* ── Summary ── */}
                    <div className="glass-card" style={{ marginBottom: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                                      flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.85rem' }}>
                            <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
                                {report.month.label}
                            </h3>
                            <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                                Project:{' '}
                                {report.projects.length === 1
                                    ? report.projects[0]
                                    : <strong>Multiple Projects — see the jobs below</strong>}
                            </span>
                        </div>
                        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                            <Stat label="Approved jobs" value={num(report.counts.jobs)} />
                            <Stat label="Managers" value={num(report.counts.managers)} />
                            <Stat label="Team members" value={num(report.counts.members)} />
                            <Stat label="Projects" value={num(report.counts.projects)} />
                            <Stat label="Total pages" value={num(report.totals.pages)} />
                            <Stat label="Print quantity" value={num(report.totals.print_quantity)} />
                            <Stat label="Printing" value={money(report.totals.printing_paise)} />
                            <Stat label="Binding" value={money(report.totals.binding_paise)} />
                            <Stat label="Finishing" value={money(report.totals.finishing_paise)} />
                            <Stat label="Grand total" value={money(report.totals.grand_total_paise)}
                                  tone="var(--stat-emerald)" />
                        </div>
                    </div>

                    {/* ── Items the rate template cannot price ──
                        Shown above the summary, not below it: the figures underneath are
                        incomplete and the reader needs to know that before reading them. */}
                    {report.has_unmapped && (
                        <div className="glass-card" style={{
                            marginBottom: '1rem', borderLeft: '4px solid #b00020',
                        }}>
                            <h3 style={{ marginTop: 0, fontSize: '1rem', color: '#b00020' }}>
                                ⚠ {report.unmapped_rows.length} item{report.unmapped_rows.length === 1 ? '' : 's'} could not be
                                mapped to the current rate template
                            </h3>
                            <p className="text-muted" style={{ fontSize: '0.82rem', marginTop: 0 }}>
                                No rate exists on the template for these, so they carry no amount and are
                                <strong> excluded from the Grand Total above</strong>. They are listed rather
                                than priced against a different paper, and appear on the Excel’s
                                “Unmapped Items” sheet.
                            </p>
                            <div className="table-container">
                                <table className="table table-compact">
                                    <thead>
                                        <tr><th>Service</th><th>Paper</th><th>Type</th><th>Size</th>
                                            <th style={{ textAlign: 'right' }}>Quantity</th><th>Status</th></tr>
                                    </thead>
                                    <tbody>
                                        {report.unmapped_rows.map((r) => (
                                            <tr key={r.key}>
                                                <td>{r.label || '—'}</td>
                                                <td style={{ fontWeight: 600 }}>{r.paper_gsm ? `${r.paper_gsm} GSM` : '—'}</td>
                                                <td>{r.colour_label || '—'}</td>
                                                <td>{r.paper_size || '—'}</td>
                                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                                                    {num(r.quantity)}
                                                </td>
                                                <td style={{ color: '#b00020', fontWeight: 600, fontSize: '0.78rem' }}>
                                                    {r.reason || 'RATE NOT CONFIGURED'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* ── Printing summary: the Excel rate block ── */}
                    <div className="glass-card" style={{ marginBottom: '1rem' }}>
                        <h3 style={{ marginTop: 0, color: 'var(--text-strong)', fontSize: '1.05rem' }}>
                            Printing Summary
                        </h3>
                        <p className="text-muted" style={{ fontSize: '0.82rem', marginTop: 0 }}>
                            Monthly cumulative quantity per paper, type and size — the figures that fill the
                            Qty column of the printing department's sheet.
                        </p>
                        <div className="table-container table-scroll">
                            <table className="table table-compact">
                                <thead>
                                    <tr><th>Service</th><th>Paper</th><th>Type</th><th>Size</th>
                                        <th style={{ textAlign: 'right' }}>Quantity</th></tr>
                                </thead>
                                <tbody>
                                    {report.paper_rows.map((r) => {
                                        // A row listed here but absent from the Excel rate block would read
                                        // as an ordinary priced line. Mark it, so this table cannot
                                        // contradict the warning above it.
                                        const isUnmapped = unmappedKeys.has(r.key);
                                        return (
                                        <tr key={r.key} style={isUnmapped ? { opacity: 0.75 } : undefined}>
                                            {/* Two rows can share paper, type and size and still belong on
                                                different rate rows — "Plain paper" A3/100 GSM against ordinary
                                                printing on A3/100 GSM. Without the service they look like a
                                                duplicate. */}
                                            <td>
                                                {r.label || '—'}
                                                {isUnmapped && (
                                                    <span style={{ color: '#b00020', fontWeight: 700, fontSize: '0.7rem',
                                                                   marginLeft: '0.4rem', whiteSpace: 'nowrap' }}>
                                                        ⚠ NOT ON TEMPLATE
                                                    </span>
                                                )}
                                            </td>
                                            <td style={{ fontWeight: 600 }}>{r.paper_gsm ? `${r.paper_gsm} GSM` : '—'}</td>
                                            <td>{r.colour_label || '—'}</td>
                                            <td>{r.paper_size || '—'}</td>
                                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                                                {num(r.quantity)}
                                            </td>
                                        </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* ── Manager → member → job ── */}
                    {report.managers.map((mgr) => {
                        const mKey = `m${mgr.manager_id ?? 'none'}`;
                        const mOpen = !closedManagers.has(mKey);
                        return (
                            <div className="glass-card" key={mKey} style={{ marginBottom: '1rem' }}>
                                <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.05rem', cursor: 'pointer',
                                             display: 'flex', alignItems: 'center', gap: '0.4rem', userSelect: 'none',
                                             flexWrap: 'wrap' }}
                                    onClick={() => toggleManager(mKey)}>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{mOpen ? '▾' : '▸'}</span>
                                    {mgr.manager_name}
                                    {mgr.manager_ps && (
                                        <span className="text-muted" style={{ fontWeight: 400 }}> ({mgr.manager_ps})</span>
                                    )}
                                    <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 400, marginLeft: 'auto' }}>
                                        {mgr.members.length} member{mgr.members.length === 1 ? '' : 's'}
                                        {' · '}{mgr.totals.jobs} job{mgr.totals.jobs === 1 ? '' : 's'}
                                    </span>
                                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--stat-emerald)' }}>
                                        {money(mgr.totals.grand_total_paise)}
                                    </span>
                                </h3>

                                {mOpen && mgr.members.map((member) => {
                                    const uKey = `${mKey}|u${member.requestor_id ?? member.requestor_name}`;
                                    const uOpen = !closedMembers.has(uKey);
                                    return (
                                        <div key={uKey} style={{ marginTop: '0.85rem', paddingLeft: '1rem',
                                                                 borderLeft: '2px solid var(--border)' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem',
                                                          cursor: 'pointer', userSelect: 'none', flexWrap: 'wrap' }}
                                                 onClick={() => toggleMember(uKey)}>
                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                                    {uOpen ? '▾' : '▸'}
                                                </span>
                                                <strong style={{ color: 'var(--text-strong)', fontSize: '0.92rem' }}>
                                                    {member.requestor_name}
                                                </strong>
                                                {member.requestor_ps && (
                                                    <span className="text-muted" style={{ fontSize: '0.75rem' }}>{member.requestor_ps}</span>
                                                )}
                                                <span className="text-muted" style={{ fontSize: '0.78rem', marginLeft: 'auto' }}>
                                                    {member.totals.jobs} job{member.totals.jobs === 1 ? '' : 's'}
                                                </span>
                                                <span style={{ fontFamily: 'monospace', fontWeight: 700,
                                                               color: 'var(--stat-emerald)', fontSize: '0.85rem' }}>
                                                    {money(member.totals.grand_total_paise)}
                                                </span>
                                            </div>

                                            {uOpen && (
                                                <div className="table-container" style={{ marginTop: '0.5rem' }}>
                                                    <table className="table table-compact">
                                                        <thead>
                                                            <tr><th>Job</th><th>Annexure</th><th>Project</th>
                                                                <th>Approved</th>
                                                                <th style={{ textAlign: 'right' }}>Print</th>
                                                                <th style={{ textAlign: 'right' }}>Bind</th>
                                                                <th style={{ textAlign: 'right' }}>Finish</th>
                                                                <th style={{ textAlign: 'right' }}>Total</th>
                                                                <th style={{ textAlign: 'center' }}>Detail</th></tr>
                                                        </thead>
                                                        <tbody>
                                                            {member.jobs.map((job) => (
                                                                <React.Fragment key={job.annexure_no}>
                                                                    <tr>
                                                                        <td style={{ fontWeight: 700 }}>{job.job_number}</td>
                                                                        <td className="text-muted">{job.annexure_no}</td>
                                                                        <td>{job.project_name || '—'}</td>
                                                                        <td className="text-muted" style={{ fontSize: '0.8rem' }}>
                                                                            {formatDate(job.approved_at)}
                                                                        </td>
                                                                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(job.printing_paise)}</td>
                                                                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(job.binding_paise)}</td>
                                                                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(job.finishing_paise)}</td>
                                                                        <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700,
                                                                                     color: 'var(--stat-emerald)' }}>
                                                                            {money(job.grand_total_paise)}
                                                                        </td>
                                                                        <td style={{ textAlign: 'center' }}>
                                                                            <button className="btn btn-sm btn-outline"
                                                                                    onClick={() => setOpenJob(openJob === job.annexure_no ? null : job.annexure_no)}>
                                                                                {openJob === job.annexure_no ? 'Hide' : 'View'}
                                                                            </button>
                                                                        </td>
                                                                    </tr>
                                                                    {openJob === job.annexure_no && (
                                                                        <tr>
                                                                            <td colSpan="9" style={{ background: 'var(--surface-2)' }}>
                                                                                <div style={{ display: 'grid', gap: '0.5rem 1.5rem',
                                                                                              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                                                                                              fontSize: '0.82rem', padding: '0.4rem 0' }}>
                                                                                    <div><span className="text-muted">Requestor</span><br />{member.requestor_name}</div>
                                                                                    <div><span className="text-muted">Manager</span><br />{mgr.manager_name}</div>
                                                                                    <div><span className="text-muted">Project</span><br />{job.project_name || '—'}</div>
                                                                                    <div><span className="text-muted">Project no</span><br />{job.project_no || '—'}</div>
                                                                                    <div><span className="text-muted">Debit code</span><br />{job.debit_code || '—'}</div>
                                                                                    <div><span className="text-muted">Department</span><br />{job.department_name || '—'}</div>
                                                                                    <div><span className="text-muted">Approved</span><br />{formatDate(job.approved_at)}</div>
                                                                                    <div><span className="text-muted">Pages</span><br />{num(job.pages)}</div>
                                                                                </div>
                                                                                {job.lines?.length > 0 && (
                                                                                    <table className="table table-compact" style={{ marginTop: '0.5rem' }}>
                                                                                        <thead>
                                                                                            <tr><th>Service</th><th>Spec</th>
                                                                                                <th style={{ textAlign: 'right' }}>Qty</th>
                                                                                                <th style={{ textAlign: 'right' }}>Amount</th></tr>
                                                                                        </thead>
                                                                                        <tbody>
                                                                                            {job.lines.map((l) => (
                                                                                                <tr key={l.service_code + l.paper_size + l.colour_mode}>
                                                                                                    <td>{l.label || l.service_code}</td>
                                                                                                    <td className="text-muted">
                                                                                                        {[l.paper_size, l.paper_gsm, l.colour_mode].filter(Boolean).join(' · ') || '—'}
                                                                                                    </td>
                                                                                                    <td style={{ textAlign: 'right' }}>{num(l.quantity)} {l.uom}</td>
                                                                                                    <td style={{ textAlign: 'right' }}>{money(l.amount_paise)}</td>
                                                                                                </tr>
                                                                                            ))}
                                                                                        </tbody>
                                                                                    </table>
                                                                                )}
                                                                            </td>
                                                                        </tr>
                                                                    )}
                                                                </React.Fragment>
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
                    })}
                </>
            )}
        </div>
    );
};

export default MonthlyReportPanel;
