import React, { useState, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { useNavigate } from 'react-router-dom';
import '../voucher-styles.css';

// ── date/duration helpers ──
const DAY_MS = 86400000;

// SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" in UTC. A plain new Date()
// mis-reads them as local time (wrong displayed time + off-by-one day counts,
// and Invalid Date on Safari). Normalize to an explicit UTC instant.
const parseDbDate = (v) => {
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    let s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
        s = s.replace(' ', 'T') + 'Z';          // space-separated UTC → ISO UTC
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) {
        s = s + 'Z';                             // ISO without offset → assume UTC
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
};

const compactDate = (v) => {
    const d = parseDbDate(v);
    if (!d) return '';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const daysBetween = (from, to) => {
    const a = parseDbDate(from), b = parseDbDate(to);
    if (!a || !b) return null;
    return Math.max(0, Math.floor((b - a) / DAY_MS));
};
const elapsedDays = (from) => {
    const a = parseDbDate(from);
    if (!a) return 0;
    return Math.max(0, Math.floor((Date.now() - a) / DAY_MS));
};
const overdueColor = (days) => (days >= 4 ? '#DC2626' : days >= 2 ? '#D97706' : '#64748B');
const durLabel = (d) => (d === null ? '' : d === 0 ? 'same day' : `${d} day${d === 1 ? '' : 's'}`);

const ACTIVE_STATUSES = ['pending_approval_1', 'pending_approval_2', 'info_requested'];
const COMPLETED_STATUSES = ['approved', 'processed'];
const TRACKED_STATUSES = [...ACTIVE_STATUSES, ...COMPLETED_STATUSES];
const COMPLETED_LIMIT = 30; // most recent completed claims to keep in the log
const REMIND_MIN_DAYS = 3;  // reminder allowed only after the approver has held it this long

const TrackClaimsPage = () => {
    const { getToken, user } = useAuth();
    const dialog = useDialog();
    const navigate = useNavigate();
    const [claims, setClaims] = useState([]);
    const [loading, setLoading] = useState(true);
    const [remindingId, setRemindingId] = useState(null);

    const authHeaders = () => ({ 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() });

    const fetchClaims = async () => {
        try {
            const res = await fetch('/api/jcc/vouchers', { headers: authHeaders() });
            if (res.ok) {
                const data = await res.json();
                const mine = Array.isArray(data)
                    ? data.filter(v => TRACKED_STATUSES.includes(v.status) && (!user?.id || v.user_id === user.id || user?.role === 'admin'))
                    : [];
                setClaims(mine);
            }
        } catch (err) {
            console.error('Error fetching claims to track:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchClaims();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleRemind = async (voucher) => {
        setRemindingId(voucher.id);
        try {
            const res = await fetch(`/api/jcc/vouchers/${voucher.id}/remind`, { method: 'POST', headers: authHeaders() });
            const data = await res.json();
            await dialog.alert(res.ok ? (data.message || 'Reminder sent.') : (data.error || 'Could not send reminder.'));
        } catch (err) {
            console.error('Error sending reminder:', err);
            await dialog.alert('Could not send reminder. Please try again.');
        } finally {
            setRemindingId(null);
        }
    };

    const jccId = (v) => v.jcc_number || `JCC${String(v.id).padStart(4, '0')}`;

    const renderTimeline = (v) => {
        const rows = [];
        rows.push(<TimelineRow key="sub" dotColor="#94A3B8" label="Submitted" value={compactDate(v.created_at)} />);
        // Level 1 — reviewer approval, with who + exact time + how long it took
        if (v.approver1_status === 'approved' && v.approver1_date) {
            rows.push(<TimelineRow key="l1" dotColor="#059669" label={`Reviewed by ${v.approver1_name || 'Manager'}`} value={`${compactDate(v.approver1_date)} · ${durLabel(daysBetween(v.created_at, v.approver1_date))}`} />);
        }
        // Level 2 — final approver, with who + exact time + how long after L1
        if (v.approver2_status === 'approved' && v.approver2_date) {
            rows.push(<TimelineRow key="l2" dotColor="#059669" label={`Approved by ${v.approver2_name || 'Final Approver'}`} value={`${compactDate(v.approver2_date)} · ${durLabel(daysBetween(v.approver1_date, v.approver2_date))}`} />);
        }
        if (v.status === 'pending_approval_1') {
            const d = elapsedDays(v.created_at);
            rows.push(<TimelineRow key="cur" dotColor={overdueColor(d)} pulsing label={`Waiting ${durLabel(d)} — with ${v.approver1_name || 'Manager'}`} valueColor={overdueColor(d)} />);
        } else if (v.status === 'pending_approval_2') {
            const d = elapsedDays(v.approver1_date || v.created_at);
            rows.push(<TimelineRow key="cur" dotColor={overdueColor(d)} pulsing label={`Waiting ${durLabel(d)} — with ${v.approver2_name || 'Final Approver'}`} valueColor={overdueColor(d)} />);
        } else if (v.status === 'info_requested') {
            rows.push(<TimelineRow key="cur" dotColor="#B45309" pulsing label="More info requested — awaiting your response" valueColor="#B45309" />);
        } else if (COMPLETED_STATUSES.includes(v.status)) {
            const total = daysBetween(v.created_at, v.approver2_date);
            rows.push(<TimelineRow key="done" dotColor="#059669" label="✓ Fully approved" value={total !== null ? `total ${durLabel(total)}` : ''} valueColor="#059669" />);
        }
        return <div style={{ display: 'grid', gap: '6px' }}>{rows}</div>;
    };

    const renderCard = (v) => {
        const isPending = v.status === 'pending_approval_1' || v.status === 'pending_approval_2';
        const isApproved = COMPLETED_STATUSES.includes(v.status);
        const waitDays = v.status === 'pending_approval_2' ? elapsedDays(v.approver1_date || v.created_at) : elapsedDays(v.created_at);
        const accent = isApproved ? '#059669' : (isPending ? overdueColor(waitDays) : '#B45309');
        return (
            <div key={v.id} className="glass-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `4px solid ${accent}`, padding: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', marginBottom: '10px' }}>
                    <div>
                        <div style={{ fontWeight: 700, color: '#0066CC' }}>{jccId(v)}</div>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-body)' }}>{v.supplier || '—'}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            Inv {v.invoice_number || '—'} · ₹{Number.parseFloat(v.basic_amount || 0).toLocaleString('en-IN')}
                        </div>
                    </div>
                    <span className="badge" style={{
                        background: isApproved ? '#DCFCE7' : '#FEF3C7',
                        color: isApproved ? '#166534' : '#92400E',
                        border: `1px solid ${isApproved ? '#86EFAC' : '#FCD34D'}`,
                        whiteSpace: 'nowrap'
                    }}>
                        {v.status === 'pending_approval_1' ? 'Pending Manager' : v.status === 'pending_approval_2' ? 'Pending Final' : isApproved ? '✓ Approved' : 'Info Requested'}
                    </span>
                </div>

                <div style={{ padding: '10px 0', borderTop: '1px dashed var(--border)' }}>
                    {renderTimeline(v)}
                </div>

                {(isPending || v.status === 'info_requested') && (
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        {isPending && waitDays >= REMIND_MIN_DAYS && (
                            <button
                                className="btn"
                                disabled={remindingId === v.id}
                                onClick={() => handleRemind(v)}
                                style={{ background: '#D97706', color: 'white', padding: '8px 14px', fontSize: '0.85rem' }}
                                title="Remind the current approver (once per day)"
                            >
                                {remindingId === v.id ? 'Sending…' : '🔔 Remind approver'}
                            </button>
                        )}
                        {isPending && waitDays < REMIND_MIN_DAYS && (
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>
                                🔔 You can remind the approver after {REMIND_MIN_DAYS} days ({waitDays} so far)
                            </span>
                        )}
                        {v.status === 'info_requested' && (
                            <button
                                className="btn"
                                onClick={() => navigate('/voucher-history')}
                                style={{ background: '#B45309', color: 'white', padding: '8px 14px', fontSize: '0.85rem' }}
                            >
                                ℹ Respond
                            </button>
                        )}
                    </div>
                )}
            </div>
        );
    };

    // Split into in-progress (oldest first) and completed (most recent approvals first)
    const ts = (v) => (parseDbDate(v)?.getTime() ?? 0);
    const active = claims
        .filter(v => ACTIVE_STATUSES.includes(v.status))
        .sort((a, b) => ts(a.created_at) - ts(b.created_at));
    const completed = claims
        .filter(v => COMPLETED_STATUSES.includes(v.status))
        .sort((a, b) => ts(b.approver2_date || b.created_at) - ts(a.approver2_date || a.created_at))
        .slice(0, COMPLETED_LIMIT);

    if (loading) {
        return (
            <div className="container page-shell">
                <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">Loading your active claims…</div>
            </div>
        );
    }

    return (
        <div className="container page-shell fade-in">
            <div className="voucher-hero">
                <h1>Track Claims</h1>
                <p>In-progress claims — who has each one and how long it's waited — plus an approval log of recently completed claims with review &amp; approval times.</p>
            </div>

            {active.length === 0 && completed.length === 0 ? (
                <div className="glass-card" style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🎉</div>
                    <h3 style={{ margin: '0 0 0.25rem 0', color: 'var(--text-strong)' }}>Nothing to track</h3>
                    <p style={{ margin: 0 }}>You have no claims in progress or recently approved.</p>
                </div>
            ) : (
                <>
                    {active.length > 0 && (
                        <div style={{ marginBottom: '2rem' }}>
                            <h2 style={{ color: '#0066CC', fontSize: '1.2rem', margin: '0 0 0.75rem 0' }}>In progress ({active.length})</h2>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '16px' }}>
                                {active.map(renderCard)}
                            </div>
                        </div>
                    )}

                    {completed.length > 0 && (
                        <div>
                            <h2 style={{ color: '#166534', fontSize: '1.2rem', margin: '0 0 0.75rem 0' }}>✓ Completed — approval log ({completed.length})</h2>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '16px' }}>
                                {completed.map(renderCard)}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

const TimelineRow = ({ dotColor, label, value, valueColor, pulsing }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '0.8rem' }}>
        <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: dotColor, flexShrink: 0, alignSelf: 'center', boxShadow: pulsing ? `0 0 0 3px ${dotColor}22` : 'none' }} />
        <span style={{ color: valueColor || '#334155', fontWeight: pulsing ? 600 : 500 }}>{label}</span>
        {value && <span style={{ color: 'var(--text-faint)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>{value}</span>}
    </div>
);

export default TrackClaimsPage;
