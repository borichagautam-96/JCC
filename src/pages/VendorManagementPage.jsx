import React, { useEffect, useMemo, useState } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const VendorManagementPage = () => {
    const { getToken } = useAuth();
    const dialog = useDialog();

    const [vendors, setVendors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [query, setQuery] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    const [formData, setFormData] = useState({
        vendorName: '',
        vendorCode: '',
        address: '',
        contactNumber: '',
        mailId: ''
    });

    const authHeaders = () => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
    });

    const fetchVendors = async () => {
        setLoading(true);
        try {
            const response = await fetch('/api/vendors', {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                }
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to fetch vendors');
            }
            setVendors(Array.isArray(data) ? data : []);
        } catch (fetchError) {
            setError(fetchError.message || 'Failed to fetch vendors');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchVendors();
    }, []);

    const filteredVendors = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return vendors;
        return vendors.filter((vendor) => {
            const name = String(vendor.vendor_name || '').toLowerCase();
            const code = String(vendor.vendor_code || '').toLowerCase();
            const mail = String(vendor.mail_id || '').toLowerCase();
            return name.includes(needle) || code.includes(needle) || mail.includes(needle);
        });
    }, [query, vendors]);

    const handleCreateVendor = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        const payload = {
            vendorName: String(formData.vendorName || '').trim(),
            vendorCode: String(formData.vendorCode || '').trim(),
            address: String(formData.address || '').trim(),
            contactNumber: String(formData.contactNumber || '').trim(),
            mailId: String(formData.mailId || '').trim(),
        };

        if (!payload.vendorName) {
            setError('Vendor name is required');
            return;
        }

        setSaving(true);
        try {
            const response = await fetch('/api/vendors', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to create vendor');
            }

            setSuccess(`Vendor added successfully (${data.vendorCode || 'auto code'})`);
            setFormData({ vendorName: '', vendorCode: '', address: '', contactNumber: '', mailId: '' });
            await fetchVendors();
        } catch (saveError) {
            setError(saveError.message || 'Failed to create vendor');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteVendor = async (vendor) => {
        const confirmed = await dialog.confirm(`Delete vendor "${vendor.vendor_name}"?`);
        if (!confirmed) return;

        setError('');
        setSuccess('');
        try {
            const response = await fetch(`/api/vendors/${vendor.id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                }
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to delete vendor');
            }

            setSuccess('Vendor deleted successfully');
            await fetchVendors();
        } catch (deleteError) {
            setError(deleteError.message || 'Failed to delete vendor');
        }
    };

    return (
        <div className="container" style={{ paddingTop: 'var(--spacing-2xl)', paddingBottom: 'var(--spacing-2xl)' }}>
            <div className="fade-in">
                <div style={{
                background: '#fff',
                color: 'white',
                padding: '1.5rem 2rem',
                borderRadius: '0.9rem',
                marginBottom: '2rem',
                border: '1px solid #e2e8f0',
                }}>
                    <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'black' }}>Vendor Management</h1>
                    <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, color: 'black' }}>Manage all supplier names from one place</p>
                </div>

                {success && (
                    <div style={{
                        padding: '1rem',
                        background: 'rgba(16, 185, 129, 0.1)',
                        border: '1px solid #10B981',
                        borderRadius: '8px',
                        marginBottom: '1rem',
                        color: '#047857'
                    }}>
                        {success}
                    </div>
                )}

                {error && (
                    <div style={{
                        padding: '1rem',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid #EF4444',
                        borderRadius: '8px',
                        marginBottom: '1rem',
                        color: '#B91C1C'
                    }}>
                        {error}
                    </div>
                )}

                <div className="card-grid" style={{ gridTemplateColumns: '1fr 1.6fr', gap: '1.5rem', alignItems: 'start' }}>
                    <div className="glass-card" style={{ background: 'white', border: '1px solid #E0E0E0', alignSelf: 'start' }}>
                        <h3 style={{ marginTop: 0, marginBottom: '1rem', color: '#0F172A' }}>Add Vendor</h3>
                        <form onSubmit={handleCreateVendor}>
                            <div className="input-group">
                                <label className="input-label" htmlFor="vendor-name-input">Vendor Name *</label>
                                <input
                                    id="vendor-name-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.vendorName}
                                    onChange={(e) => setFormData((prev) => ({ ...prev, vendorName: e.target.value }))}
                                    placeholder="Enter vendor name"
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="vendor-code-input">Vendor Code (optional)</label>
                                <input
                                    id="vendor-code-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.vendorCode}
                                    onChange={(e) => setFormData((prev) => ({ ...prev, vendorCode: e.target.value }))}
                                    placeholder="Leave blank for auto-generate"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="vendor-email-input">Email (optional)</label>
                                <input
                                    id="vendor-email-input"
                                    type="email"
                                    className="input-field"
                                    value={formData.mailId}
                                    onChange={(e) => setFormData((prev) => ({ ...prev, mailId: e.target.value }))}
                                    placeholder="vendor@example.com"
                                />
                            </div>

                            <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%' }}>
                                {saving ? 'Adding...' : 'Add Vendor'}
                            </button>
                        </form>
                    </div>

                    <div className="glass-card" style={{ background: 'white', border: '1px solid #E0E0E0', height: '620px', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '1rem' }}>
                            <h3 style={{ margin: 0, color: '#0F172A' }}>Vendor List</h3>
                            <input
                                type="text"
                                className="input-field"
                                style={{ maxWidth: '280px' }}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search vendor"
                            />
                        </div>

                        {loading ? (
                            <div className="text-center py-xl">
                                <div className="spinner"></div>
                                <p className="mt-md text-muted">Loading vendors...</p>
                            </div>
                        ) : (
                            <div className="table-container" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                                <table className="table">
                                    <thead>
                                        <tr>
                                            <th>Vendor Name</th>
                                            <th>Code</th>
                                            <th>Email</th>
                                            <th>Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredVendors.length === 0 ? (
                                            <tr>
                                                <td colSpan="4" className="text-center" style={{ color: '#64748B' }}>
                                                    No vendors found.
                                                </td>
                                            </tr>
                                        ) : filteredVendors.map((vendor) => (
                                            <tr key={vendor.id}>
                                                <td style={{ fontWeight: 600 }}>{vendor.vendor_name}</td>
                                                <td>{vendor.vendor_code || '-'}</td>
                                                <td>{vendor.mail_id || '-'}</td>
                                                <td>
                                                    <button
                                                        type="button"
                                                        className="btn btn-sm"
                                                        style={{ background: '#DC2626', color: 'white' }}
                                                        onClick={() => handleDeleteVendor(vendor)}
                                                    >
                                                        Delete
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default VendorManagementPage;
