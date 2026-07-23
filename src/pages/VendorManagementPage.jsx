import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const INITIAL_FORM_DATA = {
    vendorName: '',
    vendorCode: '',
    address: '',
    mailId: ''
};

const TEMP_ALLOWED_VENDOR_NAMES = [
    'ALLWYN JUMBO PRINTS AND EXCHANGER PVT LTD',
    'Armoured Vehicles Nigam Limited',
    'Asha Furniture Works',
    'Balaji Arts',
    'Bharat Electronics Limited',
    'CHANDRAHAS SHETTY',
    'DDSPLM Pvt. Ltd.',
    'Delos Consulting Pvt. Ltd.',
    'DesignTech Systems Pvt. Ltd.',
    'GenieHR Solutions Pvt. Ltd.',
    'Global Publishing Solutions Ltd.',
    'Hornbill Studios Pvt Ltd',
    'JUSTVFX STUDIOS',
    'LOUISCIAGA OVERSEAS PVT. LTD',
    'MICROPOINT COMPUTERS PRIVATE LIMITED',
    'Pentagon System And Services Pvt. Ltd',
    'PEREVODRU',
    'PEREVODRU GLOBAL TRANSLATION SERVICES',
    'Pixlar Art Creation',
    'RAC IT SOLUTIONS PVT. LTD.',
    'Schneider Electric India Pvt. Limited (SEIPL)',
    'Shezarweb Technologies',
    'Shivam Computers',
    'SIEMENS INDUSTRY SOFTWARE (INDIA)',
    'Smartify Software Solutions LLP',
    'Somshanti Enterprises',
    'Urgent Courier',
    'Vendor Name',
    'Voice Kraft Productions',
    'White Globe Pvt. Ltd.',
    'Track On Courier',
];

const normalizeVendorName = (value) => String(value || '').trim().toLowerCase();

