import React, { useState, useEffect, useMemo } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { Plus, Edit2, Trash2, Search, FileText } from 'lucide-react';
import { getVendorNames } from '../utils/vendorList';

const PurchaseOrderPage = () => {
    const { getToken, user } = useAuth();
    const dialog = useDialog();
    const [purchaseOrders, setPurchaseOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [showModal, setShowModal] = useState(false);
    const [editingPo, setEditingPo] = useState(null);
    const [supplierOptions, setSupplierOptions] = useState([]);

    const [formData, setFormData] = useState({
        poNumber: '',
        supplierCode: '',
        supplierAddress: '',
        vendorName: '',
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
            totalBudget: po.total_budget,
            poDate: po.po_date || '',
            status: po.status
        });
        setShowModal(true);
    };

    const filteredPOs = purchaseOrders.filter(po =>
        po.po_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (po.vendor_name && po.vendor_name.toLowerCase().includes(searchTerm.toLowerCase()))
    );

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
                background: '#fff',
                border: '1px solid #e2e8f0',
                borderRadius: '0.9rem',
                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.05)'
            }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'black' }}>PO Management</h1>
                    <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, color: 'black' }}>Track Purchase Orders and Budget Utilization</p>
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
            <div className="glass-card mb-xl">
                <div className="input-group" style={{ marginBottom: 0 }}>
                    <div style={{ position: 'relative' }}>
                        <Search size={20} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                        <input
                            type="text"
                            placeholder="Search by PO Number or Vendor..."
                            className="input-field"
                            style={{ paddingLeft: '3rem' }}
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            {/* PO List */}
            <div className="card-grid">
                {filteredPOs.map((po) => (
                    <div key={po.id} className="glass-card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        <div className="flex justify-between items-start mb-md">
                            <div>
                                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.25rem' }}>
                                    <FileText size={20} color="var(--primary)" />
                                    {po.po_number}
                                </h3>
                                <p className="text-muted" style={{ fontSize: '0.9rem', marginTop: '0.25rem' }}>{po.vendor_name || 'No Vendor Specified'}</p>
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
                                <span>{po.po_date ? new Date(po.po_date).toLocaleDateString() : '-'}</span>
                            </div>
                            {po.supplier_code && (
                                <div className="flex justify-between mt-sm" style={{ fontSize: '0.95rem' }}>
                                    <span className="text-muted">Supplier Code:</span>
                                    <span style={{ fontWeight: 600 }}>{po.supplier_code}</span>
                                </div>
                            )}
                            {po.supplier_address && (
                                <p className="text-muted" style={{ fontSize: '0.9rem', marginTop: '0.5rem', fontStyle: 'italic', whiteSpace: 'pre-line' }}>
                                    {po.supplier_address}
                                </p>
                            )}
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
                                <input
                                    type="date"
                                    className="input-field"
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
