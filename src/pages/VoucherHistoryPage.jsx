import React, { useState, useEffect } from 'react';
import { Search, Download } from 'lucide-react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import '../voucher-styles.css';

const VoucherHistoryPage = () => {
    const [vouchers, setVouchers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [paymentLogModal, setPaymentLogModal] = useState(null);
    const [paymentLogData, setPaymentLogData] = useState(null);
    const [paymentLogLoading, setPaymentLogLoading] = useState(false);
    const [paymentUpdateForm, setPaymentUpdateForm] = useState({
        status: 'submitted_to_vendor',
        referenceNo: '',
        remarks: '',
    });
    const [apiSyncWarning, setApiSyncWarning] = useState('');

    const formatDateTime = (value) => {
        if (!value) return '-';
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return String(value);
        return parsed.toLocaleString();
    };

    const parseApiResponse = async (response, fallbackErrorMessage) => {
        const contentType = response.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');

        if (isJson) {
            setApiSyncWarning('');
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data?.error || fallbackErrorMessage);
            }
            return data;
        }

        const text = await response.text();
        const shortText = (text || '').trim().slice(0, 140);
        const looksLikeHtml = /<!doctype html>|<html/i.test((text || '').trim());

        if (looksLikeHtml) {
            setApiSyncWarning('Backend API mismatch detected. Voucher page received HTML instead of JSON. Restart backend from this project and refresh the page.');
            const syncError = new Error('Payment log API is not available on the active backend.');
            syncError.isApiSyncWarning = true;
            throw syncError;
        }

        if (!response.ok) {
            throw new Error(text || fallbackErrorMessage);
        }

        const responseSuffix = shortText ? ` Response: ${shortText}` : '';
        throw new Error(`Unexpected server response. Please restart backend and try again.${responseSuffix}`);
    };
    const { getToken, user } = useAuth();
    const dialog = useDialog();

    useEffect(() => {
        fetchVouchers();
    }, []);

    // Resubmit Modal State
    const [resubmitVoucher, setResubmitVoucher] = useState(null);
    const [resubmitData, setResubmitData] = useState({
        description: '',
        gross_amount: '',
        basic_amount: '',
        po_number: '',
        invoice_number: ''
    });

    const openResubmitModal = (voucher) => {
        setResubmitVoucher(voucher);
        setResubmitData({
            description: voucher.description || '',
            gross_amount: voucher.gross_amount || '',
            basic_amount: voucher.basic_amount || '',
            po_number: voucher.po_number || '',
            invoice_number: voucher.invoice_number || ''
        });
    };

    const closeResubmitModal = () => {
        setResubmitVoucher(null);
        setResubmitData({
            description: '',
            gross_amount: '',
            basic_amount: '',
            po_number: '',
            invoice_number: ''
        });
    };

    const handleSubmitResubmission = async () => {
        if (!resubmitVoucher) return;

        try {
            const response = await fetch(`/api/jcc/vouchers/${resubmitVoucher.id}/resubmit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                },
                body: JSON.stringify(resubmitData)
            });

            if (response.ok) {
                await dialog.alert('Voucher resubmitted successfully!');
                closeResubmitModal();
                fetchVouchers(); // Refresh list
            } else {
                const data = await response.json();
                await dialog.alert(`Failed to resubmit: ${data.error}`);
            }
        } catch (error) {
            console.error('Error resubmitting voucher:', error);
            await dialog.alert('An error occurred while resubmitting.');
        }
    };

    const fetchVouchers = async () => {
        try {
            const response = await fetch('/api/jcc/vouchers', {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });
            if (response.ok) {
                const data = await response.json();
                setVouchers(data);
            } else {
                console.error('Failed to fetch vouchers:', response.status);
            }
        } catch (error) {
            console.error('Error fetching vouchers:', error);
        } finally {
            setLoading(false);
        }
    };

    // Filter vouchers based on search term
    const filteredVouchers = vouchers.filter(voucher => {
        if (!searchTerm) return true;

        const search = searchTerm.toLowerCase();
        const srNo = vouchers.indexOf(voucher) + 1;
        const jccId = `JCC${String(voucher.id).padStart(4, '0')}`.toLowerCase();
        const invoiceNo = (voucher.invoice_number || '').toLowerCase();

        return (
            srNo.toString().includes(search) ||
            jccId.includes(search) ||
            invoiceNo.includes(search)
        );
    });

    const handleDownloadPDF = async (voucherId) => {
        try {
            const token = getToken();
            console.log('Downloading PDF for voucher:', voucherId, 'with token:', token ? 'exists' : 'null');
            const response = await fetch(`/api/jcc/download-jcc-pdf/${voucherId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Device-ID': getDeviceId()
                }
            });

            if (!response.ok) {
                const errText = await response.text();
                // Try to parse JSON error if possible
                try {
                    const errJson = JSON.parse(errText);
                    console.error('Download failed:', errJson);
                    await dialog.alert(`Failed to download PDF: ${errJson.error || errText}`);
                } catch (e) {
                    console.error('Download failed (text):', errText);
                    await dialog.alert(`Failed to download PDF: ${errText}`);
                }
                return;
            }

            // Get the blob from response
            const blob = await response.blob();

            // Create a temporary URL for the blob
            const url = window.URL.createObjectURL(blob);

            // Create a temporary link and trigger download
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `JCC${String(voucherId).padStart(4, '0')}.pdf`);
            document.body.appendChild(link);
            link.click();

            // Clean up
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Error downloading PDF:', error);
            await dialog.alert('Failed to download PDF');
        }
    };

    const paymentStatusStyles = {
        awaiting_approval: { bg: '#EEF2FF', text: '#3730A3', label: 'Awaiting Approval' },
        pending_payment: { bg: '#FEF3C7', text: '#92400E', label: 'Pending Payment' },
        submitted_to_vendor: { bg: '#DBEAFE', text: '#1E40AF', label: 'Submitted To Vendor' },
        payment_initiated: { bg: '#E0E7FF', text: '#4338CA', label: 'Payment Initiated' },
        debited: { bg: '#D1FAE5', text: '#065F46', label: 'Debited' },
        settled: { bg: '#BBF7D0', text: '#14532D', label: 'Settled' },
        failed: { bg: '#FEE2E2', text: '#991B1B', label: 'Failed' },
        reversed: { bg: '#FDE68A', text: '#78350F', label: 'Reversed' },
    };

    const paymentStatusTransitions = {
        awaiting_approval: ['pending_payment'],
        pending_payment: ['submitted_to_vendor', 'payment_initiated', 'failed'],
        submitted_to_vendor: ['payment_initiated', 'failed'],
        payment_initiated: ['debited', 'failed'],
        debited: ['settled', 'reversed', 'failed'],
        settled: [],
        failed: ['payment_initiated', 'reversed'],
        reversed: ['payment_initiated'],
    };

    const supplierAckStyles = {
        not_sent: { bg: '#F1F5F9', text: '#334155', label: 'Not Sent' },
        pending: { bg: '#FEF3C7', text: '#92400E', label: 'Pending Response' },
        acknowledged: { bg: '#DCFCE7', text: '#166534', label: 'Acknowledged' },
        rejected: { bg: '#FEE2E2', text: '#991B1B', label: 'Rejected' },
        expired: { bg: '#E2E8F0', text: '#334155', label: 'Link Expired' },
    };

    const renderPaymentBadge = (status) => {
        const safe = status || 'awaiting_approval';
        const style = paymentStatusStyles[safe] || paymentStatusStyles.awaiting_approval;
        return (
            <span className="inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: style.bg, color: style.text }}>
                {style.label}
            </span>
        );
    };

    const renderSupplierAckBadge = (status) => {
        const safe = (status || 'not_sent').toLowerCase();
        const style = supplierAckStyles[safe] || supplierAckStyles.not_sent;
        return (
            <span className="inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: style.bg, color: style.text }}>
                {style.label}
            </span>
        );
    };

    const openPaymentLog = async (voucher) => {
        setPaymentLogModal(voucher);
        setPaymentLogLoading(true);
        setPaymentLogData(null);

        try {
            const response = await fetch(`/api/jcc/vouchers/${voucher.id}/payment-log`, {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });

            const data = await parseApiResponse(response, 'Failed to fetch payment log');

            const currentStatus = data.voucher?.payment_status || 'awaiting_approval';
            const nextStatuses = paymentStatusTransitions[currentStatus] || [];

            setPaymentLogData(data);
            setPaymentUpdateForm({
                status: nextStatuses[0] || '',
                referenceNo: data.voucher?.payment_reference || '',
                remarks: data.voucher?.payment_remarks || '',
            });
        } catch (error) {
            console.error('Error loading payment log:', error);
            if (!error?.isApiSyncWarning) {
                await dialog.alert(error.message || 'Failed to load payment log');
            }
            setPaymentLogModal(null);
        } finally {
            setPaymentLogLoading(false);
        }
    };

    const closePaymentLogModal = () => {
        setPaymentLogModal(null);
        setPaymentLogData(null);
        setPaymentLogLoading(false);
        setPaymentUpdateForm({ status: '', referenceNo: '', remarks: '' });
    };

    const canUpdatePayment = ['admin', 'coordinator', 'manager', 'final_approver'].includes(user?.role);

    const handleApprovePayment = async (voucher) => {
        if (!voucher?.id || !canUpdatePayment) return;

        try {
            const response = await fetch(`/api/jcc/vouchers/${voucher.id}/payment-status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify({
                    status: 'payment_initiated',
                    referenceNo: voucher.payment_reference || '',
                    remarks: 'Payment approved from Voucher History',
                    actionSource: 'manual',
                }),
            });

            await parseApiResponse(response, 'Failed to approve payment');
            await dialog.alert(`Payment approved for JCC${String(voucher.id).padStart(4, '0')}.`);
            fetchVouchers();
        } catch (error) {
            console.error('Error approving payment:', error);
            if (!error?.isApiSyncWarning) {
                await dialog.alert(error.message || 'Failed to approve payment');
            }
        }
    };

    const handleSendToSupplier = async (voucher) => {
        if (!voucher?.id || !canUpdatePayment) return;

        try {
            const response = await fetch(`/api/jcc/vouchers/${voucher.id}/send-to-supplier`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });

            const data = await parseApiResponse(response, 'Failed to send JCC to supplier');
            await dialog.alert(`JCC${String(voucher.id).padStart(4, '0')} sent to supplier email ${data?.recipientEmail || ''}`.trim());
            if (paymentLogModal?.id === voucher.id) {
                await openPaymentLog(paymentLogModal);
            }
            fetchVouchers();
        } catch (error) {
            console.error('Error sending voucher to supplier:', error);
            if (!error?.isApiSyncWarning) {
                await dialog.alert(error.message || 'Failed to send JCC to supplier');
            }
        }
    };

    const updatePaymentStatus = async () => {
        if (!paymentLogModal) return;

        const currentStatus = paymentLogData?.voucher?.payment_status || 'awaiting_approval';
        if (!paymentUpdateForm.status) {
            await dialog.alert('No valid next status available for this payment state.');
            return;
        }

        if (paymentUpdateForm.status === currentStatus) {
            await dialog.alert('Please select a valid next payment status.');
            return;
        }

        try {
            const response = await fetch(`/api/jcc/vouchers/${paymentLogModal.id}/payment-status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify({
                    status: paymentUpdateForm.status,
                    referenceNo: paymentUpdateForm.referenceNo,
                    remarks: paymentUpdateForm.remarks,
                }),
            });

            const data = await parseApiResponse(response, 'Failed to update payment status');

            if (data?.supplierDispatch?.recipientEmail) {
                await dialog.alert(`JCC${String(paymentLogModal.id).padStart(4, '0')} sent to supplier email ${data.supplierDispatch.recipientEmail}`);
            }

            await openPaymentLog(paymentLogModal);
            fetchVouchers();
        } catch (error) {
            console.error('Error updating payment status:', error);
            if (!error?.isApiSyncWarning) {
                await dialog.alert(error.message || 'Failed to update payment status');
            }
        }
    };

    const getStatusBadge = (status) => {
        const statusColors = {
            pending: { cls: 'bg-amber-50 text-amber-700', label: 'Pending' },
            pending_approval_1: { cls: 'bg-amber-50 text-amber-700', label: 'Pending Manager Approval' },
            pending_approval_2: { cls: 'bg-amber-50 text-amber-700', label: 'Pending Final Approval' },
            approved: { cls: 'bg-emerald-50 text-emerald-700', label: 'Approved' },
            rejected: { cls: 'bg-red-50 text-red-700', label: 'Rejected' },
        };

        const style = statusColors[status] || statusColors.pending;

        return (
            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${style.cls}`}>
                {style.label}
            </span>
        );
    };

    const pendingCount = vouchers.filter((v) => v.status === 'pending').length;
    const approvedCount = vouchers.filter((v) => v.status === 'approved').length;
    const rejectedCount = vouchers.filter((v) => v.status === 'rejected').length;

    if (loading) {
        return (
            <div className="container page-shell voucher-page fade-in">
                <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
                    Loading voucher history...
                </div>
            </div>
        );
    }

    return (
        <div className="container page-shell voucher-page fade-in">
            {/* Header */}
            <div className="voucher-hero">
                <h1>
                    {user?.role === 'admin' ? 'All Voucher History' : 'My Voucher History'}
                </h1>
                <p>
                    {user?.role === 'admin'
                        ? 'View and manage all voucher requests'
                        : 'Track the status of your voucher requests'}
                </p>
            </div>

            {apiSyncWarning && (
                <div style={{
                    background: '#FEF3C7',
                    border: '1px solid #F59E0B',
                    color: '#78350F',
                    borderRadius: '8px',
                    padding: '0.85rem 1rem',
                    marginBottom: '1rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '0.75rem'
                }}>
                    <span style={{ fontWeight: 600 }}>{apiSyncWarning}</span>
                    <button
                        type="button"
                        onClick={() => setApiSyncWarning('')}
                        style={{
                            border: 'none',
                            background: '#F59E0B',
                            color: 'white',
                            borderRadius: '6px',
                            padding: '0.35rem 0.65rem',
                            cursor: 'pointer',
                            fontWeight: 700,
                        }}
                    >
                        Dismiss
                    </button>
                </div>
            )}

            {/* Search Bar */}
            <div className="glass-card voucher-search-card">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                    <input
                        type="text"
                        placeholder="Search by SR No., Voucher ID, or Invoice No..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white py-3 pl-10 pr-4 text-sm text-slate-700 outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
                    />
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                    <p className="text-sm text-slate-500">
                        {searchTerm
                            ? `Found ${filteredVouchers.length} result${filteredVouchers.length !== 1 ? 's' : ''}`
                            : 'Search by SR number, voucher ID, or invoice number'}
                    </p>
                    {searchTerm && (
                        <button onClick={() => setSearchTerm('')} className="btn btn-danger">
                            Clear
                        </button>
                    )}
                </div>
            </div>

            {/* Vouchers Table */}
            <div className="glass-card voucher-table-shell">
                <div className="overflow-x-auto">
                    <table className="min-w-full border-separate border-spacing-0 overflow-hidden rounded-xl border border-slate-200 bg-white">
                        <thead>
                            <tr className="bg-slate-50">
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">SR NO.</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">VOUCHER ID</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">SUPPLIER</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">INVOICE NO.</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">AMOUNT</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">PO NO.</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">STATUS</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">PAYMENT</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">SUPPLIER ACK</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">CREATED BY</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">DATE</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-700">DOWNLOAD JCC</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredVouchers.length === 0 ? (
                                <tr>
                                    <td colSpan="12" className="px-4 py-12 text-center text-sm text-slate-500">
                                        {searchTerm ? `No vouchers found matching "${searchTerm}"` : 'No vouchers found'}
                                    </td>
                                </tr>
                            ) : (
                                filteredVouchers.map((voucher, index) => (
                                    <tr key={voucher.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                                        <td className="px-4 py-3 text-sm font-semibold text-slate-500">
                                            {index + 1}
                                        </td>
                                        <td className="px-4 py-3 font-semibold text-slate-900">
                                            JCC{String(voucher.id).padStart(4, '0')}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-slate-700">{voucher.supplier}</td>
                                        <td className="px-4 py-3 text-sm text-slate-700">{voucher.invoice_number}</td>
                                        <td className="px-4 py-3 text-sm font-semibold text-slate-900">
                                            ₹{Number.parseFloat(voucher.basic_amount || 0).toLocaleString()}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-slate-700">{voucher.po_number || '-'}</td>
                                        <td className="px-4 py-3">{getStatusBadge(voucher.status)}</td>
                                        <td className="px-4 py-3">{renderPaymentBadge(voucher.payment_status)}</td>
                                        <td className="px-4 py-3">
                                            <div className="flex flex-col gap-1">
                                                {renderSupplierAckBadge(voucher.supplier_ack_status)}
                                                {voucher.supplier_ack_email && (
                                                    <span className="text-xs text-slate-500">{voucher.supplier_ack_email}</span>
                                                )}
                                                {voucher.supplier_ack_status === 'pending' && voucher.supplier_ack_expires_at && (
                                                    <span className="text-xs text-slate-500">Expires {formatDateTime(voucher.supplier_ack_expires_at)}</span>
                                                )}
                                                {['acknowledged', 'rejected'].includes((voucher.supplier_ack_status || '').toLowerCase()) && voucher.supplier_ack_at && (
                                                    <span className="text-xs text-slate-500">Updated {formatDateTime(voucher.supplier_ack_at)}</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-slate-700">{voucher.user_name}</td>
                                        <td className="px-4 py-3 text-sm text-slate-500">
                                            {new Date(voucher.created_at).toLocaleDateString()}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-2">
                                                {voucher.status === 'approved' && canUpdatePayment && voucher.supplier_ack_status !== 'acknowledged' && (
                                                    <button
                                                        onClick={() => handleSendToSupplier(voucher)}
                                                        className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
                                                        title="Send JCC PDF and acknowledgement link to supplier"
                                                    >
                                                        {voucher.supplier_ack_status === 'pending' ? 'Resend to Supplier' : 'Send to Supplier'}
                                                    </button>
                                                )}

                                                {voucher.status === 'approved' && (
                                                    <button
                                                        onClick={() => openPaymentLog(voucher)}
                                                        className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                                                    >
                                                        Payment Log
                                                    </button>
                                                )}

                                                {voucher.status === 'approved' && voucher.payment_status === 'pending_payment' && canUpdatePayment && (
                                                    <button
                                                        onClick={() => handleApprovePayment(voucher)}
                                                        className="rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                                                        title="Approve pending payment"
                                                    >
                                                        Approve Payment
                                                    </button>
                                                )}

                                                {(voucher.status === 'approved' || voucher.status === 'processed') && (
                                                    <button
                                                        onClick={() => handleDownloadPDF(voucher.id)}
                                                        className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                                                        title="Download JCC PDF"
                                                    >
                                                        <Download className="h-4 w-4" />
                                                        PDF
                                                    </button>
                                                )}

                                                {/* Resubmit Button for Rejected Vouchers */}
                                                {(voucher.status === 'rejected' && (!user.id || user.id === voucher.user_id || user.role === 'admin')) && (
                                                    <button
                                                        onClick={() => openResubmitModal(voucher)}
                                                        className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-600"
                                                        title="Correction Required - Resubmit"
                                                    >
                                                        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                                        </svg>
                                                        Resubmit
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {paymentLogModal && (
                <div className="voucher-modal-backdrop">
                    <div className="voucher-modal voucher-modal-lg">
                        <div className="voucher-modal-header">
                            <h3 className="voucher-modal-title">Payment Log - JCC{String(paymentLogModal.id).padStart(4, '0')}</h3>
                            <button onClick={closePaymentLogModal} className="btn btn-outline">Close</button>
                        </div>

                        {paymentLogLoading ? (
                            <p style={{ marginTop: '1rem' }}>Loading payment logs...</p>
                        ) : (
                            <>
                                            {(() => {
                                                const currentStatus = paymentLogData?.voucher?.payment_status || 'awaiting_approval';
                                                const allowedNextStatuses = paymentStatusTransitions[currentStatus] || [];

                                                return (
                                                    <>
                                <div className="voucher-modal-panel">
                                    <div className="voucher-modal-log-head">
                                        <div><strong>Supplier:</strong> {paymentLogData?.voucher?.supplier || '-'}</div>
                                        <div><strong>Invoice:</strong> {paymentLogData?.voucher?.invoice_number || '-'}</div>
                                        <div><strong>Amount:</strong> ₹{Number.parseFloat(paymentLogData?.voucher?.basic_amount || 0).toLocaleString()}</div>
                                        <div><strong>Current:</strong> {renderPaymentBadge(paymentLogData?.voucher?.payment_status)}</div>
                                    </div>
                                </div>

                                <div className="voucher-modal-panel">
                                    <h4 style={{ margin: '0 0 0.6rem 0' }}>Supplier Acknowledgement</h4>
                                    <div className="voucher-modal-grid">
                                        <div>
                                            <div className="voucher-modal-muted" style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>Status</div>
                                            {renderSupplierAckBadge(paymentLogData?.voucher?.supplier_ack_status)}
                                        </div>
                                        <div>
                                            <div className="voucher-modal-muted" style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>Recipient Email</div>
                                            <div>{paymentLogData?.voucher?.supplier_ack_email || '-'}</div>
                                        </div>
                                        <div>
                                            <div className="voucher-modal-muted" style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>Sent At</div>
                                            <div>{formatDateTime(paymentLogData?.voucher?.supplier_ack_sent_at)}</div>
                                        </div>
                                        <div>
                                            <div className="voucher-modal-muted" style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>Expires At</div>
                                            <div>{formatDateTime(paymentLogData?.voucher?.supplier_ack_expires_at)}</div>
                                        </div>
                                        <div>
                                            <div className="voucher-modal-muted" style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>Responded At</div>
                                            <div>{formatDateTime(paymentLogData?.voucher?.supplier_ack_at)}</div>
                                        </div>
                                        <div>
                                            <div className="voucher-modal-muted" style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>Responded By</div>
                                            <div>{paymentLogData?.voucher?.supplier_ack_by_email || '-'}</div>
                                        </div>
                                    </div>

                                    {paymentLogData?.voucher?.supplier_ack_remarks && (
                                        <div style={{ marginTop: '0.75rem' }}>
                                            <div className="voucher-modal-muted" style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>Remarks</div>
                                            <div>{paymentLogData.voucher.supplier_ack_remarks}</div>
                                        </div>
                                    )}

                                    {paymentLogData?.voucher?.status === 'approved' && canUpdatePayment && String(paymentLogData?.voucher?.supplier_ack_status || '').toLowerCase() !== 'acknowledged' && (
                                        <button
                                            className="btn btn-primary"
                                            style={{ marginTop: '0.75rem' }}
                                            onClick={() => handleSendToSupplier({
                                                id: paymentLogModal.id,
                                                supplier_ack_status: paymentLogData?.voucher?.supplier_ack_status,
                                            })}
                                        >
                                            {String(paymentLogData?.voucher?.supplier_ack_status || '').toLowerCase() === 'pending' ? 'Resend to Supplier' : 'Send to Supplier'}
                                        </button>
                                    )}
                                </div>

                                <div className="voucher-modal-panel">
                                    <h4 style={{ margin: '0 0 0.6rem 0' }}>Update Payment Status</h4>
                                    <div className="voucher-modal-grid">
                                        <select
                                            value={paymentUpdateForm.status}
                                            onChange={(e) => setPaymentUpdateForm((prev) => ({ ...prev, status: e.target.value }))}
                                            className="input-field"
                                            disabled={allowedNextStatuses.length === 0}
                                        >
                                            <option value="" disabled>Select next status</option>
                                            {allowedNextStatuses.map((status) => (
                                                <option key={status} value={status}>
                                                    {paymentStatusStyles[status]?.label || status}
                                                </option>
                                            ))}
                                        </select>
                                        <input
                                            className="input-field"
                                            placeholder="Reference no (optional)"
                                            value={paymentUpdateForm.referenceNo}
                                            onChange={(e) => setPaymentUpdateForm((prev) => ({ ...prev, referenceNo: e.target.value }))}
                                        />
                                        <textarea
                                            className="input-field voucher-modal-full"
                                            style={{ minHeight: '80px' }}
                                            placeholder="Remarks"
                                            value={paymentUpdateForm.remarks}
                                            onChange={(e) => setPaymentUpdateForm((prev) => ({ ...prev, remarks: e.target.value }))}
                                        />
                                    </div>
                                    {allowedNextStatuses.length === 0 && (
                                        <p className="voucher-modal-muted" style={{ marginTop: '0.75rem' }}>
                                            No further transitions are allowed from this payment status.
                                        </p>
                                    )}
                                    <button
                                        className="btn btn-primary"
                                        style={{ marginTop: '0.75rem' }}
                                        onClick={updatePaymentStatus}
                                        disabled={allowedNextStatuses.length === 0}
                                    >
                                        Save Payment Update
                                    </button>
                                </div>

                                <div style={{ marginTop: '1rem' }}>
                                    <h4 style={{ margin: '0 0 0.6rem 0' }}>Timeline</h4>
                                    {paymentLogData?.logs?.length === 0 ? (
                                        <p className="voucher-modal-muted">No payment events logged yet.</p>
                                    ) : (
                                        paymentLogData.logs.map((log) => (
                                            <div key={log.id} className="voucher-modal-log-row">
                                                <div className="voucher-modal-log-head">
                                                    <div>
                                                        <strong>{log.old_status || '-'} → {log.new_status}</strong>
                                                        {log.reference_no ? ` | Ref: ${log.reference_no}` : ''}
                                                        {log.remarks ? ` | ${log.remarks}` : ''}
                                                    </div>
                                                    <div className="voucher-modal-muted">{new Date(log.created_at).toLocaleString()}</div>
                                                </div>
                                                <div style={{ color: '#475569', fontSize: '0.875rem' }}>by {log.action_by_name || 'system'}</div>
                                            </div>
                                        ))
                                    )}
                                </div>
                                        </>
                                    );
                                })()}
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Summary Stats */}
            <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
                    <div className="text-sm font-semibold text-amber-700">Pending</div>
                    <div className="mt-2 text-4xl font-bold text-amber-800">{pendingCount}</div>
                </div>

                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
                    <div className="text-sm font-semibold text-emerald-700">Approved</div>
                    <div className="mt-2 text-4xl font-bold text-emerald-800">{approvedCount}</div>
                </div>

                <div className="rounded-xl border border-red-200 bg-red-50 p-5">
                    <div className="text-sm font-semibold text-red-700">Rejected</div>
                    <div className="mt-2 text-4xl font-bold text-red-800">{rejectedCount}</div>
                </div>
            </div>
            {/* Resubmit Modal */}
            {resubmitVoucher && (
                <div className="voucher-modal-backdrop">
                    <div className="voucher-modal voucher-modal-md">
                        <div className="voucher-modal-header voucher-modal-header-lined">
                            <h2 className="voucher-modal-title">
                                Resubmit Voucher
                            </h2>
                            <span className="voucher-modal-chip">
                                JCC{String(resubmitVoucher.id).padStart(4, '0')}
                            </span>
                        </div>

                        <div className="voucher-modal-warning">
                            <div className="voucher-modal-warning-head">
                                <svg width="20" height="20" fill="none" stroke="#DC2626" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                                <strong>Rejection Reason</strong>
                            </div>
                            <p style={{ margin: 0, color: '#7F1D1D', fontSize: '0.95rem', lineHeight: 1.5 }}>
                                {resubmitVoucher.approver1_status === 'rejected' ? resubmitVoucher.approver1_remark : resubmitVoucher.approver2_remark}
                            </p>
                        </div>

                        <div className="input-group" style={{ marginBottom: '1.25rem' }}>
                            <label className="input-label">
                                Description / Purpose
                            </label>
                            <textarea
                                rows="3"
                                value={resubmitData.description}
                                onChange={(e) => setResubmitData({ ...resubmitData, description: e.target.value })}
                                className="input-field"
                                style={{ resize: 'vertical', minHeight: '90px' }}
                            />
                        </div>

                        <div className="voucher-modal-grid" style={{ marginBottom: '1.25rem' }}>
                            <div className="input-group">
                                <label className="input-label">Gross Amount (₹)</label>
                                <input
                                    type="number"
                                    value={resubmitData.gross_amount}
                                    onChange={(e) => setResubmitData({ ...resubmitData, gross_amount: e.target.value })}
                                    className="input-field"
                                />
                            </div>
                            <div className="input-group">
                                <label className="input-label">Basic Amount (₹)</label>
                                <input
                                    type="number"
                                    value={resubmitData.basic_amount}
                                    onChange={(e) => setResubmitData({ ...resubmitData, basic_amount: e.target.value })}
                                    className="input-field"
                                />
                            </div>
                        </div>

                        <div className="voucher-modal-grid" style={{ marginBottom: '2rem' }}>
                            <div className="input-group">
                                <label className="input-label">PO Number</label>
                                <input
                                    type="text"
                                    value={resubmitData.po_number}
                                    onChange={(e) => setResubmitData({ ...resubmitData, po_number: e.target.value })}
                                    className="input-field"
                                />
                            </div>
                            <div className="input-group">
                                <label className="input-label">Invoice Number</label>
                                <input
                                    type="text"
                                    value={resubmitData.invoice_number}
                                    onChange={(e) => setResubmitData({ ...resubmitData, invoice_number: e.target.value })}
                                    className="input-field"
                                />
                            </div>
                        </div>

                        <div className="voucher-modal-actions">
                            <button
                                onClick={closeResubmitModal}
                                className="btn btn-outline"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSubmitResubmission}
                                className="btn btn-primary"
                            >
                                Confirm Resubmission
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default VoucherHistoryPage;
