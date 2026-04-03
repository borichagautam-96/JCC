import React, { useState, useEffect, useRef } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

const DashboardPage = () => {
    const DEFAULT_ASSIGNED_INVOICES_LIMIT = 5;
    const [dashboardData, setDashboardData] = useState({
        totalDues: 0,
        pendingInvoices: 0,
        approvedInvoices: 0,
        vendorDues: [],
        recentActivity: [],
    });
    const [poBudget, setPoBudget] = useState([]);
    const [assignedInvoices, setAssignedInvoices] = useState([]); // New state
    const [showAllAssignedInvoices, setShowAllAssignedInvoices] = useState(false);
    const [selectedTrackedInvoice, setSelectedTrackedInvoice] = useState(null);
    const [invoiceHistories, setInvoiceHistories] = useState({});
    const [loadingHistoryId, setLoadingHistoryId] = useState(null);
    const modalContentRef = useRef(null);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all');
    const { getToken, user } = useAuth(); // Get user for role check
    const isAdmin = String(user?.role || '').toLowerCase() === 'admin';
    const navigate = useNavigate(); // For navigation
    const canViewAssignedInvoices = user?.role !== 'manager' && user?.role !== 'final_approver';

    const logActivity = async (payload) => {
        try {
            const token = getToken();
            if (!token) return;
            await fetch('/api/users/activity', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify(payload),
            });
        } catch (error) {
            console.warn('Dashboard activity log failed:', error);
        }
    };

    useEffect(() => {
        fetchDashboardData();
        fetchPOBudget();
        if (canViewAssignedInvoices) {
            fetchAssignedInvoices(); // Fetch assigned invoices
        } else {
            setAssignedInvoices([]);
        }
        const interval = setInterval(() => {
            fetchDashboardData();
            fetchPOBudget();
            if (canViewAssignedInvoices) {
                fetchAssignedInvoices();
            }
        }, 30000);
        return () => clearInterval(interval);
    }, [canViewAssignedInvoices]);

    // ... (fetchDashboardData and fetchPOBudget remain same)

    const fetchAssignedInvoices = async () => {
        try {
            const response = await fetch('/api/invoices/assigned', {
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });
            if (response.ok) {
                const data = await response.json();
                setAssignedInvoices(Array.isArray(data) ? data : []);
            } else {
                setAssignedInvoices([]);
            }
        } catch (error) {
            console.error('Error fetching assigned invoices:', error);
            setAssignedInvoices([]);
        }
    };

    const fetchDashboardData = async () => {
        try {
            const response = await fetch('/api/dashboard/summary', {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });
            if (!response.ok) {
                setDashboardData({
                    totalDues: 0,
                    pendingInvoices: 0,
                    approvedInvoices: 0,
                    vendorDues: [],
                    recentActivity: [],
                });
                return;
            }

            const data = await response.json();
            setDashboardData({
                totalDues: Number(data?.totalDues || 0),
                pendingInvoices: Number(data?.pendingInvoices || 0),
                approvedInvoices: Number(data?.approvedInvoices || 0),
                vendorDues: Array.isArray(data?.vendorDues) ? data.vendorDues : [],
                recentActivity: Array.isArray(data?.recentActivity) ? data.recentActivity : [],
            });
        } catch (error) {
            console.error('Error fetching dashboard data:', error);
            setDashboardData({
                totalDues: 0,
                pendingInvoices: 0,
                approvedInvoices: 0,
                vendorDues: [],
                recentActivity: [],
            });
        } finally {
            setLoading(false);
        }
    };

    const fetchPOBudget = async () => {
        try {
            const response = await fetch('/api/dashboard/po-budget', {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });
            if (!response.ok) {
                setPoBudget([]);
                return;
            }
            const data = await response.json();
            setPoBudget(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error('Error fetching PO budget:', error);
            setPoBudget([]);
        }
    };

    const isAssignedToCurrentUser = (invoice) => {
        if (!user) return false;
        return invoice.assigned_to_user_id === user.id
            || (!!user.ps_number && invoice.assigned_to === user.ps_number)
            || (!!user.name && invoice.assigned_to === user.name);
    };

    const actionGroupStyle = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.5rem',
        flexWrap: 'wrap'
    };

    const trackButtonStyle = {
        background: '#1E3A5F',
        color: 'white',
        border: '1px solid #2C4B73',
        borderRadius: '8px',
        padding: '0.45rem 0.85rem',
        fontSize: '0.82rem',
        fontWeight: 600,
        lineHeight: 1.2,
        cursor: 'pointer',
        whiteSpace: 'nowrap'
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
        } finally {
            setLoadingHistoryId(null);
        }
    };

    const handleTrackAssignment = (invoice) => {
        setSelectedTrackedInvoice(invoice);
        loadInvoiceHistory(invoice.id);
        logActivity({
            eventName: 'dashboard.track_assignment.open',
            module: 'dashboard',
            screen: '/dashboard',
            entityType: 'invoice',
            entityId: invoice.id,
            metadata: { poNumber: invoice.po_number, invoiceNumber: invoice.invoice_number },
        });
    };

    const closeTrackModal = () => {
        setSelectedTrackedInvoice(null);
    };

    const currentTrackedIndex = selectedTrackedInvoice
        ? assignedInvoices.findIndex((invoice) => Number(invoice.id) === Number(selectedTrackedInvoice.id))
        : -1;

    const hasPrevTrackedInvoice = currentTrackedIndex > 0;
    const hasNextTrackedInvoice = currentTrackedIndex >= 0 && currentTrackedIndex < assignedInvoices.length - 1;

    const openTrackedInvoiceAt = (index) => {
        if (index < 0 || index >= assignedInvoices.length) return;
        const invoice = assignedInvoices[index];
        if (!invoice) return;
        setSelectedTrackedInvoice(invoice);
        loadInvoiceHistory(invoice.id);
    };

    const handleOpenPrevTrackedInvoice = () => {
        if (!hasPrevTrackedInvoice) return;
        openTrackedInvoiceAt(currentTrackedIndex - 1);
        logActivity({
            eventName: 'dashboard.track_assignment.prev',
            module: 'dashboard',
            screen: '/dashboard',
            entityType: 'invoice',
            entityId: assignedInvoices[currentTrackedIndex - 1]?.id,
        });
    };

    const handleOpenNextTrackedInvoice = () => {
        if (!hasNextTrackedInvoice) return;
        openTrackedInvoiceAt(currentTrackedIndex + 1);
        logActivity({
            eventName: 'dashboard.track_assignment.next',
            module: 'dashboard',
            screen: '/dashboard',
            entityType: 'invoice',
            entityId: assignedInvoices[currentTrackedIndex + 1]?.id,
        });
    };

    const copyTextToClipboard = async (value, label) => {
        const text = String(value || '').trim();
        if (!text) return;
        try {
            await globalThis.navigator.clipboard.writeText(text);
            logActivity({
                eventName: 'dashboard.copy',
                module: 'dashboard',
                screen: '/dashboard',
                entityType: 'invoice',
                entityId: selectedTrackedInvoice?.id,
                metadata: { label },
            });
        } catch (error) {
            console.warn(`Failed to copy ${label}:`, error);
        }
    };

    const shareTextValue = async (value, label) => {
        const text = String(value || '').trim();
        if (!text) return;
        try {
            if (globalThis.navigator.share) {
                await globalThis.navigator.share({ title: label, text: `${label}: ${text}` });
                logActivity({
                    eventName: 'dashboard.share',
                    module: 'dashboard',
                    screen: '/dashboard',
                    entityType: 'invoice',
                    entityId: selectedTrackedInvoice?.id,
                    metadata: { label },
                });
            } else {
                await copyTextToClipboard(text, label);
            }
        } catch (error) {
            console.warn(`Share canceled/failed for ${label}:`, error);
        }
    };

    const formatDateTime = (dateValue) => {
        if (!dateValue) return '-';
        const parsedDate = new Date(dateValue);
        if (Number.isNaN(parsedDate.getTime())) return '-';
        return parsedDate.toLocaleString();
    };

    const safeVendorDues = Array.isArray(dashboardData?.vendorDues) ? dashboardData.vendorDues : [];

    const filteredVendorDues = safeVendorDues.filter((vendor) => {
        if (filter === 'all') return true;
        return vendor.status === filter;
    });

    const hasMoreAssignedInvoices = assignedInvoices.length > DEFAULT_ASSIGNED_INVOICES_LIMIT;
    const displayedAssignedInvoices = showAllAssignedInvoices
        ? assignedInvoices
        : assignedInvoices.slice(0, DEFAULT_ASSIGNED_INVOICES_LIMIT);

    const getApprovalOwner = (vendor) => {
        if (vendor.status === 'approved') {
            return vendor.approver2_name || vendor.approver1_name || '-';
        }

        if (vendor.approver1_status === 'approved' && vendor.approver2_status === 'pending') {
            return `Pending with ${vendor.approver2_name || 'Approver 2'}`;
        }

        return `Pending with ${vendor.approver1_name || 'Approver 1'}`;
    };

    const getApprovalTime = (vendor) => {
        if (vendor.status === 'approved') {
            return formatDateTime(vendor.approver2_date || vendor.approver1_date);
        }

        if (vendor.approver1_status === 'approved') {
            return `L1 approved on ${formatDateTime(vendor.approver1_date)}`;
        }

        return '-';
    };

    useEffect(() => {
        if (!selectedTrackedInvoice) return undefined;

        const handleEscKey = (event) => {
            if (event.key === 'Escape') {
                closeTrackModal();
            }
        };

        const handleOutsideClick = (event) => {
            const modalElement = modalContentRef.current;
            if (!modalElement) return;
            if (!modalElement.contains(event.target)) {
                closeTrackModal();
            }
        };

        globalThis.addEventListener('keydown', handleEscKey);
        globalThis.addEventListener('mousedown', handleOutsideClick);
        return () => {
            globalThis.removeEventListener('keydown', handleEscKey);
            globalThis.removeEventListener('mousedown', handleOutsideClick);
        };
    }, [selectedTrackedInvoice]);

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
                {/* Header */}
                <div className="page-header">
                    <div>
                        <h1 className="page-title">Vendor Dues Dashboard</h1>
                        <p className="page-subtitle">Real-time tracking of all vendor payments</p>
                    </div>

                </div>

                {/* Stats Cards */}
                <div className="card-grid mb-xl" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                    <div className="metric-card">
                        <h3 className="metric-label">Total Dues</h3>
                        <p className="metric-value" style={{ color: '#2563eb' }}>
                            ₹{dashboardData.totalDues.toLocaleString()}
                        </p>
                    </div>

                    <div className="metric-card">
                        <h3 className="metric-label">Pending Invoices</h3>
                        <p className="metric-value" style={{ color: '#d97706' }}>
                            {dashboardData.pendingInvoices}
                        </p>
                    </div>

                    <div className="metric-card">
                        <h3 className="metric-label">Approved Invoices</h3>
                        <p className="metric-value" style={{ color: '#059669' }}>
                            {dashboardData.approvedInvoices}
                        </p>
                    </div>
                </div>

                {/* Assigned Invoices Section */}
                {canViewAssignedInvoices && assignedInvoices.length > 0 && (
                    <div className="glass-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                        <h3 style={{ margin: 0, marginBottom: 'var(--spacing-lg)', color: '#0f172a' }}>
                            {isAdmin ? 'All Assigned Invoices' : 'Invoices Assigned to You'}
                        </h3>

                        <div className="table-container">
                            <table className="table">
                                <thead>
                                    <tr>
                                        <th>Invoice No</th>
                                        <th>PO Number</th>
                                        <th>Vendor</th>
                                        <th>Amount</th>
                                        <th>Date</th>
                                        <th>Assigned By</th>
                                        {isAdmin && <th>Assigned To</th>}
                                        <th style={{ textAlign: 'center', width: '240px' }}>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {displayedAssignedInvoices.map((invoice) => (
                                        <tr key={invoice.id || invoice.invoice_number}>
                                            <td style={{ fontWeight: 600 }}>{invoice.invoice_number}</td>
                                            <td>{invoice.po_number || '-'}</td>
                                            <td>{invoice.vendor_name}</td>
                                            <td>₹{invoice.amount?.toLocaleString()}</td>
                                            <td>{new Date(invoice.invoice_date).toLocaleDateString()}</td>
                                            <td>{invoice.assigned_by_name || invoice.uploader_name || '-'}</td>
                                            {isAdmin && <td>{invoice.assigned_to_name || invoice.assigned_to || '-'}</td>}
                                            <td style={{ width: '240px', minWidth: '240px', verticalAlign: 'middle', textAlign: 'center', paddingRight: '1.25rem' }}>
                                                {isAssignedToCurrentUser(invoice) ? (
                                                    <div style={actionGroupStyle}>
                                                        <button
                                                            className="btn btn-sm btn-primary"
                                                            onClick={() => navigate('/create-voucher', { state: { invoiceData: invoice } })}
                                                        >
                                                            Create Voucher
                                                        </button>
                                                        <button
                                                            style={trackButtonStyle}
                                                            onClick={() => handleTrackAssignment(invoice)}
                                                        >
                                                            Track Assignment
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        style={trackButtonStyle}
                                                        onClick={() => handleTrackAssignment(invoice)}
                                                    >
                                                        Track Assignment
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {hasMoreAssignedInvoices && (
                            <div style={{ marginTop: '0.85rem', display: 'flex', justifyContent: 'center' }}>
                                <button
                                    className="btn btn-sm btn-outline"
                                    onClick={() => setShowAllAssignedInvoices((prev) => !prev)}
                                >
                                    {showAllAssignedInvoices ? 'Show Less' : `Show More (${assignedInvoices.length - DEFAULT_ASSIGNED_INVOICES_LIMIT} more)`}
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* Vendor Dues Table */}
                <div className="glass-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                    <div className="flex justify-between items-center mb-lg">
                        <h3 style={{ margin: 0, color: '#0f172a' }}>Vendor Dues Breakdown</h3>
                        <select
                            className="input-field"
                            style={{ width: 'auto', background: 'white', border: '1px solid #CCC' }}
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        >
                            <option value="all">All Vendors</option>
                            <option value="pending">Pending Only</option>
                            <option value="approved">Approved Only</option>
                        </select>
                    </div>

                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Vendor Name</th>
                                    <th>Total Dues</th>
                                    <th>Status</th>
                                    <th>Approved/Pending With</th>
                                    <th>Approval Time</th>
                                    <th>Last Updated</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredVendorDues.length === 0 ? (
                                    <tr>
                                        <td colSpan="6" className="text-center" style={{ color: '#999', padding: '2rem' }}>No vendor dues found</td>
                                    </tr>
                                ) : (
                                    filteredVendorDues.map((vendor) => (
                                        <tr key={`${vendor.vendor_name}-${vendor.last_updated || 'na'}`}>
                                            <td style={{ fontWeight: 600 }}>{vendor.vendor_name}</td>
                                            <td>₹{vendor.total_dues.toLocaleString()}</td>
                                            <td>
                                                <span className={`status-pill ${vendor.status === 'approved' ? 'status-pill-approved' : 'status-pill-pending'}`}>
                                                    {vendor.status}
                                                </span>
                                            </td>
                                            <td>{getApprovalOwner(vendor)}</td>
                                            <td>{getApprovalTime(vendor)}</td>
                                            <td className="text-muted">{new Date(vendor.last_updated).toLocaleDateString()}</td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* PO Budget Tracking */}
                <div className="glass-card" style={{ background: 'white', border: '1px solid #E0E0E0' }}>
                    <h3 className="mb-lg" style={{ color: '#0f172a', fontSize: '1.25rem', fontWeight: 600 }}>PO Budget Tracking</h3>

                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>PO Number</th>
                                    <th>Total Amount</th>
                                    <th>Amount Used</th>
                                    <th>Remaining Amount</th>
                                    <th style={{ width: '200px' }}>Utilization</th>
                                </tr>
                            </thead>
                            <tbody>
                                {poBudget.length === 0 ? (
                                    <tr>
                                        <td colSpan="5" className="text-center" style={{ color: '#999', padding: '2rem' }}>No PO budget data available</td>
                                    </tr>
                                ) : (
                                    poBudget.map((po) => (
                                        <tr key={po.poNumber || `po-${po.totalAmount}-${po.usedAmount}`}>
                                            <td style={{ fontWeight: 600, color: '#0f172a' }}>{po.poNumber}</td>
                                            <td>₹{po.totalAmount.toLocaleString()}</td>
                                            <td style={{ color: '#666' }}>₹{po.usedAmount.toLocaleString()}</td>
                                            <td style={{
                                                color: po.remainingAmount > 0 ? '#10B981' : '#EF4444',
                                                fontWeight: 600
                                            }}>
                                                ₹{po.remainingAmount.toLocaleString()}
                                            </td>
                                            <td>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                    <div style={{
                                                        flex: 1,
                                                        height: '20px',
                                                        background: '#E0E0E0',
                                                        borderRadius: '10px',
                                                        overflow: 'hidden'
                                                    }}>
                                                        <div style={{
                                                            height: '100%',
                                                            width: `${po.utilizationPercent}%`,
                                                            background: (() => {
                                                                if (po.utilizationPercent > 80) return '#EF4444';
                                                                if (po.utilizationPercent > 50) return '#F59E0B';
                                                                return '#10B981';
                                                            })(),
                                                            transition: 'width 0.3s ease'
                                                        }}></div>
                                                    </div>
                                                    <span style={{
                                                        fontSize: '0.875rem',
                                                        fontWeight: 600,
                                                        minWidth: '45px'
                                                    }}>
                                                        {po.utilizationPercent}%
                                                    </span>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {selectedTrackedInvoice && (
                    <dialog
                        open
                        onCancel={(event) => {
                            event.preventDefault();
                            closeTrackModal();
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
                        <style>{`
                            @keyframes dashboardHistoryShimmer {
                                0% { background-position: -280px 0; }
                                100% { background-position: 280px 0; }
                            }
                        `}</style>
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
                                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                    <button className="btn btn-sm btn-outline" onClick={handleOpenPrevTrackedInvoice} disabled={!hasPrevTrackedInvoice}>Previous</button>
                                    <button className="btn btn-sm btn-outline" onClick={handleOpenNextTrackedInvoice} disabled={!hasNextTrackedInvoice}>Next</button>
                                    <button className="btn btn-sm btn-outline" onClick={closeTrackModal}>Close</button>
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                                <div><strong>Date:</strong> {selectedTrackedInvoice.invoice_date ? new Date(selectedTrackedInvoice.invoice_date).toLocaleDateString() : '-'}</div>
                                <div><strong>Vendor:</strong> {selectedTrackedInvoice.vendor_name || '-'}</div>
                                <div>
                                    <strong>Invoice No:</strong> {selectedTrackedInvoice.invoice_number || '-'}
                                    <div style={{ marginTop: '0.35rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                        <button className="btn btn-sm btn-outline" onClick={() => copyTextToClipboard(selectedTrackedInvoice.invoice_number, 'Invoice Number')}>Copy</button>
                                        <button className="btn btn-sm btn-outline" onClick={() => shareTextValue(selectedTrackedInvoice.invoice_number, 'Invoice Number')}>Share</button>
                                    </div>
                                </div>
                                <div>
                                    <strong>PO Number:</strong> {selectedTrackedInvoice.po_number || '-'}
                                    <div style={{ marginTop: '0.35rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                        <button className="btn btn-sm btn-outline" onClick={() => copyTextToClipboard(selectedTrackedInvoice.po_number, 'PO Number')}>Copy</button>
                                        <button className="btn btn-sm btn-outline" onClick={() => shareTextValue(selectedTrackedInvoice.po_number, 'PO Number')}>Share</button>
                                    </div>
                                </div>
                                <div><strong>Amount:</strong> ₹{Number.parseFloat(selectedTrackedInvoice.amount || 0).toLocaleString()}</div>
                                <div><strong>Assigned By:</strong> {selectedTrackedInvoice.assigned_by_name || selectedTrackedInvoice.uploader_name || '-'}</div>
                                <div><strong>Assigned To:</strong> {selectedTrackedInvoice.assigned_to_name || selectedTrackedInvoice.assigned_to || '-'}</div>
                                <div><strong>Assigned At:</strong> {formatDateTime(selectedTrackedInvoice.assigned_at || selectedTrackedInvoice.created_at)}</div>
                                <div><strong>Accepted At:</strong> {formatDateTime(selectedTrackedInvoice.accepted_at)}</div>
                                <div><strong>Submitted At:</strong> {formatDateTime(selectedTrackedInvoice.voucher_submitted_at)}</div>
                                <div><strong>Completed At:</strong> {formatDateTime(selectedTrackedInvoice.completed_at)}</div>
                                <div><strong>Status:</strong> {String(selectedTrackedInvoice.status || '').replace('_', ' ') || '-'}</div>
                            </div>

                            <div style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                <button
                                    onClick={() => loadInvoiceHistory(selectedTrackedInvoice.id)}
                                    className="btn btn-sm"
                                    style={{ background: '#334155', color: 'white' }}
                                    disabled={loadingHistoryId === selectedTrackedInvoice.id}
                                >
                                    Refresh History
                                </button>
                                {loadingHistoryId === selectedTrackedInvoice.id && <span style={{ color: '#64748b', fontSize: '0.82rem' }}>Loading...</span>}
                            </div>

                            {loadingHistoryId === selectedTrackedInvoice.id && (
                                <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '10px', padding: '0.85rem', marginBottom: '0.85rem' }}>
                                    <div style={{ marginBottom: '0.65rem', fontWeight: 600, color: '#1E293B' }}>Assignment Lifecycle</div>
                                    {[1, 2, 3].map((line) => (
                                        <div
                                            key={`shimmer-${line}`}
                                            style={{
                                                height: '14px',
                                                borderRadius: '8px',
                                                marginBottom: '0.55rem',
                                                background: 'linear-gradient(90deg, #e2e8f0 25%, #f8fafc 50%, #e2e8f0 75%)',
                                                backgroundSize: '320px 100%',
                                                animation: 'dashboardHistoryShimmer 1.2s linear infinite',
                                            }}
                                        />
                                    ))}
                                </div>
                            )}

                            {invoiceHistories[selectedTrackedInvoice.id] && (
                                <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '10px', padding: '0.85rem' }}>
                                    <div style={{ marginBottom: '0.65rem', fontWeight: 600, color: '#1E293B' }}>
                                        Assignment Lifecycle
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                                        <div><strong>Assigned By:</strong> {invoiceHistories[selectedTrackedInvoice.id].lifecycle.assignedBy || '-'}</div>
                                        <div><strong>Assigned To:</strong> {invoiceHistories[selectedTrackedInvoice.id].lifecycle.assignedTo || '-'}</div>
                                        <div><strong>Assigned At:</strong> {formatDateTime(invoiceHistories[selectedTrackedInvoice.id].lifecycle.assignedAt)}</div>
                                        <div><strong>Accepted By:</strong> {invoiceHistories[selectedTrackedInvoice.id].lifecycle.acceptedBy || '-'}</div>
                                        <div><strong>Accepted At:</strong> {formatDateTime(invoiceHistories[selectedTrackedInvoice.id].lifecycle.acceptedAt)}</div>
                                        <div><strong>Submitted At:</strong> {formatDateTime(invoiceHistories[selectedTrackedInvoice.id].lifecycle.voucherSubmittedAt)}</div>
                                        <div><strong>Completed At:</strong> {formatDateTime(invoiceHistories[selectedTrackedInvoice.id].lifecycle.completedAt)}</div>
                                    </div>

                                    {invoiceHistories[selectedTrackedInvoice.id].history.length === 0 ? (
                                        <div className="text-muted">No history events available.</div>
                                    ) : (
                                        <div style={{ borderTop: '1px solid #E2E8F0', paddingTop: '0.75rem' }}>
                                            {invoiceHistories[selectedTrackedInvoice.id].history.map((event) => (
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

export default DashboardPage;
