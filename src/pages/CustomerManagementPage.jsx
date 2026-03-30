import React, { useState, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const CustomerManagementPage = () => {
    const [customers, setCustomers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [showModal, setShowModal] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [formData, setFormData] = useState({
        customer_code: '',
        customer_name: '',
        contact_person: '',
        email: '',
        phone: '',
        address: '',
        city: '',
        state: '',
        pincode: '',
        gst_number: '',
        pan_number: ''
    });
    const [editingId, setEditingId] = useState(null);
    const { getToken } = useAuth();
    const dialog = useDialog();

    useEffect(() => {
        fetchCustomers();
    }, [searchTerm]);

    const fetchCustomers = async () => {
        try {
            const url = searchTerm
                ? `/api/customers?search=${encodeURIComponent(searchTerm)}`
                : '/api/customers';

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                }
            });
            const data = await response.json();
            setCustomers(data.customers || []);
        } catch (error) {
            console.error('Error fetching customers:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleExcelUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setUploading(true);
        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await fetch('/api/customers/upload-excel', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                },
                body: formData
            });

            const data = await response.json();

            if (response.ok) {
                await dialog.alert(`Successfully imported ${data.imported} customers!`);
                fetchCustomers();
            } else {
                await dialog.alert(data.error || 'Failed to upload file');
            }
        } catch (error) {
            console.error('Error uploading file:', error);
            await dialog.alert('Failed to upload Excel file');
        } finally {
            setUploading(false);
            e.target.value = '';
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        const url = editingId ? `/api/customers/${editingId}` : '/api/customers';
        const method = editingId ? 'PUT' : 'POST';

        try {
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
                await dialog.alert(editingId ? 'Customer updated!' : 'Customer created!');
                setShowModal(false);
                setFormData({ customer_code: '', customer_name: '', contact_person: '', email: '', phone: '', address: '', city: '', state: '', pincode: '', gst_number: '', pan_number: '' });
                setEditingId(null);
                fetchCustomers();
            } else {
                const data = await response.json();
                await dialog.alert(data.error || 'Failed to save customer');
            }
        } catch (error) {
            console.error('Error saving customer:', error);
            await dialog.alert('Failed to save customer');
        }
    };

    const handleEdit = (customer) => {
        setFormData(customer);
        setEditingId(customer.id);
        setShowModal(true);
    };

    const handleDelete = async (customerId) => {
        const confirmed = await dialog.confirm('Are you sure you want to delete this customer?');
        if (!confirmed) return;

        try {
            const response = await fetch(`/api/customers/${customerId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                }
            });

            if (response.ok) {
                await dialog.alert('Customer deleted');
                fetchCustomers();
            } else {
                const data = await response.json();
                await dialog.alert(data.error || 'Failed to delete customer');
            }
        } catch (error) {
            console.error('Error deleting customer:', error);
            await dialog.alert('Failed to delete customer');
        }
    };

    if (loading) {
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading customers...</div>;
    }

    return (
        <div style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{
                background: '#0066CC',
                color: 'white',
                padding: '1.5rem 2rem',
                borderRadius: '8px',
                marginBottom: '2rem'
            }}>
                <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'white' }}>Customer Management</h1>
                <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, color: 'white' }}>
                    Manage customer data and import from Concerto Excel files
                </p>
            </div>

            {/* Actions Bar */}
            <div style={{
                background: 'white',
                border: '1px solid #E0E0E0',
                borderRadius: '8px',
                padding: '1.5rem',
                marginBottom: '1.5rem',
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center'
            }}>
                <div style={{ flex: 1, minWidth: '250px' }}>
                    <input
                        type="text"
                        placeholder="Search customers..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '0.75rem',
                            border: '1px solid #D1D5DB',
                            borderRadius: '6px',
                            fontSize: '1rem'
                        }}
                    />
                </div>

                <button
                    onClick={() => {
                        setShowModal(true);
                        setEditingId(null);
                        setFormData({ customer_code: '', customer_name: '', contact_person: '', email: '', phone: '', address: '', city: '', state: '', pincode: '', gst_number: '', pan_number: '' });
                    }}
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: '#10B981',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 600
                    }}
                >
                    + Add Customer
                </button>

                <label style={{
                    padding: '0.75rem 1.5rem',
                    background: '#3B82F6',
                    color: 'white',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 600,
                    display: 'inline-block'
                }}>
                    {uploading ? 'Uploading...' : 'Upload Excel'}
                    <input
                        type="file"
                        accept=".xlsx,.xls"
                        onChange={handleExcelUpload}
                        disabled={uploading}
                        style={{ display: 'none' }}
                    />
                </label>
            </div>

            {/* Customers Table */}
            <div style={{
                background: 'white',
                border: '1px solid #E0E0E0',
                borderRadius: '8px',
                overflow: 'hidden'
            }}>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ background: '#F9FAFB' }}>
                            <tr>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Code</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Name</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Contact</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Email</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Phone</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>City</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {customers.length === 0 ? (
                                <tr>
                                    <td colSpan="7" style={{ textAlign: 'center', padding: '3rem', color: '#999' }}>
                                        No customers found. Upload an Excel file or add manually.
                                    </td>
                                </tr>
                            ) : (
                                customers.map(customer => (
                                    <tr key={customer.id} style={{ borderBottom: '1px solid #F3F4F6' }}>
                                        <td style={{ padding: '1rem', fontFamily: 'monospace', color: '#0066CC' }}>{customer.customer_code}</td>
                                        <td style={{ padding: '1rem', fontWeight: 600 }}>{customer.customer_name}</td>
                                        <td style={{ padding: '1rem' }}>{customer.contact_person || '-'}</td>
                                        <td style={{ padding: '1rem' }}>{customer.email || '-'}</td>
                                        <td style={{ padding: '1rem' }}>{customer.phone || '-'}</td>
                                        <td style={{ padding: '1rem' }}>{customer.city || '-'}</td>
                                        <td style={{ padding: '1rem' }}>
                                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                <button
                                                    onClick={() => handleEdit(customer)}
                                                    style={{
                                                        padding: '0.375rem 0.75rem',
                                                        background: '#3B82F6',
                                                        color: 'white',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        cursor: 'pointer',
                                                        fontSize: '0.875rem',
                                                        fontWeight: 600
                                                    }}
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(customer.id)}
                                                    style={{
                                                        padding: '0.375rem 0.75rem',
                                                        background: '#EF4444',
                                                        color: 'white',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        cursor: 'pointer',
                                                        fontSize: '0.875rem',
                                                        fontWeight: 600
                                                    }}
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Add/Edit Modal */}
            {showModal && (
                <div className="app-modal-backdrop">
                    <div className="app-modal app-modal-md" style={{ maxWidth: '600px' }}>
                        <h2 className="app-modal-title">{editingId ? 'Edit Customer' : 'Add Customer'}</h2>
                        <form onSubmit={handleSubmit}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Customer Code *</label>
                                    <input
                                        type="text"
                                        value={formData.customer_code}
                                        onChange={(e) => setFormData({ ...formData, customer_code: e.target.value })}
                                        required
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Customer Name *</label>
                                    <input
                                        type="text"
                                        value={formData.customer_name}
                                        onChange={(e) => setFormData({ ...formData, customer_name: e.target.value })}
                                        required
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Contact Person</label>
                                    <input
                                        type="text"
                                        value={formData.contact_person}
                                        onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Email</label>
                                    <input
                                        type="email"
                                        value={formData.email}
                                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Phone</label>
                                    <input
                                        type="text"
                                        value={formData.phone}
                                        onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>City</label>
                                    <input
                                        type="text"
                                        value={formData.city}
                                        onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>State</label>
                                    <input
                                        type="text"
                                        value={formData.state}
                                        onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Pincode</label>
                                    <input
                                        type="text"
                                        value={formData.pincode}
                                        onChange={(e) => setFormData({ ...formData, pincode: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>GST Number</label>
                                    <input
                                        type="text"
                                        value={formData.gst_number}
                                        onChange={(e) => setFormData({ ...formData, gst_number: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>PAN Number</label>
                                    <input
                                        type="text"
                                        value={formData.pan_number}
                                        onChange={(e) => setFormData({ ...formData, pan_number: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                            </div>
                            <div style={{ gridColumn: '1 / -1' }}>
                                <label style={{ display: 'block', marginBottom: '0.5rem', marginTop: '1rem', fontWeight: 600 }}>Address</label>
                                <textarea
                                    value={formData.address}
                                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                                    rows="3"
                                    style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                />
                            </div>
                            <div className="app-modal-actions">
                                <button type="submit" className="btn btn-success">
                                    {editingId ? 'Update' : 'Create'}
                                </button>
                                <button type="button" className="btn btn-outline" onClick={() => {
                                    setShowModal(false);
                                    setEditingId(null);
                                    setFormData({ customer_code: '', customer_name: '', contact_person: '', email: '', phone: '', address: '', city: '', state: '', pincode: '', gst_number: '', pan_number: '' });
                                }}>
                                    Cancel
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default CustomerManagementPage;
