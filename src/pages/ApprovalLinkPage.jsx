import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { formatDate } from '../utils/datetime';

// Approval reached from the one-click link in an approval email.
//
// This route is deliberately public: the signed token in the URL carries the
// authority, and the approver is usually opening it from a mail client without a
// portal session. It replaces the bare API-rendered confirmation page so the
// approver sees the claim inside the app, with the full details they need to
// decide, rather than a three-row summary on a blank page.

const Row = ({ label, value, strong }) => (
    <div style={{
        display: 'flex', justifyContent: 'space-between', gap: '1rem',
        padding: '0.55rem 0', borderBottom: '1px solid var(--border)',
    }}>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{label}</span>
        <span style={{
            color: 'var(--text-strong)', fontSize: '0.9rem', textAlign: 'right',
            fontWeight: strong ? 700 : 500,
        }}>{value || '-'}</span>
    </div>
);

const Panel = ({ children, accent }) => (
    <div className="container page-shell" style={{ maxWidth: '640px' }}>
        <div className="fade-in glass-card" style={{ marginTop: '3rem', borderTop: `3px solid ${accent}` }}>
            {children}
        </div>
    </div>
);

const ApprovalLinkPage = () => {
    const { token } = useParams();
    const navigate = useNavigate();
    const [state, setState] = useState({ loading: true });
    const [submitting, setSubmitting] = useState(false);
    const [done, setDone] = useState(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/jcc/approval-link/${token}`, {
                headers: { Accept: 'application/json' },
            });
            const data = await res.json();
            setState({ loading: false, ...data });
        } catch (e) {
            setState({ loading: false, ok: false, error: 'Could not reach the server. Check your connection and reload.' });
        }
    }, [token]);

    useEffect(() => { load(); }, [load]);

    const approve = async () => {
        setSubmitting(true);
        try {
            const res = await fetch(`/api/jcc/approve-via-link/${token}`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: '{}',
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || 'Could not approve this claim.');
            setDone(data);
        } catch (e) {
            setState((prev) => ({ ...prev, ok: false, error: e.message }));
        } finally {
            setSubmitting(false);
        }
    };

    if (state.loading) {
        return (
            <div className="flex items-center justify-center" style={{ minHeight: '70vh' }}>
                <div className="spinner"></div>
            </div>
        );
    }

    if (done) {
        return (
            <Panel accent="var(--stat-emerald)">
                <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.4rem', color: 'var(--stat-emerald)' }}>Approved</h1>
                <p style={{ color: 'var(--text-body)', margin: '0 0 1.25rem' }}>{done.message}</p>
                <button className="btn btn-primary" onClick={() => navigate('/hub')}>Go to the portal</button>
            </Panel>
        );
    }

    // Expired, already approved, wrong approver, or a malformed token.
    if (!state.ok) {
        const alreadyHandled = state.reason === 'not_actionable';
        return (
            <Panel accent={alreadyHandled ? 'var(--stat-amber)' : 'var(--stat-red)'}>
                <h1 style={{
                    margin: '0 0 0.5rem', fontSize: '1.4rem',
                    color: alreadyHandled ? 'var(--stat-amber)' : 'var(--stat-red)',
                }}>
                    {alreadyHandled ? 'Nothing to approve' : 'This link cannot be opened'}
                </h1>
                <p style={{ color: 'var(--text-body)', margin: '0 0 0.5rem' }}>{state.error}</p>
                {state.jccId && (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0 0 1.25rem' }}>{state.jccId}</p>
                )}
                <button className="btn btn-outline" onClick={() => navigate('/hub')}>Open the portal</button>
            </Panel>
        );
    }

    const v = state.voucher || {};
    const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

    return (
        <Panel accent="var(--primary)">
            <p style={{
                margin: 0, fontSize: '0.72rem', letterSpacing: '0.1em', textTransform: 'uppercase',
                color: 'var(--primary)', fontWeight: 700,
            }}>
                {state.levelLabel}
            </p>
            <h1 style={{ margin: '0.35rem 0 0.25rem', fontSize: '1.6rem', color: 'var(--text-strong)' }}>
                Approve {state.jccId}
            </h1>
            <p style={{ color: 'var(--text-muted)', margin: '0 0 1.25rem', fontSize: '0.9rem' }}>
                {state.approverName ? `Approving as ${state.approverName}. ` : ''}
                Check the details below before you approve.
            </p>

            <div style={{ marginBottom: '1.25rem' }}>
                <Row label="Claimed by" value={v.claimedBy} />
                <Row label="Supplier" value={v.supplier} />
                <Row label="Invoice No." value={v.invoiceNumber} />
                <Row label="Invoice date" value={formatDate(v.invoiceDate)} />
                <Row label="Department" value={v.department} />
                <Row label="PO No." value={v.poNumber} />
                <Row label="Nature of expense" value={v.natureOfExpenses} />
                <Row label="Basic amount" value={money(v.basicAmount)} strong />
                <Row label="Gross amount" value={money(v.grossAmount)} strong />
            </div>

            {v.description && (
                <div style={{
                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                    borderRadius: '8px', padding: '0.75rem 0.9rem', marginBottom: '1.25rem',
                }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>Description</div>
                    <div style={{ fontSize: '0.88rem', color: 'var(--text-body)' }}>{v.description}</div>
                </div>
            )}

            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" onClick={approve} disabled={submitting}
                        style={{ background: 'var(--stat-emerald)', borderColor: 'var(--stat-emerald)' }}>
                    {submitting ? 'Approving…' : `Approve ${state.jccId}`}
                </button>
                <button className="btn btn-outline" onClick={() => navigate('/hub')} disabled={submitting}>
                    Open the portal instead
                </button>
            </div>
            <p style={{ color: 'var(--text-faint)', fontSize: '0.78rem', marginTop: '0.9rem', marginBottom: 0 }}>
                If you did not intend to approve this, just close the page — nothing is recorded until you press Approve.
            </p>
        </Panel>
    );
};

export default ApprovalLinkPage;
