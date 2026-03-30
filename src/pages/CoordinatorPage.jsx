import React, { useState, useEffect } from 'react';
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
    const [jccData, setJccData] = useState({
        description: '',
        category: '',
        approvedAmount: '',
    });
    const { getToken, user } = useAuth();
    const dialog = useDialog();

    useEffect(() => {
        fetchPendingData();
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

            // Fetch pending vouchers
            const vouchersResponse = await fetch('/api/jcc/vouchers', {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });
            const vouchersData = await vouchersResponse.json();


            // Filter vouchers based on user role and approver assignments
            let filteredVouchers;
            if (user?.role === 'manager' || user?.role === 'final_approver') {
                console.log('Manager/Admin filtering - User name:', user.name);
                console.log('All vouchers:', vouchersData);

                filteredVouchers = vouchersData.filter(v => {
                    // Check if user is Approver 1 (manager) with pending status
                    // ONLY if the user is a manager or admin
                    const isApprover1 = user.role === 'manager' &&
                        v.approver1_name?.trim().toLowerCase() === user.name?.trim().toLowerCase() &&
                        v.status === 'pending_approval_1' && v.approver1_status === 'pending';

                    // Check if user is Approver 2 (Final Approver) with pending status after Level 1 approval
                    // ONLY if the user is a final_approver or admin
                    const isApprover2 = user.role === 'final_approver' &&
                        v.approver2_name?.trim().toLowerCase() === user.name?.trim().toLowerCase() &&
                        v.status === 'pending_approval_2' && v.approver2_status === 'pending';

                    console.log(`Voucher ${v.id}: approver1="${v.approver1_name}", approver2="${v.approver2_name}", status="${v.status}", approver1_status="${v.approver1_status}", approver2_status="${v.approver2_status}", isApprover1=${isApprover1}, isApprover2=${isApprover2}`);

                    return isApprover1 || isApprover2;
                });

                console.log('Filtered vouchers for user:', filteredVouchers);
            } else {
                // For other roles: show all pending vouchers
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

    const handleApproveVoucher = async (voucherId) => {
        try {
            // Determine which approval level endpoint to use based on voucher status
            const voucher = vouchers.find(v => v.id === voucherId);
            const endpoint = voucher?.current_approval_level === 1
                ? `/api/jcc/approve-level-1/${voucherId}`
                : `/api/jcc/approve-level-2/${voucherId}`;

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify({ remark: voucherRemark }),
            });

            if (response.ok) {
                const data = await response.json();
                await dialog.alert('Voucher approved successfully!');

                // PDF download removed - users can download manually from Voucher History page

                closeVoucherModal();
                fetchPendingData();
            } else {
                const data = await response.json();
                await dialog.alert(data.error || 'Failed to approve voucher');
            }
        } catch (error) {
            console.error('Error approving voucher:', error);
            await dialog.alert('Failed to approve voucher');
        }
    };

    const handleRejectVoucher = async (voucherId) => {
        if (!voucherRemark.trim()) {
            await dialog.alert('Please provide a remark for rejection');
            return;
        }

        try {
            // Determine which rejection level endpoint to use
            const voucher = vouchers.find(v => v.id === voucherId);
            const endpoint = voucher?.current_approval_level === 1
                ? `/api/jcc/reject-level-1/${voucherId}`
                : `/api/jcc/reject-level-2/${voucherId}`;

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify({ remark: voucherRemark }),
            });

            if (response.ok) {
                await dialog.alert('Voucher rejected');
                closeVoucherModal();
                fetchPendingData();
            } else {
                const data = await response.json();
                await dialog.alert(data.error || 'Failed to reject voucher');
            }
        } catch (error) {
            console.error('Error rejecting voucher:', error);
            await dialog.alert('Failed to reject voucher');
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
                        {user?.role === 'manager' || user?.role === 'final_approver' ? 'Approval Dashboard' : 'Verify Invoices & Approve Vouchers'}
                    </h1>
                    <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, color: 'white' }}>
                        {user?.role === 'manager'
                            ? 'Review and approve pending voucher requests assigned to you'
                            : 'Review OCR-extracted invoice data and approve pending voucher requests'}
                    </p>
                </div>

                {/* Pending Vouchers Section */}
                {vouchers.length > 0 && (
                    <>
                        <h2 style={{ color: '#0066CC', marginBottom: '1rem', fontSize: '1.5rem' }}>
                            Pending Vouchers ({vouchers.length})
                        </h2>
                        <div className="card-grid" style={{ marginBottom: '2rem' }}>
                            {vouchers.map((voucher) => (
                                <div key={voucher.id} className="glass-card" style={{ background: 'white', border: '1px solid #E0E0E0' }}>
                                    <div className="flex justify-between items-center mb-md">
                                        <h3 style={{ margin: 0, color: '#0066CC' }}>VR-{String(voucher.id).padStart(4, '0')}</h3>
                                        <span className="badge badge-warning">
                                            {voucher.status === 'pending_approval_1' ? 'Pending Manager Approval' : 'Pending Final Approval'}
                                        </span>
                                    </div>

                                    <div style={{ display: 'grid', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-lg)' }}>
                                        <div className="flex justify-between">
                                            <span style={{ color: '#64748B' }}>Supplier:</span>
                                            <strong style={{ color: '#1E293B' }}>{voucher.supplier}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: '#64748B' }}>Invoice No.:</span>
                                            <strong style={{ color: '#1E293B' }}>{voucher.invoice_number}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: '#64748B' }}>Amount:</span>
                                            <strong style={{ color: '#0066CC', fontSize: '1.1rem' }}>₹{parseFloat(voucher.basic_amount || 0).toLocaleString()}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: '#64748B' }}>PO No.:</span>
                                            <strong style={{ color: '#1E293B' }}>{voucher.po_number || 'N/A'}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: '#64748B' }}>Requested By:</span>
                                            <strong style={{ color: '#1E293B' }}>{voucher.user_name}</strong>
                                        </div>
                                        <div className="flex justify-between">
                                            <span style={{ color: '#64748B' }}>Date:</span>
                                            <strong style={{ color: '#1E293B' }}>{new Date(voucher.created_at).toLocaleDateString()}</strong>
                                        </div>
                                        {voucher.description && (
                                            <div>
                                                <span style={{ color: '#64748B' }}>Description:</span>
                                                <p style={{ margin: '4px 0 0 0', fontSize: '0.875rem', color: '#1E293B' }}>{voucher.description}</p>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex gap-sm">
                                        <button
                                            className="btn"
                                            style={{ flex: 1, background: '#0066CC', color: 'white' }}
                                            onClick={() => {
                                                setSelectedVoucher(voucher);
                                                if (voucher.attachment_path) {
                                                    fetchPdfUrl(voucher.id);
                                                }
                                            }}
                                        >
                                            View Details
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Voucher Details Modal */}
                        {selectedVoucher && (
                            <div className="app-modal-backdrop">
                                <div className="app-modal app-modal-lg" style={{ position: 'relative' }}>
                                    {/* Close Button */}
                                    <button
                                        onClick={closeVoucherModal}
                                        style={{
                                            position: 'absolute',
                                            top: '1rem',
                                            right: '1rem',
                                            background: '#EF4444',
                                            color: 'white',
                                            border: 'none',
                                            borderRadius: '50%',
                                            width: '32px',
                                            height: '32px',
                                            cursor: 'pointer',
                                            fontSize: '16px',
                                            fontWeight: 'bold'
                                        }}
                                    >
                                        ✕
                                    </button>

                                    <h2 style={{ marginBottom: '1.5rem', color: '#0066CC' }}>
                                        Voucher Details - VR-{selectedVoucher.id}
                                    </h2>

                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', marginBottom: '2rem' }}>
                                        {/* Left Column - Details */}
                                        <div>
                                            <h3 style={{ fontSize: '1.1rem', marginBottom: '1rem', color: '#1E293B' }}>Voucher Information</h3>

                                            <div style={{ display: 'grid', gap: '0.75rem' }}>
                                                <div style={{ padding: '0.75rem', background: '#F8F9FA', borderRadius: '6px' }}>
                                                    <div style={{ color: '#64748B', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Supplier</div>
                                                    <div style={{ fontWeight: '600', color: '#1E293B' }}>{selectedVoucher.supplier}</div>
                                                </div>

                                                <div style={{ padding: '0.75rem', background: '#F8F9FA', borderRadius: '6px' }}>
                                                    <div style={{ color: '#64748B', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Invoice Number</div>
                                                    <div style={{ fontWeight: '600', color: '#1E293B' }}>{selectedVoucher.invoice_number}</div>
                                                </div>

                                                <div style={{ padding: '0.75rem', background: '#F8F9FA', borderRadius: '6px' }}>
                                                    <div style={{ color: '#64748B', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Amount</div>
                                                    <div style={{ fontWeight: '700', color: '#0066CC', fontSize: '1.25rem' }}>
                                                        ₹{parseFloat(selectedVoucher.basic_amount || 0).toLocaleString()}
                                                    </div>
                                                </div>

                                                <div style={{ padding: '0.75rem', background: '#F8F9FA', borderRadius: '6px' }}>
                                                    <div style={{ color: '#64748B', fontSize: '0.875rem', marginBottom: '0.25rem' }}>PO Number</div>
                                                    <div style={{ fontWeight: '600', color: '#1E293B' }}>{selectedVoucher.po_number || 'N/A'}</div>
                                                </div>

                                                <div style={{ padding: '0.75rem', background: '#F8F9FA', borderRadius: '6px' }}>
                                                    <div style={{ color: '#64748B', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Requested By</div>
                                                    <div style={{ fontWeight: '600', color: '#1E293B' }}>{selectedVoucher.user_name}</div>
                                                </div>

                                                <div style={{ padding: '0.75rem', background: '#F8F9FA', borderRadius: '6px' }}>
                                                    <div style={{ color: '#64748B', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Date</div>
                                                    <div style={{ fontWeight: '600', color: '#1E293B' }}>
                                                        {new Date(selectedVoucher.created_at).toLocaleDateString()}
                                                    </div>
                                                </div>

                                                {selectedVoucher.description && (
                                                    <div style={{ padding: '0.75rem', background: '#F8F9FA', borderRadius: '6px' }}>
                                                        <div style={{ color: '#64748B', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Description</div>
                                                        <div style={{ color: '#1E293B' }}>{selectedVoucher.description}</div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Right Column - PDF Preview */}
                                        <div>
                                            <h3 style={{ fontSize: '1.1rem', marginBottom: '1rem', color: '#1E293B' }}>Attached Document</h3>

                                            {selectedVoucher.attachment_path ? (
                                                <div style={{
                                                    border: '2px solid #E0E0E0',
                                                    borderRadius: '8px',
                                                    overflow: 'hidden',
                                                    background: '#F8F9FA'
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
                                                                background: '#fff'
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
                                                    <div style={{ padding: '0.75rem', background: '#fff', borderTop: '1px solid #E0E0E0' }}>
                                                        <a
                                                            href={pdfUrl || '#'}
                                                            download
                                                            style={{
                                                                color: '#0066CC',
                                                                textDecoration: 'none',
                                                                fontWeight: '600',
                                                                fontSize: '0.875rem'
                                                            }}
                                                        >
                                                            Download Attachment
                                                        </a>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div style={{
                                                    padding: '2rem',
                                                    textAlign: 'center',
                                                    border: '2px dashed #E0E0E0',
                                                    borderRadius: '8px',
                                                    color: '#64748B'
                                                }}>
                                                    No attachment available
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Remark Section */}
                                    <div style={{ marginBottom: '1.5rem' }}>
                                        <label style={{ display: 'block', fontWeight: '600', marginBottom: '0.5rem', color: '#1E293B' }}>
                                            Remark / Comments *
                                        </label>
                                        <textarea
                                            value={voucherRemark}
                                            onChange={(e) => setVoucherRemark(e.target.value)}
                                            placeholder="Enter your remark or comments for approval/rejection..."
                                            style={{
                                                width: '100%',
                                                minHeight: '100px',
                                                padding: '0.75rem',
                                                border: '1px solid #D1D5DB',
                                                borderRadius: '6px',
                                                fontSize: '0.95rem',
                                                fontFamily: 'inherit',
                                                resize: 'vertical'
                                            }}
                                        />
                                    </div>

                                    {/* Action Buttons */}
                                    <div className="app-modal-actions">
                                        <button
                                            onClick={closeVoucherModal}
                                            className="btn btn-outline"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => handleRejectVoucher(selectedVoucher.id)}
                                            className="btn btn-danger"
                                        >
                                            ✗ Reject Voucher
                                        </button>
                                        <button
                                            onClick={() => handleApproveVoucher(selectedVoucher.id)}
                                            className="btn btn-success"
                                        >
                                            ✓ Approve Voucher
                                        </button>
                                    </div>
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
                        <p className="text-muted">All invoices and vouchers have been processed</p>
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