const TEMP_ALLOWED_VENDOR_NAME_INDEX = TEMP_ALLOWED_VENDOR_NAMES.reduce((map, name, index) => {
    map.set(normalizeVendorName(name), index);
    return map;
}, new Map());

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

    .vendor-compact .table td:nth-child(2),
    .vendor-compact .table td:nth-child(4) {
        min-width: 160px;
        white-space: normal;
    }

    .vendor-compact .vendor-meta {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.78rem;
        color: var(--text-body);
        white-space: normal;
    }

    .vendor-compact .vendor-meta-label {
        font-weight: 600;
        color: var(--text-strong);
        margin-right: 0.35rem;
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

    const entitySingular = 'Vendor';
    const entityPlural = 'Vendors';
    const entitySingularLower = entitySingular.toLowerCase();
    const entityPluralLower = entityPlural.toLowerCase();

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
                throw new Error(data?.error || `Failed to fetch ${entityPluralLower} (${response.status})`);
            }
            setVendors(Array.isArray(data) ? data : []);
        } catch (fetchError) {
            setError(fetchError.message || `Failed to fetch ${entityPluralLower}`);
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
            const leftName = normalizeVendorName(left.bp_name || left.vendor_name);
            const rightName = normalizeVendorName(right.bp_name || right.vendor_name);

            const leftOrder = TEMP_ALLOWED_VENDOR_NAME_INDEX.get(leftName) ?? Number.MAX_SAFE_INTEGER;
            const rightOrder = TEMP_ALLOWED_VENDOR_NAME_INDEX.get(rightName) ?? Number.MAX_SAFE_INTEGER;

            if (leftOrder !== rightOrder) {
                return leftOrder - rightOrder;
            }

            if (leftName === rightName) {
                return Number(left.id || 0) - Number(right.id || 0);
            }

            return leftName.localeCompare(rightName);
        });

        if (!needle) return sortedVendors;
        return sortedVendors.filter((vendor) => {
            const searchableFields = [
                vendor.id,
                vendor.vendor_name,
                vendor.vendor_code,
                vendor.address,
                vendor.mail_id,
                vendor.bp_id,
                vendor.bp_name,
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
            ];

            return searchableFields.some((field) => String(field || '').toLowerCase().includes(needle));
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
            contactNumber: '',
            mailId: String(formData.mailId || '').trim(),
        };

        if (!payload.vendorName) {
            setError(`${entitySingular} is required`);
            return;
        }

        if (!payload.vendorCode) {
            setError(`${entitySingular} code is required`);
            return;
        }

        if (!payload.address) {
            setError(`${entitySingular} address is required`);
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
                throw new Error(data?.error || `Failed to create ${entitySingularLower} (${response.status})`);
            }

            setSuccess(`${entitySingular} entry added successfully (${data.vendorCode})`);
            setFormData(INITIAL_FORM_DATA);
            await fetchVendors();
        } catch (saveError) {
            setError(saveError.message || `Failed to create ${entitySingularLower}`);
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteVendor = async (vendor) => {
        const vendorDisplayName = vendor.vendor_name || vendor.bp_name || `ID ${vendor.id}`;
        const confirmed = await dialog.confirm(`Delete ${entitySingularLower} "${vendorDisplayName}"?`);
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
                throw new Error(data?.error || `Failed to delete ${entitySingularLower} (${response.status})`);
            }

            setSuccess(`${entitySingular} deleted successfully`);
            await fetchVendors();
        } catch (deleteError) {
            setError(deleteError.message || `Failed to delete ${entitySingularLower}`);
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
                throw new Error(data?.error || `Failed to import ${entityPluralLower} (${response.status})`);
            }

            setSuccess(`Import complete: ${data.inserted} added, ${data.skipped} skipped.`);
            await fetchVendors();
        } catch (importError) {
            setError(importError.message || `Failed to import ${entityPluralLower}`);
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
                background: 'var(--surface)',
                color: 'white',
                padding: '1.15rem 1.5rem',
                borderRadius: '0.9rem',
                marginBottom: '1.25rem',
                border: '1px solid var(--border)',
                }}>
                    <h1 style={{ margin: 0, fontSize: '1.6rem', color: 'var(--text-strong)' }}>{entitySingular} Management</h1>
                    <p style={{ margin: '0.4rem 0 0 0', opacity: 0.9, color: 'var(--text-strong)', fontSize: '0.98rem' }}>Manage core {entitySingularLower} details in one place</p>
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
                    <div className="glass-card vendor-form-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', alignSelf: 'start', height: '590px', overflowY: 'auto' }}>
                        <h3 style={{ marginTop: 0, marginBottom: '1rem', color: 'var(--text-strong)' }}>Add {entitySingular} Entry</h3>
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
                                {importing ? `Importing ${entityPluralLower}...` : `Upload Excel (${entitySingular} List)`}
                            </button>
                            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-muted)' }}>
                                Upload .xlsx/.xls with columns like {entitySingular} Name, {entitySingular} ID, {entitySingular} Address and Email ID.
                            </small>
                        </div>
                        <form onSubmit={handleCreateVendor}>
                            <div className="input-group">
                                <label className="input-label" htmlFor="vendor-name-input">{entitySingular} *</label>
                                <input
                                    id="vendor-name-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.vendorName}
                                    onChange={(e) => updateField('vendorName', e.target.value)}
                                    placeholder={`Enter ${entitySingularLower} name`}
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="vendor-code-input">{entitySingular} ID *</label>
                                <input
                                    id="vendor-code-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.vendorCode}
                                    onChange={(e) => updateField('vendorCode', e.target.value)}
                                    placeholder={`Enter ${entitySingularLower} id`}
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="vendor-address-input">{entitySingular} Address *</label>
                                <input
                                    id="vendor-address-input"
                                    type="text"
                                    className="input-field"
                                    value={formData.address}
                                    onChange={(e) => updateField('address', e.target.value)}
                                    placeholder={`Enter ${entitySingularLower} address`}
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label" htmlFor="vendor-email-input">Email ID (optional)</label>
                                <input
                                    id="vendor-email-input"
                                    type="email"
                                    className="input-field"
                                    value={formData.mailId}
                                    onChange={(e) => updateField('mailId', e.target.value)}
                                    placeholder={`${entitySingularLower}@example.com`}
                                />
                            </div>

                            <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%' }}>
                                {saving ? 'Adding...' : `Add ${entitySingular} Entry`}
                            </button>
                        </form>
                    </div>

                    <div className="glass-card vendor-list-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', height: '590px', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '1rem' }}>
                            <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{entitySingular} List</h3>
                            <input
                                type="text"
                                className="input-field premium-search-field"
                                style={{ maxWidth: '360px' }}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={`Search by ${entitySingularLower}, id, address or email`}
                            />
                        </div>

                        {loading ? (
                            <div className="text-center py-xl">
                                <div className="spinner"></div>
                                <p className="mt-md text-muted">Loading {entityPluralLower}...</p>
                            </div>
                        ) : (
                            <div className="table-container vendor-table-wrap" style={{ flex: 1, minHeight: 0 }}>
                                <table className="table">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>{entitySingular}</th>
                                            <th>{entitySingular} ID</th>
                                            <th>{entitySingular} Address</th>
                                            <th>Email ID</th>
                                            <th>Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredVendors.length === 0 ? (
                                            <tr>
                                                <td colSpan="6" className="text-center" style={{ color: 'var(--text-muted)' }}>
                                                    No {entityPluralLower} found.
                                                </td>
                                            </tr>
                                        ) : filteredVendors.map((vendor, index) => (
                                            <tr key={vendor.id}>
                                                <td style={{ fontWeight: 600 }}>{index + 1}</td>
                                                <td>{vendor.vendor_name || vendor.bp_name || '-'}</td>
                                                <td>{vendor.vendor_code || '-'}</td>
                                                <td>{vendor.address || '-'}</td>
                                                <td>{vendor.mail_id || '-'}</td>
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
