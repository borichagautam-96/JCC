import React, { useState, useEffect, useRef } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const CoordinatorPage = () => {
    const [invoices, setInvoices] = useState([]);
    const [vouchers, setVouchers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedInvoice, setSelectedInvoice] = useState(null);
    const [selectedVoucher, setSelectedVoucher] = useState(null); // For viewing voucher details
    const [voucherRemark, setVoucherRemark] = useState(''); // Remark for approval/rejection
    const [pdfUrl, setPdfUrl] = useState(null); // For displaying PDF with auth
    const [pdfFullScreen, setPdfFullScreen] = useState(false); // Full-screen document viewer
    const [infoModal, setInfoModal] = useState(null); // Request-info modal { id, jccId }
    const [infoNote, setInfoNote] = useState('');
    const [rejectModal, setRejectModal] = useState(null); // Reject modal { mode:'single'|'bulk', id?, ids?, label }
    const [rejectNote, setRejectNote] = useState('');
    const [isApproving, setIsApproving] = useState(false); // Guard against double-click / concurrent requests
    const [selectedIds, setSelectedIds] = useState([]); // Bulk selection of pending claims
    const [bulkBusy, setBulkBusy] = useState(false);
    const [jccData, setJccData] = useState({
        description: '',
        category: '',
        approvedAmount: '',
    });
    const { getToken, user } = useAuth();
    const dialog = useDialog();

    // ── Bulk selection helpers ───────────────────────────────────────────────
    const toggleSelect = (id) => {
        setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    };
    const toggleSelectAll = () => {
        setSelectedIds(prev => prev.length === vouchers.length ? [] : vouchers.map(v => v.id));
    };

    const runBulk = async (mode /* 'approve' | 'reject' */) => {
        if (selectedIds.length === 0) return;
        // Reject needs a reason → open the styled modal instead of a native prompt
        if (mode === 'reject') {
            setRejectNote('');
            setRejectModal({ mode: 'bulk', ids: [...selectedIds], label: `${selectedIds.length} claim(s)` });
            return;
        }
        const ok = await dialog.confirm(`Approve ${selectedIds.length} selected claim(s)?`, { title: 'Bulk Approve' });
        if (!ok) return;
        setBulkBusy(true);
        try {
            const res = await fetch(`/api/jcc/bulk-approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() },
                body: JSON.stringify({ ids: selectedIds, remark: 'Bulk approved' }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Bulk approve failed');
            setSelectedIds([]);
            await dialog.alert(data.message || `Approved ${selectedIds.length} claim(s).`);
            fetchPendingData();
        } catch (err) {
            console.error('Bulk approve error:', err);
            await dialog.alert(err.message || 'Failed to bulk approve.');
        } finally {
            setBulkBusy(false);
        }
    };

    // Submit a rejection (single or bulk) from the styled Reject modal
    const submitReject = async () => {
        if (!rejectModal) return;
        if (!String(rejectNote).trim()) { await dialog.alert('A remark is required to reject.'); return; }
        if (rejectModal.mode === 'single') {
            setRejectModal(null);
            handleRejectVoucher(rejectModal.id, rejectNote);
            return;
        }
        // bulk
        setBulkBusy(true);
        try {
            const ids = rejectModal.ids;
            const res = await fetch(`/api/jcc/bulk-reject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() },
                body: JSON.stringify({ ids, remark: rejectNote }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Bulk reject failed');
            setSelectedIds([]);
            setRejectModal(null);
            await dialog.alert(data.message || `Rejected ${ids.length} claim(s).`);
            fetchPendingData();
        } catch (err) {
            console.error('Bulk reject error:', err);
            await dialog.alert(err.message || 'Failed to bulk reject.');
        } finally {
            setBulkBusy(false);
        }
    };

    useEffect(() => {
        fetchPendingData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fetch PDF with authentication
    const fetchPdfUrl = async (voucherId) => {
        try {
            const response = await fetch(`/api/jcc/voucher-file/${voucherId}`, {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                setPdfUrl(url);
            }
        } catch (error) {
            console.error('Error fetching PDF:', error);
        }
    };

    // Cleanup PDF URL when modal closes
    const closeVoucherModal = () => {
        setSelectedVoucher(null);
        setVoucherRemark('');
        setPdfFullScreen(false);
        if (pdfUrl) {
            URL.revokeObjectURL(pdfUrl);
            setPdfUrl(null);
        }
    };

    const fetchPendingData = async () => {
        try {
            // Fetch pending invoices
            const invoicesResponse = await fetch('/api/invoices/pending', {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });
            const invoicesData = await invoicesResponse.json();
            setInvoices(invoicesData);

            // ── Fetch vouchers ────────────────────────────────────────────────
            // For managers and final_approvers use the dedicated server-side
            // /my-approvals endpoint which filters by assigned approver name at
            // the DB level (reliable LOWER(TRIM()) matching).
            // For coordinators/admins fetch all vouchers and show pending ones.
            let filteredVouchers;

            if (user?.role === 'manager' || user?.role === 'final_approver') {
                const approvalsResponse = await fetch('/api/jcc/my-approvals', {
                    headers: {
                        'Authorization': `Bearer ${getToken()}`,
                        'X-Device-ID': getDeviceId(),
                    },
                });
                filteredVouchers = approvalsResponse.ok ? await approvalsResponse.json() : [];
                console.log('My approvals (server-filtered):', filteredVouchers);
            } else {
                // For coordinators/admins: show all pending vouchers
                const vouchersResponse = await fetch('/api/jcc/vouchers', {
                    headers: {
                        'Authorization': `Bearer ${getToken()}`,
                        'X-Device-ID': getDeviceId(),
                    },
                });
                const vouchersData = vouchersResponse.ok ? await vouchersResponse.json() : [];
                filteredVouchers = vouchersData.filter(v =>
                    v.status === 'pending_approval_1' ||
                    v.status === 'pending_approval_2' ||
                    v.status === 'pending'
                );
            }

            setVouchers(filteredVouchers);
        } catch (error) {
            console.error('Error fetching data:', error);
        } finally {
            setLoading(false);
        }
    };


    const handleVerifyInvoice = async (invoiceId) => {
        try {
            const response = await fetch(`/api/jcc/verify/${invoiceId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify(jccData),
            });

            if (response.ok) {
                await dialog.alert('Invoice verified and JCC entry created successfully!');
                setSelectedInvoice(null);
                setJccData({ description: '', category: '', approvedAmount: '' });
                fetchPendingData();
            }
        } catch (error) {
            console.error('Error verifying invoice:', error);
            await dialog.alert('Failed to verify invoice');
        }
    };

    const handleReject = async (invoiceId) => {
        const confirmed = await dialog.confirm('Are you sure you want to reject this invoice?');
        if (!confirmed) return;

        try {
            const response = await fetch(`/api/invoices/${invoiceId}/reject`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });

            if (response.ok) {
                await dialog.alert('Invoice rejected');
                fetchPendingData();
            }
        } catch (error) {
            console.error('Error rejecting invoice:', error);
        }
    };

    const handleApproveVoucher = async (voucherId, remarkOverride) => {
        if (isApproving) return;
        setIsApproving(true);
        const remarkToSend = remarkOverride !== undefined ? remarkOverride : voucherRemark;

        try {
            // Always fetch the very latest status from DB before acting
            const freshResponse = await fetch(`/api/jcc/vouchers/${voucherId}`, {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });

            let liveVoucher = vouchers.find(v => v.id === voucherId);
            if (freshResponse.ok) {
                liveVoucher = await freshResponse.json();
            }

            // Determine endpoint by live status
            let endpoint;
            if (liveVoucher?.status === 'pending_approval_1') {
                endpoint = `/api/jcc/approve-level-1/${voucherId}`;
            } else if (liveVoucher?.status === 'pending_approval_2') {
                endpoint = `/api/jcc/approve-level-2/${voucherId}`;
            } else {
                setIsApproving(false);
                alert(`Cannot approve: claim is already "${liveVoucher?.status || 'unknown'}". Please refresh.`);
                return;
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify({ remark: remarkToSend }),
            });

            // ALWAYS reset guard first so UI never gets stuck
            setIsApproving(false);

            if (response.ok) {
                // Close modal and refresh list immediately — no blocking dialog
                setVouchers(prev => prev.filter(v => v.id !== voucherId));
                closeVoucherModal();
                fetchPendingData();
            } else {
                let errMsg = 'Failed to approve claim';
                try { const d = await response.json(); errMsg = d.error || errMsg; } catch (_) {}
                alert(errMsg);
            }
        } catch (error) {
            console.error('Error approving claim:', error);
            setIsApproving(false);
            alert('Failed to approve claim: ' + (error?.message || 'Network error'));
        }
    };

    const handleRejectVoucher = async (voucherId, remarkOverride) => {
        const remarkToSend = remarkOverride !== undefined ? remarkOverride : voucherRemark;
        if (!String(remarkToSend).trim()) {
            alert('Please provide a remark for rejection');
            return;
        }

        if (isApproving) return;
        setIsApproving(true);

        try {
            const freshResponse = await fetch(`/api/jcc/vouchers/${voucherId}`, {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });

            let liveVoucher = vouchers.find(v => v.id === voucherId);
            if (freshResponse.ok) {
                liveVoucher = await freshResponse.json();
            }

            let endpoint;
            if (liveVoucher?.status === 'pending_approval_1') {
                endpoint = `/api/jcc/reject-level-1/${voucherId}`;
            } else if (liveVoucher?.status === 'pending_approval_2') {
                endpoint = `/api/jcc/reject-level-2/${voucherId}`;
            } else {
                setIsApproving(false);
                alert(`Cannot reject: claim is already "${liveVoucher?.status || 'unknown'}". Please refresh.`);
                return;
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify({ remark: remarkToSend }),
            });

            // ALWAYS reset guard first
            setIsApproving(false);

            if (response.ok) {
                // Close modal and refresh immediately — no blocking dialog
                setVouchers(prev => prev.filter(v => v.id !== voucherId));
                closeVoucherModal();
                fetchPendingData();
            } else {
                let errMsg = 'Failed to reject claim';
                try { const d = await response.json(); errMsg = d.error || errMsg; } catch (_) {}
                alert(errMsg);
            }
        } catch (error) {
            console.error('Error rejecting claim:', error);
            setIsApproving(false);
            alert('Failed to reject claim: ' + (error?.message || 'Network error'));
        }
    };

    // Request more info (soft-return) — sends the claim back with a question,
    // WITHOUT rejecting. The claim is preserved and returns to this approver.
    // Open the styled "Request Info" modal (replaces the native window.prompt)
    const handleRequestInfo = (voucherId) => {
        const v = vouchers.find(x => x.id === voucherId) || selectedVoucher;
        const jccId = v ? (v.jcc_number || `JCC${String(v.id).padStart(4, '0')}`) : `#${voucherId}`;
        setInfoNote('');
        setInfoModal({ id: voucherId, jccId });
    };

    const submitInfoRequest = async () => {
        if (!infoModal) return;
        if (!String(infoNote).trim()) { await dialog.alert('Please enter a note describing what you need.'); return; }
        if (isApproving) return;
        setIsApproving(true);
        try {
            const res = await fetch(`/api/jcc/request-info/${infoModal.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() },
                body: JSON.stringify({ note: infoNote }),
            });
            const data = await res.json();
            setIsApproving(false);
            if (!res.ok) throw new Error(data.error || 'Failed to request info');
            setVouchers(prev => prev.filter(v => v.id !== infoModal.id));
            setInfoModal(null);
            closeVoucherModal();
            fetchPendingData();
            await dialog.alert(data.message || 'Sent back to the claimant for more info.');
        } catch (error) {
            setIsApproving(false);
            await dialog.alert(error.message || 'Failed to request info.');
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center" style={{ minHeight: '80vh' }}>
                <div className="spinner"></div>
            </div>
        );
    }

    return (
        <div className="container" style={{ paddingTop: 'var(--spacing-2xl)', paddingBottom: 'var(--spacing-2xl)' }}>
            <div className="fade-in">
                <div style={{
                    background: '#0066CC',
                    color: 'white',
                    padding: '1.5rem 2rem',
                    borderRadius: '8px',
                    marginBottom: '2rem'
                }}>
                    <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'white' }}>
                        {user?.role === 'manager' || user?.role === 'final_approver' ? 'Approval Dashboard' : 'Verify Invoices & Approve Claims'}
                    </h1>
                    <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, color: 'white' }}>
                        {user?.role === 'manager'
                            ? 'Review and approve pending claim requests assigned to you'
                            : 'Review OCR-extracted invoice data and approve pending claim requests'}
                    </p>
                </div>

                {/* Pending Claims Section */}
                {vouchers.length > 0 && (
                    <>
                        <h2 style={{ color: '#0066CC', marginBottom: '1rem', fontSize: '1.5rem' }}>
                            Pending Claims ({vouchers.length})
                        </h2>

                        {/* Bulk action bar — select several claims and approve/reject in one go */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px', marginBottom: '1rem', padding: '10px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '10px' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: 0, fontSize: '0.9rem', color: 'var(--text-body)' }}>
                                <input
                                    type="checkbox"
                                    checked={selectedIds.length > 0 && selectedIds.length === vouchers.length}
                                    onChange={toggleSelectAll}
                                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                                />
                                Select all
                            </label>
                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{selectedIds.length} selected</span>
                            <div style={{ flex: 1 }} />
                            <button
                                type="button"
                                className="btn"
                                disabled={selectedIds.length === 0 || bulkBusy}
                                onClick={() => runBulk('approve')}
                                style={{ background: selectedIds.length && !bulkBusy ? '#059669' : '#94A3B8', color: 'white', padding: '6px 14px' }}
                            >
                                {bulkBusy ? 'Working…' : `✓ Approve selected (${selectedIds.length})`}
                            </button>
                            <button
                                type="button"
                                className="btn"
                                disabled={selectedIds.length === 0 || bulkBusy}
                                onClick={() => runBulk('reject')}
                                style={{ background: selectedIds.length && !bulkBusy ? '#DC2626' : '#94A3B8', color: 'white', padding: '6px 14px' }}
                            >
                                ✕ Reject selected
                            </button>
                        </div>

                        <div className="card-grid" style={{ marginBottom: '2rem' }}>
                            {vouchers.map((voucher) => (
                                <div key={voucher.id} className="glass-card" style={{ background: 'var(--surface)', border: selectedIds.includes(voucher.id) ? '2px solid #0066CC' : '1px solid #E0E0E0' }}>
                                    <div style={{ marginBottom: 'var(--spacing-md)' }}>
                                        <div className="flex items-center gap-sm" style={{ marginBottom: '8px' }}>
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.includes(voucher.id)}
                                                onChange={() => toggleSelect(voucher.id)}
                                                style={{ width: '16px', height: '16px', cursor: 'pointer', flexShrink: 0 }}
                                                title="Select for bulk action"
                                            />
                                            <h3 style={{ margin: 0, color: '#0066CC', fontSize: '1.1rem' }}>{voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`}</h3>
                                        </div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 600, background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A', whiteSpace: 'nowrap' }}>
                                                {voucher.status === 'pending_approval_1' ? 'Pending Manager' : 'Pending Final'}
                                            </span>
                                            {Number(voucher.outdoor_duty) === 1 && (
                                                <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 600, background: '#FFF7ED', color: '#9A3412', border: '1px solid #FED7AA', whiteSpace: 'nowrap' }} title={voucher.outdoor_remark || 'Outdoor / field duty'}>
                                                    ⚠ Backdated
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    <div style={{ display: 'grid', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-lg)' }}>
                                        <div className="flex justify-between">
                                            <span style={{ color: 'var(--text-muted)' }}>Supplier:</span>
                                            <strong style={{ color: 'var(--text-strong)' }}>{voucher.supplier}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: 'var(--text-muted)' }}>Invoice No.:</span>
                                            <strong style={{ color: 'var(--text-strong)' }}>{voucher.invoice_number}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: 'var(--text-muted)' }}>Amount:</span>
                                            <strong style={{ color: '#0066CC', fontSize: '1.1rem' }}>₹{parseFloat(voucher.basic_amount || 0).toLocaleString()}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: 'var(--text-muted)' }}>PO No.:</span>
                                            <strong style={{ color: 'var(--text-strong)' }}>{voucher.po_number || 'N/A'}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: 'var(--text-muted)' }}>Requested By:</span>
                                            <strong style={{ color: 'var(--text-strong)' }}>{voucher.user_name}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: 'var(--text-muted)' }}>Date:</span>
                                            <strong style={{ color: 'var(--text-strong)' }}>{new Date(voucher.created_at).toLocaleDateString()}</strong>
                                        </div>
                                        {voucher.description && (
                                            <div>
                                                <span style={{ color: 'var(--text-muted)' }}>Description:</span>
                                                <p style={{ margin: '4px 0 0 0', fontSize: '0.875rem', color: 'var(--text-strong)' }}>{voucher.description}</p>
                                            </div>
                                        )}
                                    </div>

                                    <div style={{ display: 'grid', gap: '8px' }}>
                                        <button
                                            onClick={() => {
                                                setSelectedVoucher(voucher);
                                                if (voucher.attachment_path) {
                                                    fetchPdfUrl(voucher.id);
                                                }
                                            }}
                                            style={{ padding: '8px', fontSize: '0.82rem', fontWeight: 600, borderRadius: '8px', border: '1px solid var(--border-strong)', background: 'var(--surface)', color: '#0066CC', cursor: 'pointer' }}
                                        >
                                            View Details
                                        </button>
                                        {/* Quick actions — compact */}
                                        <div style={{ display: 'flex', gap: '6px' }}>
                                            <button
                                                disabled={isApproving || bulkBusy}
                                                title="Approve this claim"
                                                onClick={async () => {
                                                    const ok = await dialog.confirm(`Approve ${voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}`}?`, { title: 'Approve Claim' });
                                                    if (ok) handleApproveVoucher(voucher.id, 'Approved');
                                                }}
                                                style={{ flex: 1, padding: '7px 6px', fontSize: '0.8rem', fontWeight: 600, border: 'none', borderRadius: '8px', background: '#059669', color: '#fff', cursor: 'pointer', opacity: (isApproving || bulkBusy) ? 0.6 : 1 }}
                                            >
                                                ✓ Approve
                                            </button>
                                            <button
                                                disabled={isApproving || bulkBusy}
                                                title="Request Info — send back to the claimant with a question, without rejecting"
                                                onClick={() => handleRequestInfo(voucher.id)}
                                                style={{ flex: 1, padding: '7px 6px', fontSize: '0.8rem', fontWeight: 600, border: 'none', borderRadius: '8px', background: '#D97706', color: '#fff', cursor: 'pointer', opacity: (isApproving || bulkBusy) ? 0.6 : 1 }}
                                            >
                                                ℹ Info
                                            </button>
                                            <button
                                                disabled={isApproving || bulkBusy}
                                                title="Reject this claim"
                                                onClick={() => {
                                                    setRejectNote('');
                                                    setRejectModal({ mode: 'single', id: voucher.id, label: voucher.jcc_number || `JCC${String(voucher.id).padStart(4, '0')}` });
                                                }}
                                                style={{ flex: 1, padding: '7px 6px', fontSize: '0.8rem', fontWeight: 600, border: 'none', borderRadius: '8px', background: '#DC2626', color: '#fff', cursor: 'pointer', opacity: (isApproving || bulkBusy) ? 0.6 : 1 }}
                                            >
                                                ✕ Reject
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Claim Details Modal */}
                        {selectedVoucher && (
                            <div className="app-modal-backdrop">
                                <div className="app-modal app-modal-lg" style={{ position: 'relative' }}>
                                    {/* Header */}
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', paddingBottom: '1rem', borderBottom: '1px solid #EEF2F7', marginBottom: '1.25rem' }}>
                                        <div>
                                            <div style={{ fontSize: '0.72rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 700 }}>Claim Details</div>
                                            <h2 style={{ margin: '3px 0 0', color: 'var(--text-strong)', fontSize: '1.5rem', lineHeight: 1.1 }}>
                                                {selectedVoucher.jcc_number || `JCC${String(selectedVoucher.id).padStart(4, '0')}`}
                                            </h2>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                            <span style={{ padding: '5px 12px', borderRadius: '999px', fontSize: '0.72rem', fontWeight: 700, background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D', whiteSpace: 'nowrap' }}>
                                                {selectedVoucher.status === 'pending_approval_1' ? 'Pending Manager Approval' : selectedVoucher.status === 'pending_approval_2' ? 'Pending Final Approval' : selectedVoucher.status === 'info_requested' ? 'Info Requested' : selectedVoucher.status}
                                            </span>
                                            <button
                                                onClick={closeVoucherModal}
                                                title="Close"
                                                style={{ background: 'var(--surface-3)', color: 'var(--text-body)', border: 'none', borderRadius: '50%', width: '34px', height: '34px', cursor: 'pointer', fontSize: '15px', fontWeight: 700, flexShrink: 0 }}
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem', marginBottom: '1.5rem' }}>
                                        {/* Left Column - Details */}
                                        <div>
                                            <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.75rem', color: 'var(--text-strong)' }}>Claim Information</h3>

                                            <div style={{ background: 'var(--surface-2)', border: '1px solid #EEF2F7', borderRadius: '12px', padding: '2px 14px' }}>
                                                {[
                                                    { label: 'Supplier', value: selectedVoucher.supplier || '—' },
                                                    { label: 'Invoice No.', value: selectedVoucher.invoice_number || '—' },
                                                    { label: 'Amount', value: `₹${parseFloat(selectedVoucher.basic_amount || 0).toLocaleString()}`, highlight: true },
                                                    { label: 'PO No.', value: selectedVoucher.po_number || 'N/A' },
                                                    { label: 'Requested By', value: selectedVoucher.user_name || '—' },
                                                    { label: 'Date', value: new Date(selectedVoucher.created_at).toLocaleDateString() },
                                                    ...(selectedVoucher.description ? [{ label: 'Description', value: selectedVoucher.description }] : []),
                                                ].map((row, i, arr) => (
                                                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', padding: '11px 0', borderBottom: i < arr.length - 1 ? '1px solid #EEF2F7' : 'none' }}>
                                                        <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem', flexShrink: 0 }}>{row.label}</span>
                                                        <span style={{ color: row.highlight ? '#0066CC' : '#1E293B', fontWeight: row.highlight ? 800 : 600, fontSize: row.highlight ? '1.15rem' : '0.9rem', textAlign: 'right' }}>{row.value}</span>
                                                    </div>
                                                ))}
                                            </div>

                                            {Number(selectedVoucher.outdoor_duty) === 1 && (
                                                <div style={{ marginTop: '0.85rem', padding: '12px 14px', background: '#FFFBEB', borderRadius: '10px', border: '1px solid #FCD34D' }}>
                                                    <div style={{ color: '#92400E', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.35rem' }}>⚠ Backdated – Outdoor / Field Duty</div>
                                                    <div style={{ color: 'var(--text-body)', fontSize: '0.82rem', marginBottom: '0.2rem' }}>
                                                        Duty period: <strong>{selectedVoucher.outdoor_from ? new Date(selectedVoucher.outdoor_from).toLocaleDateString() : '-'} → {selectedVoucher.outdoor_to ? new Date(selectedVoucher.outdoor_to).toLocaleDateString() : '-'}</strong>
                                                    </div>
                                                    {selectedVoucher.outdoor_remark && (
                                                        <div style={{ color: 'var(--text-body)', fontSize: '0.82rem' }}><span style={{ color: '#92400E' }}>Reason: </span>{selectedVoucher.outdoor_remark}</div>
                                                    )}
                                                </div>
                                            )}
                                        </div>

                                        {/* Right Column - PDF Preview */}
                                        <div>
                                            <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.75rem', color: 'var(--text-strong)' }}>Attached Document</h3>

                                            {selectedVoucher.attachment_path ? (
                                                <div style={{
                                                    border: '1px solid var(--border)',
                                                    borderRadius: '12px',
                                                    overflow: 'hidden',
                                                    background: 'var(--surface-2)'
                                                }}>
                                                    {/* Check if file is an image or PDF */}
                                                    {selectedVoucher.attachment_path.match(/\.(jpg|jpeg|png)$/i) ? (
                                                        // Display image
                                                        <img
                                                            src={pdfUrl || ''}
                                                            alt="Voucher Attachment"
                                                            style={{
                                                                width: '100%',
                                                                maxHeight: '400px',
                                                                objectFit: 'contain',
                                                                background: 'var(--surface)'
                                                            }}
                                                        />
                                                    ) : (
                                                        // Display PDF
                                                        <embed
                                                            src={pdfUrl || ''}
                                                            type="application/pdf"
                                                            style={{
                                                                width: '100%',
                                                                height: '400px',
                                                                border: 'none'
                                                            }}
                                                        />
                                                    )}
                                                    <div style={{ padding: '0.6rem 0.75rem', background: 'var(--surface)', borderTop: '1px solid #EEF2F7', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                                                        <button
                                                            type="button"
                                                            onClick={() => setPdfFullScreen(true)}
                                                            disabled={!pdfUrl}
                                                            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: '#0066CC', color: '#fff', border: 'none', borderRadius: '8px', padding: '7px 14px', fontSize: '0.85rem', fontWeight: 600, cursor: pdfUrl ? 'pointer' : 'not-allowed' }}
                                                        >
                                                            ⛶ Full screen
                                                        </button>
                                                        <a
                                                            href={pdfUrl || '#'}
                                                            download
                                                            style={{
                                                                color: '#0066CC',
                                                                textDecoration: 'none',
                                                                fontWeight: '600',
                                                                fontSize: '0.85rem'
                                                            }}
                                                        >
                                                            ⬇ Download
                                                        </a>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div style={{
                                                    padding: '2.5rem 1rem',
                                                    textAlign: 'center',
                                                    border: '1px dashed var(--border-strong)',
                                                    borderRadius: '12px',
                                                    color: 'var(--text-faint)',
                                                    background: 'var(--surface-2)'
                                                }}>
                                                    📎 No attachment available
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Remark Section */}
                                    <div style={{ marginBottom: '1.25rem' }}>
                                        <label style={{ display: 'block', fontWeight: '600', marginBottom: '0.5rem', color: 'var(--text-strong)', fontSize: '0.9rem' }}>
                                            Remark / Comments <span style={{ color: '#DC2626' }}>*</span>
                                        </label>
                                        <textarea
                                            value={voucherRemark}
                                            onChange={(e) => setVoucherRemark(e.target.value)}
                                            placeholder="Enter your remark or comments for approval / rejection…"
                                            style={{
                                                width: '100%',
                                                minHeight: '92px',
                                                padding: '0.75rem',
                                                border: '1px solid var(--border)',
                                                borderRadius: '10px',
                                                fontSize: '0.95rem',
                                                fontFamily: 'inherit',
                                                resize: 'vertical',
                                                background: '#FCFDFE'
                                            }}
                                        />
                                    </div>

                                    {/* Action Buttons */}
                                    <div className="app-modal-actions" style={{ borderTop: '1px solid #EEF2F7', paddingTop: '1rem' }}>
                                        <button
                                            onClick={closeVoucherModal}
                                            className="btn btn-outline"
                                            disabled={isApproving}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => handleRequestInfo(selectedVoucher.id)}
                                            className="btn"
                                            disabled={isApproving}
                                            style={{ background: '#D97706', color: 'white', opacity: isApproving ? 0.6 : 1, cursor: isApproving ? 'not-allowed' : 'pointer' }}
                                            title="Send back with a question — without rejecting"
                                        >
                                            ℹ Request Info
                                        </button>
                                        <button
                                            onClick={() => handleRejectVoucher(selectedVoucher.id)}
                                            className="btn btn-danger"
                                            disabled={isApproving}
                                            style={{ opacity: isApproving ? 0.6 : 1, cursor: isApproving ? 'not-allowed' : 'pointer' }}
                                        >
                                            {isApproving ? '⏳ Processing...' : '✗ Reject Claim'}
                                        </button>
                                        <button
                                            onClick={() => handleApproveVoucher(selectedVoucher.id)}
                                            className="btn btn-success"
                                            disabled={isApproving}
                                            style={{ opacity: isApproving ? 0.6 : 1, cursor: isApproving ? 'not-allowed' : 'pointer' }}
                                        >
                                            {isApproving ? '⏳ Processing...' : '✓ Approve Claim'}
                                        </button>
                                    </div>

                                </div>
                            </div>
                        )}

                        {/* Request Info modal */}
                        {infoModal && (
                            <div className="app-modal-backdrop" style={{ zIndex: 2500 }}>
                                <div style={{ background: 'var(--surface)', borderRadius: '16px', width: '100%', maxWidth: '460px', padding: '1.5rem', boxShadow: '0 24px 60px rgba(15,23,42,0.28)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '0.5rem' }}>
                                        <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: '#FFF7ED', color: '#D97706', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}>ℹ</div>
                                        <div>
                                            <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.1rem' }}>Request more info</h3>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>{infoModal.jccId}</div>
                                        </div>
                                    </div>
                                    <p style={{ margin: '0 0 0.75rem', color: 'var(--text-body)', fontSize: '0.88rem', lineHeight: 1.5 }}>
                                        Ask the claimant for what you need. This sends the claim back to them <strong>without rejecting</strong> — it returns to you once they respond.
                                    </p>
                                    <textarea
                                        value={infoNote}
                                        onChange={(e) => setInfoNote(e.target.value)}
                                        autoFocus
                                        placeholder="e.g. Please attach the GST invoice / confirm the PO number…"
                                        style={{ width: '100%', minHeight: '96px', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: '10px', fontSize: '0.92rem', fontFamily: 'inherit', resize: 'vertical', background: '#FCFDFE' }}
                                    />
                                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '1rem' }}>
                                        <button
                                            onClick={() => setInfoModal(null)}
                                            disabled={isApproving}
                                            style={{ padding: '8px 16px', borderRadius: '9px', border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-body)', fontWeight: 600, fontSize: '0.88rem', cursor: 'pointer' }}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={submitInfoRequest}
                                            disabled={isApproving || !infoNote.trim()}
                                            style={{ padding: '8px 18px', borderRadius: '9px', border: 'none', background: (isApproving || !infoNote.trim()) ? '#FCD9A8' : '#D97706', color: '#fff', fontWeight: 700, fontSize: '0.88rem', cursor: (isApproving || !infoNote.trim()) ? 'not-allowed' : 'pointer' }}
                                        >
                                            {isApproving ? 'Sending…' : 'Send to claimant'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Reject modal */}
                        {rejectModal && (
                            <div className="app-modal-backdrop" style={{ zIndex: 2500 }}>
                                <div style={{ background: 'var(--surface)', borderRadius: '16px', width: '100%', maxWidth: '460px', padding: '1.5rem', boxShadow: '0 24px 60px rgba(15,23,42,0.28)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '0.5rem' }}>
                                        <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: '#FEF2F2', color: '#DC2626', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}>✕</div>
                                        <div>
                                            <h3 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.1rem' }}>Reject claim</h3>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>{rejectModal.label}</div>
                                        </div>
                                    </div>
                                    <p style={{ margin: '0 0 0.75rem', color: 'var(--text-body)', fontSize: '0.88rem', lineHeight: 1.5 }}>
                                        Please give a reason for rejecting. The claimant will see this and can correct &amp; resubmit.
                                    </p>
                                    <textarea
                                        value={rejectNote}
                                        onChange={(e) => setRejectNote(e.target.value)}
                                        autoFocus
                                        placeholder="e.g. Amount doesn't match the invoice / wrong PO selected…"
                                        style={{ width: '100%', minHeight: '96px', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: '10px', fontSize: '0.92rem', fontFamily: 'inherit', resize: 'vertical', background: '#FCFDFE' }}
                                    />
                                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '1rem' }}>
                                        <button
                                            onClick={() => setRejectModal(null)}
                                            disabled={isApproving || bulkBusy}
                                            style={{ padding: '8px 16px', borderRadius: '9px', border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-body)', fontWeight: 600, fontSize: '0.88rem', cursor: 'pointer' }}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={submitReject}
                                            disabled={isApproving || bulkBusy || !rejectNote.trim()}
                                            style={{ padding: '8px 18px', borderRadius: '9px', border: 'none', background: (isApproving || bulkBusy || !rejectNote.trim()) ? '#FCA5A5' : '#DC2626', color: '#fff', fontWeight: 700, fontSize: '0.88rem', cursor: (isApproving || bulkBusy || !rejectNote.trim()) ? 'not-allowed' : 'pointer' }}
                                        >
                                            {(isApproving || bulkBusy) ? 'Rejecting…' : 'Reject claim'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Full-screen document viewer */}
                        {pdfFullScreen && pdfUrl && (
                            <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(15,23,42,0.92)', display: 'flex', flexDirection: 'column' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', color: '#fff', gap: '10px' }}>
                                    <span style={{ fontWeight: 600, fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {selectedVoucher ? (selectedVoucher.jcc_number || `JCC${String(selectedVoucher.id).padStart(4, '0')}`) : 'Document'} — Attachment
                                    </span>
                                    <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
                                        <a href={pdfUrl} download style={{ color: '#fff', textDecoration: 'none', fontSize: '0.85rem', border: '1px solid rgba(255,255,255,0.4)', borderRadius: '8px', padding: '6px 12px' }}>⬇ Download</a>
                                        <button onClick={() => setPdfFullScreen(false)} style={{ background: 'var(--surface)', color: 'var(--text-strong)', border: 'none', borderRadius: '8px', padding: '6px 14px', fontWeight: 600, cursor: 'pointer' }}>✕ Close</button>
                                    </div>
                                </div>
                                <div style={{ flex: 1, minHeight: 0, padding: '0 12px 12px' }}>
                                    {selectedVoucher && selectedVoucher.attachment_path && selectedVoucher.attachment_path.match(/\.(jpg|jpeg|png)$/i) ? (
                                        <img src={pdfUrl} alt="Attachment" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                                    ) : (
                                        <iframe title="Attachment full screen" src={pdfUrl} style={{ width: '100%', height: '100%', border: 'none', borderRadius: '8px', background: 'var(--surface)' }} />
                                    )}
                                </div>
                            </div>
                        )}
                    </>
                )}


                {/* Pending Invoices Section */}
                <h2 style={{ color: '#0066CC', marginBottom: '1rem', fontSize: '1.5rem' }}>
                    Pending Invoices ({invoices.length})
                </h2>

                {invoices.length === 0 && vouchers.length === 0 ? (
                    <div className="glass-card text-center" style={{ padding: 'var(--spacing-2xl)' }}>
                        <svg style={{ width: '64px', height: '64px', margin: '0 auto var(--spacing-md)', color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <h3>No Pending Items</h3>
                        <p className="text-muted">All invoices and claims have been processed</p>
                    </div>
                ) : (
                    <div className="card-grid">
                        {invoices.map((invoice) => (
                            <div key={invoice.id} className="glass-card">
                                <div className="flex justify-between items-center mb-md">
                                    <h3 style={{ margin: 0 }}>{invoice.vendor_name || 'Unknown Vendor'}</h3>
                                    <span className="badge badge-warning">Pending</span>
                                </div>

                                <div style={{ marginBottom: 'var(--spacing-md)' }}>
                                    {invoice.file_path && (
                                        <img
                                            src={`/api/invoices/file/${invoice.id}`}
                                            alt="Invoice"
                                            style={{
                                                width: '100%',
                                                maxHeight: '200px',
                                                objectFit: 'contain',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'rgba(255, 255, 255, 0.05)',
                                                marginBottom: 'var(--spacing-md)'
                                            }}
                                        />
                                    )}

                                    <div style={{ display: 'grid', gap: 'var(--spacing-sm)' }}>
                                        <div className="flex justify-between">
                                            <span className="text-muted">Invoice Number:</span>
                                            <strong>{invoice.invoice_number || 'N/A'}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted">Amount:</span>
                                            <strong>₹{invoice.amount || '0.00'}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted">Date:</span>
                                            <strong>{invoice.invoice_date || 'N/A'}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted">Uploaded:</span>
                                            <strong>{new Date(invoice.created_at).toLocaleDateString()}</strong>
                                        </div>
                                    </div>
                                </div>

                                {selectedInvoice === invoice.id ? (
                                    <div style={{ marginTop: 'var(--spacing-lg)', padding: 'var(--spacing-md)', border: '1px solid var(--primary)', borderRadius: 'var(--radius-md)' }}>
                                        <h4 className="mb-md">Create JCC Entry</h4>

                                        <div className="input-group">
                                            <label className="input-label">Category</label>
                                            <select
                                                className="input-field"
                                                value={jccData.category}
                                                onChange={(e) => setJccData({ ...jccData, category: e.target.value })}
                                            >
                                                <option value="">Select Category</option>
                                                <option value="Materials">Materials</option>
                                                <option value="Services">Services</option>
                                                <option value="Equipment">Equipment</option>
                                                <option value="Other">Other</option>
                                            </select>
                                        </div>

                                        <div className="input-group">
                                            <label className="input-label">Approved Amount (₹)</label>
                                            <input
                                                type="number"
                                                step="0.01"
                                                className="input-field"
                                                value={jccData.approvedAmount}
                                                onChange={(e) => setJccData({ ...jccData, approvedAmount: e.target.value })}
                                                placeholder={invoice.amount || '0.00'}
                                            />
                                        </div>

                                        <div className="input-group">
                                            <label className="input-label">Description</label>
                                            <textarea
                                                className="input-field"
                                                rows="3"
                                                value={jccData.description}
                                                onChange={(e) => setJccData({ ...jccData, description: e.target.value })}
                                                placeholder="Enter description for JCC entry"
                                            />
                                        </div>

                                        <div className="flex gap-sm">
                                            <button
                                                className="btn btn-success"
                                                style={{ flex: 1 }}
                                                onClick={() => handleVerifyInvoice(invoice.id)}
                                            >
                                                ✓ Approve & Create JCC
                                            </button>
                                            <button
                                                className="btn btn-outline"
                                                onClick={() => setSelectedInvoice(null)}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex gap-sm" style={{ marginTop: 'var(--spacing-lg)' }}>
                                        <button
                                            className="btn btn-primary"
                                            style={{ flex: 1 }}
                                            onClick={() => {
                                                setSelectedInvoice(invoice.id);
                                                setJccData({
                                                    description: `Payment for ${invoice.vendor_name}`,
                                                    category: '',
                                                    approvedAmount: invoice.amount || ''
                                                });
                                            }}
                                        >
                                            Verify & Allocate
                                        </button>
                                        <button
                                            className="btn btn-danger"
                                            onClick={() => handleReject(invoice.id)}
                                        >
                                            Reject
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default CoordinatorPage;
