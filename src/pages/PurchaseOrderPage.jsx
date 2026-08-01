import React, { useState, useEffect, useMemo } from 'react';
import DatePicker from '../components/DatePicker';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { Plus, Edit2, Trash2, Search, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { getVendorNames } from '../utils/vendorList';
import { dateSortValue, formatDate } from '../utils/datetime';

const PurchaseOrderPage = () => {
    const { getToken, user } = useAuth();
    const dialog = useDialog();
    const [purchaseOrders, setPurchaseOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [vendorFilter, setVendorFilter] = useState('');
    const [sortOption, setSortOption] = useState('date_desc');
    const [showModal, setShowModal] = useState(false);
    const [editingPo, setEditingPo] = useState(null);
    const [supplierOptions, setSupplierOptions] = useState([]);
    const [expandedVendors, setExpandedVendors] = useState({});
    const [selectedPo, setSelectedPo] = useState(null);
    const [vendorVisibleCount, setVendorVisibleCount] = useState({});
    const [drawerTab, setDrawerTab] = useState('details');

    const DEFAULT_VENDOR_PAGE_SIZE = 6;

    const [formData, setFormData] = useState({
        poNumber: '',
        supplierCode: '',
        supplierAddress: '',
        vendorName: '',
        buyerName: '',
        buyerEmail: '',
        totalBudget: '',
        poDate: '',
        status: 'active'
    });

    useEffect(() => {
        fetchPOs();
        fetchSupplierOptions();
    }, []);

    const fetchSupplierOptions = async () => {
        try {
            const response = await fetch('/api/jcc/po-suppliers', {
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });

            if (response.ok) {
                const data = await response.json();
                setSupplierOptions(Array.isArray(data) ? data : []);
            }
        } catch (error) {
            console.error('Error fetching supplier options:', error);
        }
    };

    const fetchPOs = async () => {
        try {
            const response = await fetch('/api/purchase-orders', {
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });
            if (response.ok) {
                const data = await response.json();
                setPurchaseOrders(data);
            }
        } catch (error) {
            console.error('Error fetching POs:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            const url = editingPo
                ? `/api/purchase-orders/${editingPo.id}`
                : '/api/purchase-orders';

            const method = editingPo ? 'PUT' : 'POST';

            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                },
                body: JSON.stringify(formData)
            });

            if (response.ok) {
                await dialog.alert(editingPo ? 'PO Updated Successfully' : 'PO Created Successfully');
                setShowModal(false);
                setEditingPo(null);
                setFormData({
                    poNumber: '',
                    supplierCode: '',
                    supplierAddress: '',
                    vendorName: '',
                    buyerName: '',
                    buyerEmail: '',
                    totalBudget: '',
                    poDate: '',
                    status: 'active'
                });
                fetchPOs();
            } else {
                const data = await response.json();
                await dialog.alert('Error: ' + data.error);
            }
        } catch (error) {
            console.error('Error saving PO:', error);
            await dialog.alert('Failed to save PO');
        }
    };

    const handleDelete = async (id) => {
        const confirmed = await dialog.confirm('Are you sure you want to delete this PO?');
        if (!confirmed) return;

        try {
            const response = await fetch(`/api/purchase-orders/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });

            if (response.ok) {
                fetchPOs();
            } else {
                await dialog.alert('Failed to delete PO');
            }
        } catch (error) {
            console.error('Error deleting PO:', error);
        }
    };

    const handleEdit = (po) => {
        setEditingPo(po);
        setFormData({
            poNumber: po.po_number,
            supplierCode: po.supplier_code || '',
            supplierAddress: po.supplier_address || '',
            vendorName: po.vendor_name || '',
            buyerName: po.buyer_name || '',
            buyerEmail: po.buyer_email || '',
            totalBudget: po.total_budget,
            poDate: po.po_date || '',
            status: po.status
        });
        setShowModal(true);
    };

    const vendorFilterOptions = useMemo(() => {
        const names = purchaseOrders
            .map(po => (po.vendor_name || '').trim())
            .filter(Boolean);
        return [...new Set(names)].sort((a, b) => a.localeCompare(b));
    }, [purchaseOrders]);

    const filteredPOs = purchaseOrders.filter(po => {
        const matchesSearch =
            po.po_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
            (po.vendor_name && po.vendor_name.toLowerCase().includes(searchTerm.toLowerCase()));
        const matchesVendor = vendorFilter ? (po.vendor_name || '').trim() === vendorFilter : true;
        return matchesSearch && matchesVendor;
    });

    const groupedPOs = useMemo(() => {
        const groups = filteredPOs.reduce((acc, po) => {
            const vendorKey = (po.vendor_name || '').trim() || 'Unassigned Vendor';
            if (!acc[vendorKey]) acc[vendorKey] = [];
            acc[vendorKey].push(po);
            return acc;
        }, {});
        const sortItems = (items) => {
            const next = [...items];
            switch (sortOption) {
                case 'amount_desc':
                    return next.sort((a, b) => (b.total_budget || 0) - (a.total_budget || 0));
                case 'amount_asc':
                    return next.sort((a, b) => (a.total_budget || 0) - (b.total_budget || 0));
                case 'date_asc':
                    return next.sort((a, b) => dateSortValue(a.po_date) - dateSortValue(b.po_date));
                case 'date_desc':
                    return next.sort((a, b) => dateSortValue(b.po_date) - dateSortValue(a.po_date));
                case 'po_asc':
                    return next.sort((a, b) => String(a.po_number || '').localeCompare(String(b.po_number || '')));
                case 'po_desc':
                    return next.sort((a, b) => String(b.po_number || '').localeCompare(String(a.po_number || '')));
                case 'status':
                    return next.sort((a, b) => String(a.status || '').localeCompare(String(b.status || '')));
                default:
                    return next;
            }
        };
        return Object.keys(groups)
            .sort((a, b) => a.localeCompare(b))
            .map(vendor => ({ vendor, items: sortItems(groups[vendor]) }));
    }, [filteredPOs, sortOption]);

    const poVendorOptions = useMemo(() => {
        const base = getVendorNames(formData.vendorName);
        const merged = [...new Set([...base, ...supplierOptions].filter(Boolean))].sort((a, b) => a.localeCompare(b));
        if (formData.vendorName && !merged.includes(formData.vendorName)) {
            return [formData.vendorName, ...merged];
        }
        return merged;
    }, [formData.vendorName, supplierOptions]);

    const handleVendorSelection = (value) => {
        setFormData({ ...formData, vendorName: value });
    };

    const toggleVendorSection = (vendorName) => {
        setExpandedVendors((current) => {
            const isExpanded = current[vendorName] ?? true;
            return { ...current, [vendorName]: !isExpanded };
        });
    };

    const getVisibleCount = (vendorName, total) => {
        const current = vendorVisibleCount[vendorName] ?? DEFAULT_VENDOR_PAGE_SIZE;
        return Math.min(current, total);
    };

    const showMoreForVendor = (vendorName, total) => {
        setVendorVisibleCount((current) => {
            const next = (current[vendorName] ?? DEFAULT_VENDOR_PAGE_SIZE) + DEFAULT_VENDOR_PAGE_SIZE;
            return { ...current, [vendorName]: Math.min(next, total) };
        });
    };

    const resetVendorCount = (vendorName) => {
        setVendorVisibleCount((current) => ({ ...current, [vendorName]: DEFAULT_VENDOR_PAGE_SIZE }));
    };

    return (
        <div className="container fade-in" style={{ padding: 'var(--spacing-xl)' }}>
            <div style={{
                // background: '#0066CC',
                // color: 'white',
                // padding: '1.5rem 2rem',
                // borderRadius: '8px',
                // marginBottom: '2rem',
                // display: 'flex',
                // justifyContent: 'space-between',
                // alignItems: 'center'
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '1rem',
                marginBottom: '1.5rem',
                padding: '1rem 1.25rem',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: '0.9rem',
                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.05)'
            }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'var(--text-strong)' }}>PO Management</h1>
                    <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, color: 'var(--text-strong)' }}>Track Purchase Orders and Budget Utilization</p>
                </div>
                {(user.role === 'admin' || user.role === 'manager' || user.role === 'coordinator') && (
                    <button
                        onClick={() => {
                            setEditingPo(null);
                            setFormData({
                                poNumber: '',
                                supplierCode: '',
                                supplierAddress: '',
                                vendorName: '',
                                buyerName: '',
                                buyerEmail: '',
                                totalBudget: '',
                                poDate: '',
                                status: 'active'
                            });
                            setShowModal(true);
                        }}
                        className="btn btn-primary"
                    >
                        <Plus size={20} />
                        Add New PO
                    </button>
                )}
            </div>

            {/* Search */}
            <div className="glass-card mb-xl" style={{ position: 'sticky', top: '1rem', zIndex: 5 }}>
                <div className="input-group" style={{ marginBottom: 0 }}>
                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                        <div style={{ position: 'relative', flex: 1, minWidth: '220px' }}>
                            <Search size={20} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                            <input
                                type="text"
                                placeholder="Search by PO Number or Vendor..."
                                className="input-field premium-search-field"
                                style={{ paddingLeft: '3rem' }}
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                        <div style={{ minWidth: '220px' }}>
                            <select
                                className="input-field"
                                value={vendorFilter}
                                onChange={(e) => setVendorFilter(e.target.value)}
                            >
                                <option value="">All Vendors</option>
                                {vendorFilterOptions.map((vendor) => (
                                    <option key={vendor} value={vendor}>{vendor}</option>
                                ))}
                            </select>
                        </div>
                        <div style={{ minWidth: '220px' }}>
                            <select
                                className="input-field"
                                value={sortOption}
                                onChange={(e) => setSortOption(e.target.value)}
                            >
                                <option value="date_desc">Sort: Date (Newest)</option>
                                <option value="date_asc">Sort: Date (Oldest)</option>
                                <option value="amount_desc">Sort: Amount (High to Low)</option>
                                <option value="amount_asc">Sort: Amount (Low to High)</option>
                                <option value="po_asc">Sort: PO Number (A-Z)</option>
                                <option value="po_desc">Sort: PO Number (Z-A)</option>
                                <option value="status">Sort: Status</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            {/* PO List */}
            {groupedPOs.map(({ vendor, items }) => (
                (() => {
                    const isExpanded = expandedVendors[vendor] ?? false;
                    const visibleCount = getVisibleCount(vendor, items.length);
                    const visibleItems = items.slice(0, visibleCount);
                    const hasMore = visibleCount < items.length;
                    const canShowLess = items.length > DEFAULT_VENDOR_PAGE_SIZE && visibleCount > DEFAULT_VENDOR_PAGE_SIZE;
                    return (
                <div key={vendor} style={{ marginBottom: '1.5rem' }}>
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '0.75rem 1rem',
                        borderRadius: '0.75rem',
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border)',
                        marginBottom: '0.75rem'
                    }}>
                        <button
                            type="button"
                            onClick={() => toggleVendorSection(vendor)}
                            style={{
                                fontSize: '1rem',
                                fontWeight: 600,
                                background: 'transparent',
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                                textAlign: 'left'
                            }}
                            aria-expanded={isExpanded}
                            aria-label={`Toggle ${vendor} POs`}
                        >
                            {vendor}
                        </button>
                        <button
                            type="button"
                            onClick={() => toggleVendorSection(vendor)}
                            className="text-muted"
                            style={{
                                fontSize: '0.85rem',
                                background: 'transparent',
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem'
                            }}
                            aria-expanded={isExpanded}
                            aria-label={`Toggle ${vendor} POs`}
                        >
                            {items.length} PO{items.length === 1 ? '' : 's'}
                            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                    </div>
                    {isExpanded && (
                        <div>
                            <div className="card-grid">
                                {visibleItems.map((po) => (
                                <div key={po.id} className="glass-card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                                    <div className="flex justify-between items-start mb-md">
                                        <div>
                                            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.25rem' }}>
                                                <FileText size={20} color="var(--primary)" />
                                                <button
                                                    type="button"
                                                    onClick={() => setSelectedPo(po)}
                                                    style={{
                                                        background: 'transparent',
                                                        border: 'none',
                                                        padding: 0,
                                                        cursor: 'pointer',
                                                        fontSize: '1.1rem',
                                                        fontWeight: 600,
                                                        textAlign: 'left'
                                                    }}
                                                    aria-label={`Open details for ${po.po_number}`}
                                                >
                                                    {po.po_number}
                                                </button>
                                            </h3>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                                                <span className="text-muted" style={{ fontSize: '0.9rem' }}>
                                                    {po.vendor_name || 'No Vendor Specified'}
                                                </span>
                                            </div>
                                        </div>
                                        <span className={`badge ${po.status === 'active' ? 'badge-success' : 'badge-secondary'}`}>
                                            {po.status}
                                        </span>
                                    </div>

                                    <div className="mb-md" style={{ flex: 1 }}>
                                        <div className="flex justify-between mb-sm" style={{ fontSize: '0.95rem' }}>
                                            <span className="text-muted">PO Amount:</span>
                                            <span style={{ fontWeight: 600 }}>₹{parseFloat(po.total_budget).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                        </div>
                                        <div className="flex justify-between" style={{ fontSize: '0.95rem' }}>
                                            <span className="text-muted">PO Date:</span>
                                            <span>{formatDate(po.po_date)}</span>
                                        </div>
                                    </div>

                                    {(user.role === 'admin' || user.role === 'manager' || user.role === 'coordinator') && (
                                        <div className="flex justify-between gap-sm pt-md" style={{ marginTop: 'auto' }}>
                                            <button
                                                onClick={() => handleEdit(po)}
                                                className="btn btn-outline"
                                                style={{ padding: '0.4rem 0.8rem', fontSize: '0.9rem' }}
                                            >
                                                <Edit2 size={16} /> Edit
                                            </button>
                                            {user.role === 'admin' && (
                                                <button
                                                    onClick={() => handleDelete(po.id)}
                                                    className="btn btn-danger"
                                                    style={{ padding: '0.4rem 0.8rem', fontSize: '0.9rem', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)' }}
                                                >
                                                    <Trash2 size={16} /> Delete
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                                ))}
                            </div>
                            {(hasMore || canShowLess) && (
                                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
                                    {hasMore && (
                                        <button
                                            type="button"
                                            className="btn btn-outline"
                                            onClick={() => showMoreForVendor(vendor, items.length)}
                                            style={{ padding: '0.4rem 0.9rem', fontSize: '0.9rem' }}
                                        >
                                            Show more
                                        </button>
                                    )}
                                    {canShowLess && (
                                        <button
                                            type="button"
                                            className="btn btn-outline"
                                            onClick={() => resetVendorCount(vendor)}
                                            style={{ padding: '0.4rem 0.9rem', fontSize: '0.9rem' }}
                                        >
                                            Show less
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
                    );
                })()
            ))}

            {selectedPo && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(15, 23, 42, 0.35)',
                        zIndex: 40
                    }}
                    onClick={() => setSelectedPo(null)}
                >
                    <div
                        style={{
                            position: 'absolute',
                            right: 0,
                            top: 0,
                            height: '100%',
                            width: '420px',
                            maxWidth: '92vw',
                            background: 'var(--surface)',
                            borderLeft: '1px solid var(--border)',
                            boxShadow: '-12px 0 24px rgba(15, 23, 42, 0.12)',
                            padding: '1.5rem',
                            overflowY: 'auto'
                        }}
                        onClick={(event) => event.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                            <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>PO Details</div>
                            <button
                                type="button"
                                onClick={() => setSelectedPo(null)}
                                className="btn btn-outline"
                                style={{ padding: '0.35rem 0.7rem', fontSize: '0.85rem' }}
                            >
                                Close
                            </button>
                        </div>

                        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                            {['details', 'history', 'attachments'].map((tab) => (
                                <button
                                    key={tab}
                                    type="button"
                                    onClick={() => setDrawerTab(tab)}
                                    className={drawerTab === tab ? 'btn btn-primary' : 'btn btn-outline'}
                                    style={{ padding: '0.35rem 0.75rem', fontSize: '0.85rem' }}
                                >
                                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                </button>
                            ))}
                        </div>

                        {drawerTab === 'details' && (
                            <div style={{ display: 'grid', gap: '0.75rem' }}>
                                <div><strong>PO Number:</strong> {selectedPo.po_number || '-'}</div>
                                <div><strong>Vendor:</strong> {selectedPo.vendor_name || 'No Vendor Specified'}</div>
                                <div><strong>Status:</strong> {selectedPo.status || '-'}</div>
                                <div><strong>PO Amount:</strong> ₹{parseFloat(selectedPo.total_budget || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                                <div><strong>PO Date:</strong> {formatDate(selectedPo.po_date)}</div>
                                <div><strong>Buyer Name:</strong> {selectedPo.buyer_name || '-'}</div>
                                <div><strong>Buyer Email:</strong> {selectedPo.buyer_email || '-'}</div>
                                <div><strong>Supplier Code:</strong> {selectedPo.supplier_code || '-'}</div>
                                <div><strong>Supplier Address:</strong> {selectedPo.supplier_address || '-'}</div>
                            </div>
                        )}

                        {drawerTab === 'history' && (
                            <div className="text-muted" style={{ fontSize: '0.95rem' }}>
                                No history available yet.
                            </div>
                        )}

                        {drawerTab === 'attachments' && (
                            <div className="text-muted" style={{ fontSize: '0.95rem' }}>
                                No attachments available yet.
                            </div>
                        )}
                    </div>
                </div>
            )}

            {loading && <div className="text-center" style={{ padding: '3rem' }}><div className="spinner" style={{ margin: '0 auto' }}></div></div>}
            {!loading && filteredPOs.length === 0 && (
                <div className="text-center text-muted" style={{ padding: '3rem', background: 'rgba(255,255,255,0.5)', borderRadius: 'var(--radius-lg)' }}>
                    <p style={{ fontSize: '1.2rem', fontWeight: 500 }}>No Purchase Orders found.</p>
                    <p>Click "Add New PO" to get started.</p>
                </div>
            )}

            {/* Modal */}
            {showModal && (
                <div className="app-modal-backdrop">
                    <div className="app-modal app-modal-sm slide-in-right" style={{ maxWidth: '500px' }}>
                        <h2 className="mb-lg" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
                            {editingPo ? 'Edit Purchase Order' : 'Add New Purchase Order'}
                        </h2>

                        <form onSubmit={handleSubmit}>
                            <div className="input-group">
                                <label className="input-label">PO Number *</label>
                                <input
                                    type="text"
                                    required
                                    className="input-field"
                                    value={formData.poNumber}
                                    onChange={e => setFormData({ ...formData, poNumber: e.target.value })}
                                    placeholder="e.g. PO-2024-001"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">PO Amount (₹) *</label>
                                <input
                                    type="number"
                                    required
                                    step="0.01"
                                    className="input-field"
                                    value={formData.totalBudget}
                                    onChange={e => setFormData({ ...formData, totalBudget: e.target.value })}
                                    placeholder="0.00"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Vendor Name</label>
                                <select
                                    className="input-field"
                                    value={formData.vendorName}
                                    onChange={e => handleVendorSelection(e.target.value)}
                                >
                                    <option value="">Select Vendor</option>
                                    {poVendorOptions.map((vendor) => (
                                        <option key={vendor} value={vendor}>{vendor}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Buyer Name</label>
                                <input
                                    type="text"
                                    className="input-field"
                                    value={formData.buyerName}
                                    onChange={e => setFormData({ ...formData, buyerName: e.target.value })}
                                    placeholder="e.g. Jignesh Shah"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Buyer Email</label>
                                <input
                                    type="email"
                                    className="input-field"
                                    value={formData.buyerEmail}
                                    onChange={e => setFormData({ ...formData, buyerEmail: e.target.value })}
                                    placeholder="buyer@example.com"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Supplier Code</label>
                                <input
                                    type="text"
                                    className="input-field"
                                    value={formData.supplierCode}
                                    onChange={e => setFormData({ ...formData, supplierCode: e.target.value })}
                                    placeholder="e.g. ALLW003"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Supplier Address</label>
                                <textarea
                                    className="input-field"
                                    rows="3"
                                    value={formData.supplierAddress}
                                    onChange={e => setFormData({ ...formData, supplierAddress: e.target.value })}
                                    placeholder="Full supplier address (will appear on JCC PDF)"
                                    style={{ resize: 'vertical' }}
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">PO Date</label>
                                <DatePicker
                                    value={formData.poDate}
                                    onChange={e => setFormData({ ...formData, poDate: e.target.value })}
                                />
                            </div>

                            {editingPo && (
                                <div className="input-group">
                                    <label className="input-label">Status</label>
                                    <select
                                        className="input-field"
                                        value={formData.status}
                                        onChange={e => setFormData({ ...formData, status: e.target.value })}
                                    >
                                        <option value="active">Active</option>
                                        <option value="closed">Closed</option>
                                        <option value="hold">Hold</option>
                                    </select>
                                </div>
                            )}

                            <div className="flex justify-between gap-md mt-xl">
                                <button
                                    type="button"
                                    onClick={() => setShowModal(false)}
                                    className="btn btn-outline"
                                    style={{ flex: 1, justifyContent: 'center' }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="btn btn-primary"
                                    style={{ flex: 1, justifyContent: 'center' }}
                                >
                                    {editingPo ? 'Update PO' : 'Create PO'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

        </div>
    );
};

export default PurchaseOrderPage;
