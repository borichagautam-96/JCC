import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const INITIAL_FORM_DATA = {
    bpId: '',
    bpName: '',
    city: '',
    country: '',
    ndaDate: '',
    ndaExpiryDate: '',
    ndaPeriodYear: '',
    projectName: '',
    signedHardCopyDepositoryLocation: '',
    signedHardCopyDepositoryLocationFp: '',
    itemType: '',
    path: '',
    vendorCode: '',
    mailId: ''
};

const compactStyles = `
    .vendor-compact .vendor-layout-grid {
        grid-template-columns: minmax(350px, 390px) minmax(0, 1fr);
        gap: 1.2rem;
        align-items: start;
    }

    .vendor-compact .vendor-form-card {
        min-width: 350px;
        max-width: 390px;
        width: 100%;
        overflow-x: hidden;
    }

    .vendor-compact .vendor-list-card {
        min-width: 0;
    }

    .vendor-compact .vendor-table-wrap {
        min-width: 0;
        overflow: auto;
    }

    .vendor-compact .input-group {
        margin-bottom: 0.8rem;
    }

    .vendor-compact .input-label {
        font-size: 0.82rem;
        margin-bottom: 0.3rem;
    }

    .vendor-compact .input-field {
        min-height: 40px;
        padding: 0.52rem 0.7rem;
        font-size: 0.92rem;
    }

    .vendor-compact .btn {
        padding: 0.52rem 0.9rem;
        font-size: 0.9rem;
    }

    .vendor-compact .table th,
    .vendor-compact .table td {
        padding: 0.58rem 0.5rem;
        font-size: 0.82rem;
        line-height: 1.35;
        vertical-align: middle;
    }

    .vendor-compact .table th {
        min-width: 90px;
        white-space: normal;
    }

    .vendor-compact .table td {
        white-space: nowrap;
    }

    .vendor-compact .table td:nth-child(3),
    .vendor-compact .table td:nth-child(10),
    .vendor-compact .table td:nth-child(11) {
        min-width: 160px;
        white-space: normal;
    }

    .vendor-compact h3 {
        font-size: 1.18rem;
    }

    @media (max-width: 1200px) {
        .vendor-compact .vendor-layout-grid {
            grid-template-columns: 1fr;
        }

        .vendor-compact .vendor-form-card {
            min-width: 0;
            max-width: none;
        }
    }
`;

