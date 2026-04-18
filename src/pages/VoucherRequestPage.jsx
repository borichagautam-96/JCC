import React, { useState, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { useLocation, useNavigate } from 'react-router-dom';
import '../voucher-styles.css';
import { getVendorNames } from '../utils/vendorList';

const CLAIM_DATE_LOOKBACK_DAYS = 15;
const INVOICE_DATE_LOOKBACK_DAYS = 15;

const toDateInputValue = (date) => new Date(date).toISOString().split('T')[0];

const getTodayDateValue = () => toDateInputValue(new Date());

const getMinClaimDateValue = () => {
    const date = new Date();
    date.setDate(date.getDate() - CLAIM_DATE_LOOKBACK_DAYS);
    return toDateInputValue(date);
};

const getMinInvoiceDateValue = () => {
    const date = new Date();
    date.setDate(date.getDate() - INVOICE_DATE_LOOKBACK_DAYS);
    return toDateInputValue(date);
};

const VoucherRequestPage = () => {
    let authContext;
    try {
        authContext = useAuth();
    } catch (error) {
        console.error('Auth context error:', error);
        // Fallback if context is not available
        authContext = {
            user: null,
            getToken: () => localStorage.getItem('token')
        };
    }

    const { user, getToken } = authContext;
    const navigate = useNavigate();
    const location = useLocation();
    const dialog = useDialog();

    // Safely get extracted data if available
    const extractedData = location.state?.invoiceData || {};

    const [formData, setFormData] = useState({
        // Initiator Details
        claimedBy: user?.name || '',
        department: 'Documentation & Training',
        claimedDate: getTodayDateValue(),

        // Voucher Header
        supplier: extractedData.vendorName || extractedData.vendor_name || '',
        expenseBookingLocation: '',
        description: extractedData.poNumber || extractedData.po_number ? `Payment for PO #${extractedData.poNumber || extractedData.po_number}` : (extractedData.vendorName ? `Invoice from ${extractedData.vendorName}` : ''),
        invoiceNumber: extractedData.invoiceNumber || extractedData.invoice_number || '',
        invoiceDate: extractedData.date || extractedData.invoice_date || '',
        basicAmount: '',
        grossAmount: extractedData.amount || '',
        natureOfExpenses: '',

        // Assignment
        assignedTo: '',

        // Project Details
        poNumber: extractedData.poNumber || extractedData.po_number || '',
        projectAmount: '',
        projectCode: '',
        projectName: '',
        jcc_category: 'general',
        authority_level: '',

        // Approvers
        approver1: '',
        approver1Status: '',
        approver1Remarks: '',
        approver2: '',
        approver2Status: '',
        approver2Remarks: '',
    });

    // Materials array for multiple project entries
    const [materials, setMaterials] = useState([
        { amount: '', projectCode: '', projectName: '' }
    ]);

    const [attachmentFile, setAttachmentFile] = useState(null);
    const [managers, setManagers] = useState([]);
    const [finalApprovers, setFinalApprovers] = useState([]);


    const [submitting, setSubmitting] = useState(false);
    const [isExtracting, setIsExtracting] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');
    const [extractedLines, setExtractedLines] = useState([]);
    const [poSuppliers, setPoSuppliers] = useState([]);

    const handleSupplierSelection = (value) => {
        setFormData(prev => ({ ...prev, supplier: value }));
    };


    const handleExtractInvoice = async () => {
        if (!attachmentFile) {
            setError('Please select a file first.');
            return;
        }

        setIsExtracting(true);
        setError('');

        try {
            const formDataToSend = new FormData();
            formDataToSend.append('invoice', attachmentFile);

            const response = await fetch('/api/jcc/extract-invoice', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: formDataToSend
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Extraction failed');

            // Autofill form
            setFormData(prev => ({
                ...prev,
                invoiceNumber: data.entities?.referenceNumbers?.[0] || prev.invoiceNumber,
                invoiceDate: data.entities?.dates?.[0] || prev.invoiceDate,
                // If amount is found in entities or text, use it?
                // basicAmount might come from line items sum
            }));

            if (data.lineItems && data.lineItems.length > 0) {
                setExtractedLines(data.lineItems);
                // Optional: map to materials if user wants?
                // For now just show them.
                // We can also try to sum amounts if basicAmount is empty
                const total = data.lineItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
                if (total > 0) {
                    setFormData(prev => ({ ...prev, basicAmount: total.toFixed(2) }));
                }
            }

            setSuccess('Invoice data extracted successfully!');
            setTimeout(() => setSuccess(''), 8008);

        } catch (err) {
            console.error(err);
            setError(err.message);
        } finally {
            setIsExtracting(false);
        }
    };

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData({ ...formData, [name]: value });
    };

    // Handle material entry changes
    const handleMaterialChange = (index, field, value) => {
        const updatedMaterials = [...materials];
        updatedMaterials[index][field] = value;
        setMaterials(updatedMaterials);
    };

    // Auto-calculate Basic Amount from sum of material amounts
    useEffect(() => {
        const totalAmount = materials.reduce((sum, material) => {
            const amount = parseFloat(material.amount) || 0;
            return sum + amount;
        }, 0);

        setFormData(prev => ({
            ...prev,
            basicAmount: totalAmount > 0 ? totalAmount.toFixed(2) : prev.basicAmount
        }));
    }, [materials]);

    // Fetch managers and final approvers on mount
    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch Managers
                const managersResponse = await fetch('/api/jcc/managers', {
                    headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
                });
                if (managersResponse.ok) {
                    const managersData = await managersResponse.json();
                    setManagers(managersData);
                }

                // Fetch Final Approvers
                const approversResponse = await fetch('/api/jcc/final-approvers', {
                    headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
                });

                if (approversResponse.ok) {
                    const approversData = await approversResponse.json();
                    setFinalApprovers(approversData);
                }

                // Fetch supplier names from PO management
                const suppliersResponse = await fetch('/api/jcc/po-suppliers', {
                    headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
                });

                if (suppliersResponse.ok) {
                    const supplierData = await suppliersResponse.json();
                    setPoSuppliers(Array.isArray(supplierData) ? supplierData : []);
                }
            } catch (error) {
                console.error('Error fetching approvers:', error);
            }
        };
        fetchData();
    }, [getToken]);

    const supplierOptions = (() => {
        const merged = [...getVendorNames(), ...poSuppliers];
        const options = [...new Set(merged.filter(Boolean))].sort((a, b) => a.localeCompare(b));
        if (formData.supplier && !options.includes(formData.supplier)) {
            options.unshift(formData.supplier);
        }
        return options;
    })();

    // Add new material entry
    const addMaterial = () => {
        setMaterials([...materials, { amount: '', projectCode: '', projectName: '' }]);
    };

    // Remove material entry
    const removeMaterial = (index) => {
        if (materials.length > 1) {
            setMaterials(materials.filter((_, i) => i !== index));
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setSubmitting(true);
        setError('');
        setSuccess('');

        try {
            const minClaimDate = getMinClaimDateValue();
            const maxClaimDate = getTodayDateValue();
            const claimedDateValue = String(formData.claimedDate || '').trim();
            if (!claimedDateValue) {
                throw new Error('Claim Date is required');
            }
            if (claimedDateValue < minClaimDate || claimedDateValue > maxClaimDate) {
                throw new Error(`Claim Date must be within the last ${CLAIM_DATE_LOOKBACK_DAYS} days`);
            }

            const minInvoiceDate = getMinInvoiceDateValue();
            const maxInvoiceDate = getTodayDateValue();
            const invoiceDateValue = String(formData.invoiceDate || '').trim();
            if (!invoiceDateValue) {
                throw new Error('Invoice Date is required');
            }
            if (invoiceDateValue < minInvoiceDate || invoiceDateValue > maxInvoiceDate) {
                throw new Error(`Invoice Date must be within the last ${INVOICE_DATE_LOOKBACK_DAYS} days`);
            }

            // Validation: Gross Amount must be higher than Basic Amount
            const basicAmount = parseFloat(formData.basicAmount) || 0;
            const grossAmount = parseFloat(formData.grossAmount) || 0;
            const projectAmount = parseFloat(formData.projectAmount) || 0;

            if (grossAmount <= basicAmount) {
                throw new Error('Gross Amount must be higher than Basic Amount');
            }

            if (grossAmount <= projectAmount) {
                throw new Error('Gross Amount must be higher than Project Amount');
            }

            // Create FormData from the actual form to include all dynamic material rows.
            const formDataToSend = new FormData(e.currentTarget);

            const materialMap = new Map();
            const materialFieldRegex = /^materials\[(\d+)\]\[(amount|projectCode|projectName)\]$/;
            for (const [key, value] of formDataToSend.entries()) {
                if (typeof key !== 'string') continue;
                const match = materialFieldRegex.exec(key);
                if (!match) continue;

                const index = Number(match[1]);
                const field = match[2];
                if (!materialMap.has(index)) {
                    materialMap.set(index, { amount: '', projectCode: '', projectName: '' });
                }
                materialMap.get(index)[field] = String(value ?? '');
            }

            const materialsFromForm = [...materialMap.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, item]) => item)
                .filter((item) => item.amount || item.projectCode || item.projectName);

            const effectiveMaterials = materialsFromForm.length > 0 ? materialsFromForm : materials;

            // Append materials array as JSON string
            formDataToSend.append('materials', JSON.stringify(effectiveMaterials));
            // Robust fallback payloads to survive multipart parser differences.
            const materialsJson = JSON.stringify(effectiveMaterials);
            formDataToSend.append('materialsPayload', materialsJson);
            formDataToSend.append('materialsPayloadB64', btoa(materialsJson));

            // Append invoice ID if this voucher is being created from an assigned invoice
            console.log('=== DEBUG: extractedData ===', extractedData);
            console.log('=== DEBUG: extractedData.id ===', extractedData.id);
            if (extractedData.id) {
                formDataToSend.append('invoiceId', extractedData.id);
                console.log('=== DEBUG: Appending invoiceId ===', extractedData.id);
            }

            // File input is included by form element serialization.

            const response = await fetch('/api/jcc/create-voucher', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: formDataToSend,
            });

            // Safely parse JSON — avoid "Unexpected end of JSON input" if body is empty
            let data = {};
            try {
                data = await response.json();
            } catch (jsonErr) {
                if (!response.ok) {
                    throw new Error(`Server error: ${response.status} ${response.statusText}`);
                }
            }

            if (!response.ok) {
                throw new Error(data.details || data.error || 'Failed to create voucher');
            }

            // Show success popup
            const voucherId = data.voucherId || 'Unknown';
            const formattedId = voucherId !== 'Unknown' ? String(voucherId).padStart(4, '0') : voucherId;
            const jccId = voucherId !== 'Unknown' ? `JCC${formattedId}` : voucherId;
            const successMsg = `✅ JCC Voucher Created Successfully!\n\nJCC No.: ${jccId}\nSupplier: ${formData.supplier}\nAmount: ₹${formData.basicAmount}\n\nYour JCC request has been submitted for approval.`;

            await dialog.alert(successMsg);

            setSuccess(`JCC request created successfully! JCC No.: ${jccId}`);

            // Reset form
            setFormData({
                claimedBy: user?.name || '',
                department: 'Documentation & Training',
                claimedDate: getTodayDateValue(),
                supplier: '',
                expenseBookingLocation: '',
                description: '',
                invoiceNumber: '',
                invoiceDate: '',
                basicAmount: '',
                grossAmount: '',
                natureOfExpenses: '',
                assignedTo: '',
                poNumber: '',
                projectAmount: '',
                projectCode: '',
                projectName: '',
                approver1: '',
                approver1Status: '',
                approver1Remarks: '',
                approver2: '',
                approver2Status: '',
                approver2Remarks: '',
            });
            setAttachmentFile(null);
            setMaterials([{ amount: '', projectCode: '', projectName: '' }]);

            // Redirect after delay
            setTimeout(() => {
                navigate('/voucher-history');
            }, 2000);

        } catch (err) {
            console.error('Error creating voucher:', err);
            setError(err.message || 'Failed to submit voucher request');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="container page-shell voucher-page">
            <div className="fade-in">
                {/* Header */}
                <div className="voucher-hero">
                    <h1>Create Voucher Request</h1>
                    <p>Fill in the details below to submit a new voucher request</p>
                </div>

                {success && (
                    <div className="voucher-alert voucher-alert-success">
                        {success}
                    </div>
                )}

                {error && (
                    <div className="voucher-alert voucher-alert-danger">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    <div className="voucher-two-col">
                        {/* Initiator Details */}
                        <div className="glass-card voucher-section-card">
                            <div className="voucher-section-head">
                                <h3 className="voucher-section-head-title">Initiator Details</h3>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Claimed By *</label>
                                <input
                                    type="text"
                                    name="claimedBy"
                                    className="input-field voucher-readonly"
                                    value={formData.claimedBy}
                                    onChange={handleChange}
                                    required
                                    readOnly
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Department *</label>
                                <input
                                    type="text"
                                    name="department"
                                    className="input-field voucher-readonly"
                                    value="DOCUMENTATION & TRAINING"
                                    readOnly
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Department Code</label>
                                <input
                                    type="text"
                                    name="departmentCode"
                                    className="input-field voucher-readonly"
                                    value="3559"
                                    readOnly
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Claim Date *</label>
                                <input
                                    type="date"
                                    name="claimedDate"
                                    className="input-field"
                                    value={formData.claimedDate}
                                    onChange={handleChange}
                                    min={getMinClaimDateValue()}
                                    max={getTodayDateValue()}
                                    required
                                />
                            </div>
                        </div>

                        {/* Voucher Header */}
                        <div className="glass-card voucher-section-card">
                            <div className="voucher-section-head">
                                <h3 className="voucher-section-head-title">Voucher Header</h3>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Supplier *</label>
                                <select
                                    name="supplier"
                                    className="input-field"
                                    value={formData.supplier}
                                    onChange={(e) => handleSupplierSelection(e.target.value)}
                                    required
                                >
                                    <option value="">Select Supplier</option>
                                    {supplierOptions.map((vendor) => (
                                        <option key={vendor} value={vendor}>{vendor}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="input-group">
                                <label className="input-label">PO No.</label>
                                <input
                                    type="text"
                                    name="poNumber"
                                    className="input-field"
                                    value={formData.poNumber}
                                    onChange={handleChange}
                                    placeholder="Purchase Order Number"
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Expense Booking Location *</label>
                                <select
                                    name="expenseBookingLocation"
                                    className="input-field"
                                    value={formData.expenseBookingLocation}
                                    onChange={handleChange}
                                    required
                                >
                                    <option value="">Select Location</option>
                                    <option value="POWAI">POWAI</option>
                                    <option value="TALEGAON">TALEGAON</option>
                                </select>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Description</label>
                                <textarea
                                    name="description"
                                    className="input-field"
                                    value={formData.description}
                                    onChange={handleChange}
                                    rows="2"
                                    placeholder="Brief description of the expense"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Invoice Details - Full Width */}
                    <div className="glass-card voucher-section-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                        <h3 className="voucher-section-head-title mb-lg">Invoice Details</h3>

                        <div className="voucher-grid-3">
                            <div className="input-group">
                                <label className="input-label">Invoice Number *</label>
                                <input
                                    type="text"
                                    name="invoiceNumber"
                                    className="input-field"
                                    value={formData.invoiceNumber}
                                    onChange={handleChange}
                                    placeholder="INV-XXXX"
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Invoice Date *</label>
                                <input
                                    type="date"
                                    name="invoiceDate"
                                    className="input-field"
                                    value={formData.invoiceDate}
                                    onChange={handleChange}
                                    min={getMinInvoiceDateValue()}
                                    max={getTodayDateValue()}
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Nature of Expenses</label>
                                <select
                                    name="natureOfExpenses"
                                    className="input-field"
                                    value={formData.natureOfExpenses}
                                    onChange={handleChange}
                                >
                                    <option value="">Select Category</option>
                                    <option value="Materials">Materials</option>
                                    <option value="Services">Services</option>
                                    <option value="Equipment">Equipment</option>
                                    <option value="Utilities">Utilities</option>
                                    <option value="Travel">Travel</option>
                                    <option value="Other">Other</option>
                                </select>
                            </div>
                        </div>

                        <div className="voucher-grid-2" style={{ marginTop: 'var(--spacing-lg)' }}>
                            <div className="input-group">
                                <label className="input-label">Basic Amount * (₹)</label>
                                <input
                                    type="number"
                                    step="0.01"
                                    name="basicAmount"
                                    className="input-field voucher-readonly"
                                    value={formData.basicAmount}
                                    onChange={handleChange}
                                    placeholder="0.00"
                                    readOnly
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Gross Amount (₹)</label>
                                <input
                                    type="number"
                                    step="0.01"
                                    name="grossAmount"
                                    className="input-field"
                                    value={formData.grossAmount}
                                    onChange={handleChange}
                                    placeholder="0.00"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Project Details & Attachment */}
                    <div className="glass-card voucher-section-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                        <div style={{ marginBottom: 'var(--spacing-md)' }}>
                            <h3 className="voucher-section-head-title" style={{ margin: 0 }}>Project Details</h3>
                        </div>

                        {/* Materials Entries */}
                        {materials.map((material, index) => (
                            <div key={index} className="voucher-material-card">
                                {materials.length > 1 && (
                                    <div className="voucher-row-end">
                                        <button
                                            type="button"
                                            onClick={() => removeMaterial(index)}
                                            className="btn btn-danger"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                )}

                                <div className="voucher-grid-3">
                                    <div className="input-group">
                                        <label className="input-label">Amount (₹)</label>
                                        <input
                                            type="number"
                                            step="0.01"
                                            name={`materials[${index}][amount]`}
                                            className="input-field"
                                            value={material.amount}
                                            onChange={(e) => handleMaterialChange(index, 'amount', e.target.value)}
                                            placeholder="0.00"
                                        />
                                    </div>

                                    <div className="input-group">
                                        <label className="input-label">Project/Debit Code</label>
                                        <input
                                            type="text"
                                            name={`materials[${index}][projectCode]`}
                                            className="input-field"
                                            value={material.projectCode}
                                            onChange={(e) => handleMaterialChange(index, 'projectCode', e.target.value)}
                                            placeholder="Project/Debit Code"
                                        />
                                    </div>

                                    <div className="input-group">
                                        <label className="input-label">Project Name</label>
                                        <input
                                            type="text"
                                            name={`materials[${index}][projectName]`}
                                            className="input-field"
                                            value={material.projectName}
                                            onChange={(e) => handleMaterialChange(index, 'projectName', e.target.value)}
                                            placeholder="Project Name"
                                        />
                                    </div>
                                </div>
                            </div>
                        ))}

                        {/* Add New Entry Button */}
                        <button
                            type="button"
                            onClick={addMaterial}
                            className="btn btn-outline voucher-add-entry"
                        >
                            + Add New Entry
                        </button>

                        {/* Attachment */}
                        <div className="input-group" style={{ marginTop: 'var(--spacing-lg)' }}>
                            <label className="input-label">Attachment (Invoice to be attached here) *</label>
                            <input
                                type="file"
                                name="attachment"
                                className="input-field"
                                accept=".pdf,.jpg,.jpeg,.png"
                                onChange={(e) => setAttachmentFile(e.target.files[0])}
                                required
                                style={{ padding: '0.5rem' }}
                            />

                            {attachmentFile && (
                                <small style={{ color: '#0066CC', display: 'block', marginTop: '0.5rem' }}>
                                    Selected: {attachmentFile.name}
                                </small>
                            )}
                        </div>

                        {extractedLines.length > 0 && (
                            <div className="glass-card voucher-extracted">
                                <h4 style={{ margin: '0 0 1rem 0', color: '#0369A1' }}>Extracted Line Items</h4>
                                <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                                        <thead>
                                            <tr style={{ background: '#E0F2FE', textAlign: 'left' }}>
                                                <th style={{ padding: '8px' }}>Description</th>
                                                <th style={{ padding: '8px' }}>Qty</th>
                                                <th style={{ padding: '8px' }}>Rate</th>
                                                <th style={{ padding: '8px' }}>Amount</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {extractedLines.map((item, idx) => (
                                                <tr key={idx} style={{ borderBottom: '1px solid #E0E0E0' }}>
                                                    <td style={{ padding: '8px' }}>{item.description || item.text || '-'}</td>
                                                    <td style={{ padding: '8px' }}>{item.quantity || '-'}</td>
                                                    <td style={{ padding: '8px' }}>{item.unitPrice || '-'}</td>
                                                    <td style={{ padding: '8px' }}>{item.amount}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Approvers Section */}
                    <div className="glass-card voucher-section-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                        <h3 className="voucher-section-head-title mb-lg">Approvers</h3>

                        <div className="voucher-grid-2">
                            <div className="input-group">
                                <label className="input-label">Approver 1 (Manager) *</label>
                                <select
                                    name="approver1"
                                    className="input-field"
                                    value={formData.approver1}
                                    onChange={handleChange}
                                    required
                                >
                                    <option value="">Select Manager</option>
                                    {managers.map(m => (
                                        <option key={m.id} value={m.name}>{m.ps_number ? `${m.ps_number} - ` : ''}{m.name}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Approver 2 (Final Approver) *</label>
                                <select
                                    name="approver2"
                                    className="input-field"
                                    value={formData.approver2}
                                    onChange={handleChange}
                                    required
                                >
                                    <option value="">Select Final Approver</option>
                                    {finalApprovers.map(m => (
                                        <option key={m.id} value={m.name}>{m.ps_number ? `${m.ps_number} - ` : ''}{m.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>

                    {/* Submit Buttons */}
                    <div className="voucher-submit-row">
                        <button
                            type="submit"
                            disabled={submitting}
                            className="btn btn-primary"
                        >
                            {submitting ? 'Submitting...' : 'Submit Voucher Request'}
                        </button>

                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="btn btn-outline"
                        >
                            Reset Form
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default VoucherRequestPage;
