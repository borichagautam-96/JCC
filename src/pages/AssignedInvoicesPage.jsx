import React, { useState, useEffect, useRef } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useLocation, useNavigate } from 'react-router-dom';

const AssignedInvoicesPage = () => {
    const { user, getToken } = useAuth();
    const isAdmin = String(user?.role || '').toLowerCase() === 'admin';
    const navigate = useNavigate();
    const location = useLocation();
    const [assignedInvoices, setAssignedInvoices] = useState([]);
    const [invoiceHistories, setInvoiceHistories] = useState({});
    const [loadingHistoryId, setLoadingHistoryId] = useState(null);
    const [selectedInvoice, setSelectedInvoice] = useState(null);
    const modalContentRef = useRef(null);
    const lastProcessedFocusKeyRef = useRef('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        fetchAssignedInvoices();
    }, []);

    useEffect(() => {
        const queryParams = new URLSearchParams(location.search || '');

        const parsePositiveNumber = (value) => {
            if (value === undefined || value === null || String(value).trim() === '') return null;
            const parsed = Number(value);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        };

        const stateFocusInvoiceId = parsePositiveNumber(location.state?.focusInvoiceId);
        const queryFocusInvoiceId = parsePositiveNumber(queryParams.get('focusInvoiceId'));
        const focusInvoiceId = queryFocusInvoiceId || stateFocusInvoiceId;

        const focusPoNumber = String(
            queryParams.get('focusPoNumber') || location.state?.focusPoNumber || ''
        ).trim();
        const focusInvoiceNumber = String(
            queryParams.get('focusInvoiceNumber') || location.state?.focusInvoiceNumber || ''
        ).trim();
        const focusInvoiceSnapshot = location.state?.focusInvoice || null;

        const shouldOpenHistory = queryParams.get('openHistory') === '1' || Boolean(location.state?.openHistory);

        const hasFocusTarget = Boolean(focusInvoiceId) || Boolean(focusPoNumber) || Boolean(focusInvoiceNumber) || Boolean(focusInvoiceSnapshot);
        if (!hasFocusTarget) {
            return;
        }

        const focusKey = `${location.key}|${focusInvoiceId || ''}|${focusPoNumber}|${focusInvoiceNumber}|${focusInvoiceSnapshot?.id || ''}|${shouldOpenHistory ? 'history' : 'details'}`;
        if (lastProcessedFocusKeyRef.current === focusKey) {
            return;
        }

        const targetInvoice = (Array.isArray(assignedInvoices) && assignedInvoices.length > 0
            ? assignedInvoices.find((invoice) => Number(invoice.id) === focusInvoiceId)
                || assignedInvoices.find((invoice) => String(invoice.po_number || '').trim() === focusPoNumber)
                || assignedInvoices.find((invoice) => String(invoice.invoice_number || '').trim() === focusInvoiceNumber)
            : null)
            || focusInvoiceSnapshot;
        if (!targetInvoice) {
            return;
        }

        // Let page transition finish first, then open deep-linked details.
        const timerId = globalThis.setTimeout(() => {
            setSelectedInvoice(targetInvoice);
            if (shouldOpenHistory && !invoiceHistories[targetInvoice.id]) {
                loadInvoiceHistory(targetInvoice.id);
            }
            lastProcessedFocusKeyRef.current = focusKey;
        }, 260);
        return () => globalThis.clearTimeout(timerId);
    }, [assignedInvoices, location.key, location.search, location.state]);

    const fetchAssignedInvoices = async () => {
        try {
            setError('');
            const response = await fetch('/api/invoices/assigned', {
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });
            if (response.ok) {
                const data = await response.json();
                setAssignedInvoices(data);
            } else {
                let message = 'Failed to load assigned invoices';
                try {
                    const errorData = await response.json();
                    message = errorData?.error || message;
                } catch {
                    // Keep fallback message when backend response is not JSON.
                }
                setAssignedInvoices([]);
                setError(message);
            }
        } catch (error) {
            console.error('Error fetching assigned invoices', error);
            setAssignedInvoices([]);
            setError('Failed to load assigned invoices');
        } finally {
            setLoading(false);
        }
    };

    const handleCreateVoucher = (invoice) => {
        navigate('/create-voucher', { state: { invoiceData: invoice } });
    };

    const formatDateTime = (value) => {
        if (!value) return '-';
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return '-';
        return parsed.toLocaleString();
    };

    const isAssignedToCurrentUser = (invoice) => {
        if (!user) return false;
        return invoice.assigned_to_user_id === user.id
            || (!!user.ps_number && invoice.assigned_to === user.ps_number)
            || (!!user.name && invoice.assigned_to === user.name);
    };

    const handleAcceptInvoice = async (invoiceId) => {
        try {
            const response = await fetch(`/api/invoices/${invoiceId}/accept`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to accept invoice');
            }

            await fetchAssignedInvoices();
        } catch (acceptError) {
            console.error('Error accepting invoice:', acceptError);
            setError(acceptError.message || 'Failed to accept invoice');
        }
    };

    const loadInvoiceHistory = async (invoiceId) => {
        setLoadingHistoryId(invoiceId);
        try {
            const response = await fetch(`/api/invoices/${invoiceId}/history`, {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to load history');
            }

            const historyData = await response.json();
            setInvoiceHistories((prev) => ({ ...prev, [invoiceId]: historyData }));
        } catch (historyError) {
            console.error('Error loading invoice history:', historyError);
            setError(historyError.message || 'Failed to load invoice history');
        } finally {
            setLoadingHistoryId(null);
        }
    };

    const handleToggleHistory = async (invoiceId) => {
        if (invoiceHistories[invoiceId]) {
            setInvoiceHistories((prev) => {
                const next = { ...prev };
                delete next[invoiceId];
                return next;
            });
            return;
        }

        await loadInvoiceHistory(invoiceId);
    };

    const openDetails = (invoice) => {
        setSelectedInvoice(invoice);
    };

    const closeDetails = () => {
        setSelectedInvoice(null);
    };

    useEffect(() => {
        if (!selectedInvoice) return undefined;

        const handleEscKey = (event) => {
            if (event.key === 'Escape') {
                closeDetails();
            }
        };

        const handleOutsideClick = (event) => {
            const modalElement = modalContentRef.current;
            if (!modalElement) return;
            if (!modalElement.contains(event.target)) {
                closeDetails();
            }
        };

        globalThis.addEventListener('keydown', handleEscKey);
        globalThis.addEventListener('mousedown', handleOutsideClick);
        return () => {
            globalThis.removeEventListener('keydown', handleEscKey);
            globalThis.removeEventListener('mousedown', handleOutsideClick);
        };
    }, [selectedInvoice]);

    let content;
    if (loading) {
        content = (
            <div className="text-center py-xl">
                <div className="spinner"></div>
                <p className="mt-md text-muted">Loading invoices...</p>
            </div>
        );
    } else if (error) {
        content = (
            <div className="p-lg bg-red-50 text-red-600 rounded-md border border-red-100">
                {error}
            </div>
        );
    } else {
        content = (
            <div className="glass-card overflow-hidden">
                <div className="table-container">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>PO Number</th>
                                <th>Amount</th>
                                <th>Time Assigned</th>
                                <th>Assigned By</th>
                                {isAdmin && <th>Assigned To</th>}
                                <th>Accepted Status</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {assignedInvoices.length === 0 ? (
                                <tr>
                                    <td colSpan={isAdmin ? 7 : 6} className="text-center" style={{ color: '#64748B', padding: '1.5rem' }}>
                                        No assigned invoices found.
                                    </td>
                                </tr>
                            ) : assignedInvoices.map((invoice) => {
                                const canAccept = isAssignedToCurrentUser(invoice) && !invoice.accepted_at;
                                const canCreateVoucher = isAssignedToCurrentUser(invoice) && invoice.status !== 'voucher_created';
                                const acceptedStatus = invoice.accepted_at ? 'Accepted' : 'Pending';

                                return (
                                    <React.Fragment key={invoice.id}>
                                        <tr>
                                            <td>{invoice.po_number || '-'}</td>
                                            <td>₹{Number.parseFloat(invoice.amount || 0).toLocaleString()}</td>
                                            <td>{formatDateTime(invoice.assigned_at || invoice.created_at)}</td>
                                            <td>{invoice.assigned_by_name || invoice.uploader_name || '-'}</td>
                                            {isAdmin && <td>{invoice.assigned_to_name || invoice.assigned_to || '-'}</td>}
                                            <td>
                                                <span className={`status-badge ${invoice.accepted_at ? 'status-approved' : 'status-pending'}`}>
                                                    {acceptedStatus}
                                                </span>
                                            </td>
                                            <td style={{ minWidth: '250px' }}>
                                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                                    {canAccept && (
                                                        <button
                                                            onClick={() => handleAcceptInvoice(invoice.id)}
                                                            className="btn btn-sm"
                                                            style={{ background: '#059669', color: 'white' }}
                                                        >
                                                            Accept
                                                        </button>
                                                    )}
                                                    {canCreateVoucher && (
                                                        <button
                                                            onClick={() => handleCreateVoucher(invoice)}
                                                            className="btn btn-sm btn-primary"
                                                        >
                                                            Create Voucher
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => openDetails(invoice)}
                                                        className="btn btn-sm btn-outline"
                                                    >
                                                        Show More Details
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        );
    }

    let modalHistoryLabel = 'View History';
    if (selectedInvoice && loadingHistoryId === selectedInvoice.id) {
        modalHistoryLabel = 'Loading...';
    } else if (selectedInvoice && invoiceHistories[selectedInvoice.id]) {
        modalHistoryLabel = 'Hide History';
    }

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header">
                    <div>
                        <h1 className="page-title">Assigned Invoices</h1>
                        <p className="page-subtitle">
                            {isAdmin
                                ? 'Track all assigned invoices and assignees'
                                : 'Track invoices assigned to you and who assigned them'}
                        </p>
                    </div>
                </div>

                {content}

                {selectedInvoice && (
                    <dialog
                        open
                        onCancel={(event) => {
                            event.preventDefault();
                            closeDetails();
                        }}
                        style={{
                            position: 'fixed',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            maxWidth: '100%',
                            maxHeight: '100%',
                            margin: 0,
                            border: 'none',
                            background: 'rgba(15, 23, 42, 0.55)',
                            padding: '1rem',
                            zIndex: 1000,
                        }}
                    >
                        <div
                            ref={modalContentRef}
                            style={{
                                width: 'min(920px, 96vw)',
                                maxHeight: '88vh',
                                overflow: 'auto',
                                background: '#ffffff',
                                borderRadius: '14px',
                                border: '1px solid #E2E8F0',
                                boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
                                padding: '1rem',
                                margin: '0 auto',
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                                <h3 style={{ margin: 0, color: '#0f172a' }}>Invoice Details</h3>
                                <button className="btn btn-sm btn-outline" onClick={closeDetails}>Close</button>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                                <div><strong>Date:</strong> {selectedInvoice.invoice_date ? new Date(selectedInvoice.invoice_date).toLocaleDateString() : '-'}</div>
                                <div><strong>Vendor:</strong> {selectedInvoice.vendor_name || '-'}</div>
                                <div><strong>Invoice No:</strong> {selectedInvoice.invoice_number || '-'}</div>
                                <div><strong>PO Number:</strong> {selectedInvoice.po_number || '-'}</div>
                                <div><strong>Amount:</strong> ₹{Number.parseFloat(selectedInvoice.amount || 0).toLocaleString()}</div>
                                <div><strong>Assigned By:</strong> {selectedInvoice.assigned_by_name || selectedInvoice.uploader_name || '-'}</div>
                                <div><strong>Assigned To:</strong> {selectedInvoice.assigned_to_name || selectedInvoice.assigned_to || '-'}</div>
                                <div><strong>Assigned At:</strong> {formatDateTime(selectedInvoice.assigned_at || selectedInvoice.created_at)}</div>
                                <div><strong>Accepted At:</strong> {formatDateTime(selectedInvoice.accepted_at)}</div>
                                <div><strong>Submitted At:</strong> {formatDateTime(selectedInvoice.voucher_submitted_at)}</div>
                                <div><strong>Completed At:</strong> {formatDateTime(selectedInvoice.completed_at)}</div>
                                <div><strong>Status:</strong> {String(selectedInvoice.status || '').replace('_', ' ') || '-'}</div>
                            </div>

                            <div style={{ marginBottom: '0.75rem' }}>
                                <button
                                    onClick={() => handleToggleHistory(selectedInvoice.id)}
                                    className="btn btn-sm"
                                    style={{ background: '#334155', color: 'white' }}
                                    disabled={loadingHistoryId === selectedInvoice.id}
                                >
                                    {modalHistoryLabel}
                                </button>
                            </div>

                            {invoiceHistories[selectedInvoice.id] && (
                                <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '10px', padding: '0.85rem' }}>
                                    <div style={{ marginBottom: '0.65rem', fontWeight: 600, color: '#1E293B' }}>
                                        Assignment Lifecycle
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                                        <div><strong>Assigned By:</strong> {invoiceHistories[selectedInvoice.id].lifecycle.assignedBy || '-'}</div>
                                        <div><strong>Assigned To:</strong> {invoiceHistories[selectedInvoice.id].lifecycle.assignedTo || '-'}</div>
                                        <div><strong>Assigned At:</strong> {formatDateTime(invoiceHistories[selectedInvoice.id].lifecycle.assignedAt)}</div>
                                        <div><strong>Accepted By:</strong> {invoiceHistories[selectedInvoice.id].lifecycle.acceptedBy || '-'}</div>
                                        <div><strong>Accepted At:</strong> {formatDateTime(invoiceHistories[selectedInvoice.id].lifecycle.acceptedAt)}</div>
                                        <div><strong>Submitted At:</strong> {formatDateTime(invoiceHistories[selectedInvoice.id].lifecycle.voucherSubmittedAt)}</div>
                                        <div><strong>Completed At:</strong> {formatDateTime(invoiceHistories[selectedInvoice.id].lifecycle.completedAt)}</div>
                                    </div>

                                    {invoiceHistories[selectedInvoice.id].history.length === 0 ? (
                                        <div className="text-muted">No history events available.</div>
                                    ) : (
                                        <div style={{ borderTop: '1px solid #E2E8F0', paddingTop: '0.75rem' }}>
                                            {invoiceHistories[selectedInvoice.id].history.map((event) => (
                                                <div key={event.id} style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.5rem' }}>
                                                    <span style={{ minWidth: '185px', color: '#64748B' }}>{formatDateTime(event.action_at)}</span>
                                                    <span style={{ fontWeight: 600, color: '#1E293B', textTransform: 'capitalize' }}>{event.action_type.replace('_', ' ')}</span>
                                                    <span style={{ color: '#334155' }}>
                                                        by {event.action_by_name || '-'}
                                                        {event.assigned_to_name ? ` | assigned to ${event.assigned_to_name}` : ''}
                                                        {event.notes ? ` | ${event.notes}` : ''}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </dialog>
                )}
            </div>
        </div>
    );
};

export default AssignedInvoicesPage;