const VendorManagementPage = () => {
    const { getToken } = useAuth();
    const dialog = useDialog();

    const [vendors, setVendors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [query, setQuery] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [importing, setImporting] = useState(false);
    const excelInputRef = useRef(null);

    const [formData, setFormData] = useState(INITIAL_FORM_DATA);

    const authHeaders = () => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
    });

    const parseJsonSafe = async (response) => {
        try {
            const text = await response.text();
            if (!text) {
                return null;
            }

            try {
                return JSON.parse(text);
            } catch {
                return { error: text };
            }
        } catch {
            return null;
        }
    };

    const fetchVendors = async () => {
        setLoading(true);
        try {
            const response = await fetch('/api/vendors', {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                }
            });

            if (response.status === 401) {
                globalThis.location.href = '/login';
                return;
            }

            const data = await parseJsonSafe(response);
            if (!response.ok) {
                throw new Error(data?.error || `Failed to fetch vendors (${response.status})`);
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

    const updateField = (field, value) => {
        setFormData((prev) => ({ ...prev, [field]: value }));
    };

    const filteredVendors = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const sortedVendors = [...vendors].sort((left, right) => {
            const leftName = String(left.bp_name || left.vendor_name || '').trim().toLowerCase();
            const rightName = String(right.bp_name || right.vendor_name || '').trim().toLowerCase();

            if (leftName === rightName) {
                return Number(left.id || 0) - Number(right.id || 0);
            }

            return leftName.localeCompare(rightName);
        });

        if (!needle) return sortedVendors;
        return sortedVendors.filter((vendor) => {
            const searchableFields = [
                vendor.id,
                vendor.bp_id,
                vendor.bp_name,
                vendor.vendor_name,
                vendor.city,
                vendor.country,
                vendor.nda_date,
                vendor.nda_expiry_date,
                vendor.nda_period_year,
                vendor.project_name,
                vendor.signed_hard_copy_depository_location,
                vendor.signed_hard_copy_depository_location_fp,
                vendor.item_type,
                vendor.vendor_path,
                vendor.vendor_code,
                vendor.mail_id,
            ];

            return searchableFields.some((field) => String(field || '').toLowerCase().includes(needle));
        });
    }, [query, vendors]);

    const handleCreateVendor = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        const payload = {
            vendorName: String(formData.bpName || '').trim(),
            vendorCode: String(formData.vendorCode || '').trim(),
            address: '',
            contactNumber: '',
            mailId: String(formData.mailId || '').trim(),
            bpId: String(formData.bpId || '').trim(),
            bpName: String(formData.bpName || '').trim(),
            city: String(formData.city || '').trim(),
            country: String(formData.country || '').trim(),
            ndaDate: String(formData.ndaDate || '').trim(),
            ndaExpiryDate: String(formData.ndaExpiryDate || '').trim(),
            ndaPeriodYear: String(formData.ndaPeriodYear || '').trim(),
            projectName: String(formData.projectName || '').trim(),
            signedHardCopyDepositoryLocation: String(formData.signedHardCopyDepositoryLocation || '').trim(),
            signedHardCopyDepositoryLocationFp: String(formData.signedHardCopyDepositoryLocationFp || '').trim(),
            itemType: String(formData.itemType || '').trim(),
            path: String(formData.path || '').trim(),
        };

        if (!payload.bpName) {
            setError('BP Name is required');
            return;
        }

        setSaving(true);
        try {
            const response = await fetch('/api/vendors', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(payload)
            });

            if (response.status === 401) {
                globalThis.location.href = '/login';
                return;
            }

            const data = await parseJsonSafe(response);
            if (!response.ok) {
                throw new Error(data?.error || `Failed to create vendor (${response.status})`);
            }

            setSuccess(`Vendor entry added successfully (${data.vendorCode || 'auto code'})`);
            setFormData(INITIAL_FORM_DATA);
            await fetchVendors();
        } catch (saveError) {
            setError(saveError.message || 'Failed to create vendor');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteVendor = async (vendor) => {
        const vendorDisplayName = vendor.bp_name || vendor.vendor_name || vendor.bp_id || `ID ${vendor.id}`;
        const confirmed = await dialog.confirm(`Delete vendor "${vendorDisplayName}"?`);
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

            if (response.status === 401) {
                globalThis.location.href = '/login';
                return;
            }

            const data = await parseJsonSafe(response);
            if (!response.ok) {
                throw new Error(data?.error || `Failed to delete vendor (${response.status})`);
            }

            setSuccess('Vendor deleted successfully');
            await fetchVendors();
        } catch (deleteError) {
            setError(deleteError.message || 'Failed to delete vendor');
        }
    };

    const handleImportVendors = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setError('');
        setSuccess('');
        setImporting(true);

        try {
            const formData = new FormData();
            formData.append('vendorFile', file);

            const response = await fetch('/api/vendors/import', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: formData,
            });

            if (response.status === 401) {
                globalThis.location.href = '/login';
                return;
            }

            const data = await parseJsonSafe(response);
            if (!response.ok) {
                throw new Error(data?.error || `Failed to import vendors (${response.status})`);
            }

            setSuccess(`Import complete: ${data.inserted} added, ${data.skipped} skipped.`);
            await fetchVendors();
        } catch (importError) {
            setError(importError.message || 'Failed to import vendors');
        } finally {
            setImporting(false);
            if (excelInputRef.current) {
                excelInputRef.current.value = '';
            }
        }
    };

    return (
        <div className="container vendor-compact" style={{ paddingTop: '1.4rem', paddingBottom: '1.4rem', maxWidth: '1440px' }}>
            <style>{compactStyles}</style>
            <div className="fade-in">
                <div style={{
                background: '#fff',
                color: 'white',
                padding: '1.15rem 1.5rem',
                borderRadius: '0.9rem',
                marginBottom: '1.25rem',
                border: '1px solid #e2e8f0',
                }}>
                    <h1 style={{ margin: 0, fontSize: '1.6rem', color: 'black' }}>Vendor Management</h1>
                    <p style={{ margin: '0.4rem 0 0 0', opacity: 0.9, color: 'black', fontSize: '0.98rem' }}>Manage vendor BP, NDA and project metadata in one place</p>
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

                <div className="card-grid vendor-layout-grid">
                    <div className="glass-card vendor-form-card" style={{ background: 'white', border: '1px solid #E0E0E0', alignSelf: 'start', height: '590px', overflowY: 'auto' }}>
                        <h3 style={{ marginTop: 0, marginBottom: '1rem', color: '#0F172A' }}>Add Vendor Entry</h3>
                        <div style={{ marginBottom: '1rem' }}>
                            <input
                                ref={excelInputRef}
                                type="file"
                                accept=".xlsx,.xls"
                                onChange={handleImportVendors}
                                style={{ display: 'none' }}
                            />
                            <button
                                type="button"
                                className="btn btn-outline"
                                onClick={() => excelInputRef.current?.click()}
                                disabled={importing}
                                style={{ width: '100%' }}
                            >
                                {importing ? 'Importing vendors...' : 'Upload Excel (Vendor NDA List)'}
                            </button>
                            <small style={{ display: 'block', marginTop: '0.5rem', color: '#64748b' }}>
                                Upload .xlsx/.xls with fields like BP ID, BP Name, City, Country, NDA dates and project details.
                            </small>
                        </div>
                        <form onSubmit={handleCreateVendor}>
                            <div className="input-group">
                                <label className="input-label" htmlFor="bp-id-input">BP ID</label>
                                <input
                                    id="bp-id-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.bpId}
                                    onChange={(e) => updateField('bpId', e.target.value)}
                                    placeholder="Enter BP ID"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="bp-name-input">BP Name *</label>
                                <input
                                    id="bp-name-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.bpName}
                                    onChange={(e) => updateField('bpName', e.target.value)}
                                    placeholder="Enter BP Name"
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="city-input">City</label>
                                <input
                                    id="city-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.city}
                                    onChange={(e) => updateField('city', e.target.value)}
                                    placeholder="Enter city"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="country-input">Country</label>
                                <input
                                    id="country-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.country}
                                    onChange={(e) => updateField('country', e.target.value)}
                                    placeholder="Enter country"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="nda-date-input">Date of NDA</label>
                                <input
                                    id="nda-date-input"
                                    type="date"
                                    className="input-field"
                                    value={formData.ndaDate}
                                    onChange={(e) => updateField('ndaDate', e.target.value)}
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="nda-expiry-date-input">Expiry date of NDA</label>
                                <input
                                    id="nda-expiry-date-input"
                                    type="date"
                                    className="input-field"
                                    value={formData.ndaExpiryDate}
                                    onChange={(e) => updateField('ndaExpiryDate', e.target.value)}
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="nda-period-year-input">Period Of NDA in Year</label>
                                <input
                                    id="nda-period-year-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.ndaPeriodYear}
                                    onChange={(e) => updateField('ndaPeriodYear', e.target.value)}
                                    placeholder="Enter NDA period"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="project-name-input">Project Name</label>
                                <input
                                    id="project-name-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.projectName}
                                    onChange={(e) => updateField('projectName', e.target.value)}
                                    placeholder="Enter project name"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="signed-location-input">Signed Hard Copy Depository Location</label>
                                <input
                                    id="signed-location-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.signedHardCopyDepositoryLocation}
                                    onChange={(e) => updateField('signedHardCopyDepositoryLocation', e.target.value)}
                                    placeholder="Enter signed copy location"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="signed-location-fp-input">Signed Hard Copy Depository Location FP</label>
                                <input
                                    id="signed-location-fp-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.signedHardCopyDepositoryLocationFp}
                                    onChange={(e) => updateField('signedHardCopyDepositoryLocationFp', e.target.value)}
                                    placeholder="Enter signed copy FP location"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="item-type-input">Item Type</label>
                                <input
                                    id="item-type-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.itemType}
                                    onChange={(e) => updateField('itemType', e.target.value)}
                                    placeholder="Enter item type"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="path-input">Path</label>
                                <input
                                    id="path-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.path}
                                    onChange={(e) => updateField('path', e.target.value)}
                                    placeholder="Enter path"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="vendor-code-input">Code (optional)</label>
                                <input
                                    id="vendor-code-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.vendorCode}
                                    onChange={(e) => updateField('vendorCode', e.target.value)}
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
                                    onChange={(e) => updateField('mailId', e.target.value)}
                                    placeholder="vendor@example.com"
                                />
                            </div>

                            <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%' }}>
                                {saving ? 'Adding...' : 'Add Vendor Entry'}
                            </button>
                        </form>
                    </div>

                    <div className="glass-card vendor-list-card" style={{ background: 'white', border: '1px solid #E0E0E0', height: '590px', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '1rem' }}>
                            <h3 style={{ margin: 0, color: '#0F172A' }}>Vendor List</h3>
                            <input
                                type="text"
                                className="input-field"
                                style={{ maxWidth: '360px' }}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search by BP ID, BP Name, city, project"
                            />
                        </div>

                        {loading ? (
                            <div className="text-center py-xl">
                                <div className="spinner"></div>
                                <p className="mt-md text-muted">Loading vendors...</p>
                            </div>
                        ) : (
                            <div className="table-container vendor-table-wrap" style={{ flex: 1, minHeight: 0 }}>
                                <table className="table">
                                    <thead>
                                        <tr>
                                            <th>ID</th>
                                            <th>BP ID</th>
                                            <th>BP Name</th>
                                            <th>City</th>
                                            <th>Country</th>
                                            <th>Date of NDA</th>
                                            <th>Expiry date of NDA</th>
                                            <th>Period Of NDA in Year</th>
                                            <th>Project Name</th>
                                            <th>Signed Hard Copy Depository Location</th>
                                            <th>Signed Hard Copy Depository Location FP</th>
                                            <th>Item Type</th>
                                            <th>Path</th>
                                            <th>Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredVendors.length === 0 ? (
                                            <tr>
                                                <td colSpan="14" className="text-center" style={{ color: '#64748B' }}>
                                                    No vendors found.
                                                </td>
                                            </tr>
                                        ) : filteredVendors.map((vendor, index) => (
                                            <tr key={vendor.id}>
                                                <td style={{ fontWeight: 600 }}>{index + 1}</td>
                                                <td>{vendor.bp_id || '-'}</td>
                                                <td>{vendor.bp_name || vendor.vendor_name || '-'}</td>
                                                <td>{vendor.city || '-'}</td>
                                                <td>{vendor.country || '-'}</td>
                                                <td>{vendor.nda_date || '-'}</td>
                                                <td>{vendor.nda_expiry_date || '-'}</td>
                                                <td>{vendor.nda_period_year || '-'}</td>
                                                <td>{vendor.project_name || '-'}</td>
                                                <td>{vendor.signed_hard_copy_depository_location || '-'}</td>
                                                <td>{vendor.signed_hard_copy_depository_location_fp || '-'}</td>
                                                <td>{vendor.item_type || '-'}</td>
                                                <td>{vendor.vendor_path || '-'}</td>
                                                <td>
                                                    <button
                                                        type="button"
                                                        className="btn btn-sm"
                                                        style={{ background: '#DC2626', color: 'white', padding: '0.4rem 0.8rem', fontSize: '0.82rem' }}
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
