import React, { useState, useRef, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import './vendor-upload-taxhacker.css';

const SHOW_ANALYZE_WITH_AI_BUTTON = false;

// Canonical vendor list — mirrors VendorManagementPage TEMP_ALLOWED_VENDOR_NAMES, sorted A-Z
// This is used as the guaranteed fallback so the dropdown is ALWAYS populated immediately.
const DEFAULT_VENDOR_NAMES = [
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
    'Track On Courier',
    'Urgent Courier',
    'Voice Kraft Productions',
    'White Globe Pvt. Ltd.',
].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

const VendorUploadPage = () => {
    const [files, setFiles] = useState([]);
    const [activeFileIndex, setActiveFileIndex] = useState(0);
    const [preview, setPreview] = useState(null);
    const [fileExtractedDataMap, setFileExtractedDataMap] = useState({});
    const [aiAnalyzing, setAiAnalyzing] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');
    const [isFullScreen, setIsFullScreen] = useState(false);
    const [previewZoom, setPreviewZoom] = useState(100);
    // Pre-seeded with DEFAULT_VENDOR_NAMES so the dropdown is never empty.
    // The API call in useEffect will update this with the live DB list.
    const [vendorNames, setVendorNames] = useState(DEFAULT_VENDOR_NAMES);
    const fileInputRef = useRef(null);
    const { getToken } = useAuth();
    const [users, setUsers] = useState([]); // Restore missing state
    const activeFile = files[activeFileIndex] || null;

    const createEmptyExtractedData = () => ({
        vendorName: '',
        invoiceNumber: '',
        amount: '',
        date: '',
        poNumber: '',
        rawText: '',
        lineItems: [],
        tableHeaders: [],
        assignedTo: '',
    });

    const getFileKey = (file) => {
        if (!file) return null;
        return `${file.name}-${file.size}-${file.lastModified}`;
    };

    const activeFileKey = getFileKey(activeFile);
    const extractedData = activeFileKey ? (fileExtractedDataMap[activeFileKey] || createEmptyExtractedData()) : null;

    const setExtractedData = (updater) => {
        if (!activeFileKey) return;

        setFileExtractedDataMap((prev) => {
            const current = prev[activeFileKey] || createEmptyExtractedData();
            const nextValue = typeof updater === 'function' ? updater(current) : updater;
            return {
                ...prev,
                [activeFileKey]: nextValue,
            };
        });
    };

    const ensureExtractedDataEntries = (fileList) => {
        if (!Array.isArray(fileList) || fileList.length === 0) return;

        setFileExtractedDataMap((prevMap) => {
            const nextMap = { ...prevMap };
            for (const file of fileList) {
                const key = getFileKey(file);
                if (key && !nextMap[key]) {
                    nextMap[key] = createEmptyExtractedData();
                }
            }
            return nextMap;
        });
    };

    // Vendor names come exclusively from Vendor Management (vendors table)
    const uploadVendorOptions = vendorNames;

    const handleVendorSelection = (value) => {
        setExtractedData({ ...extractedData, vendorName: value });
    };

    const appendSelectedFiles = (incomingFileList) => {
        const incomingFiles = Array.from(incomingFileList || []).filter(Boolean);
        if (incomingFiles.length === 0) return;

        const isSupportedUploadFile = (file) => {
            const type = String(file?.type || '').toLowerCase();
            const name = String(file?.name || '').toLowerCase();

            if (type === 'application/pdf' || type === 'image/png' || type === 'image/jpeg' || type === 'image/jpg') {
                return true;
            }

            return name.endsWith('.pdf') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg');
        };

        const allowedFiles = incomingFiles.filter(isSupportedUploadFile);
        if (allowedFiles.length === 0) {
            setError('Only PDF, JPG and PNG files are supported.');
            return;
        }

        let duplicateCount = 0;

        setFiles((prev) => {
            const existingKeys = new Set(prev.map((f) => `${f.name}-${f.size}-${f.lastModified}`));
            const deduped = allowedFiles.filter((f) => !existingKeys.has(`${f.name}-${f.size}-${f.lastModified}`));
            duplicateCount = allowedFiles.length - deduped.length;
            const next = [...prev, ...deduped];

            ensureExtractedDataEntries(deduped);

            if (deduped.length > 0) {
                // Open the latest newly added file so its own extracted-data form is shown immediately.
                setActiveFileIndex(next.length - 1);
            }

            return next;
        });

        setError('');
        setSuccess('');
        if (duplicateCount > 0) {
            setSuccess(`${duplicateCount} duplicate file(s) skipped. Added remaining new file(s).`);
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const selectFile = (index) => {
        setActiveFileIndex(index);
        setError('');
        setSuccess('');
    };

    const removeFile = (indexToRemove) => {
        setFiles((prev) => {
            if (indexToRemove < 0 || indexToRemove >= prev.length) return prev;

            const removedFile = prev[indexToRemove];
            const removedFileKey = getFileKey(removedFile);

            if (removedFileKey) {
                setFileExtractedDataMap((prevMap) => {
                    const nextMap = { ...prevMap };
                    delete nextMap[removedFileKey];
                    return nextMap;
                });
            }

            const next = prev.filter((_, idx) => idx !== indexToRemove);

            if (next.length === 0) {
                setActiveFileIndex(0);
                setPreview(null);
                return next;
            }

            if (indexToRemove === activeFileIndex) {
                const nextIndex = Math.min(indexToRemove, next.length - 1);
                setActiveFileIndex(nextIndex);
            } else if (indexToRemove < activeFileIndex) {
                setActiveFileIndex((prevIndex) => Math.max(prevIndex - 1, 0));
            }

            return next;
        });

        setError('');
        setSuccess('');
    };

    // Fetch users for assignment dropdown
    useEffect(() => {
        const fetchUsers = async () => {
            console.log('=== Fetching Users for Assignment ===');
            console.log('Token:', getToken());

            try {
                const response = await fetch('/api/users/assignable', {
                    headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
                });

                console.log('Response status:', response.status);

                if (response.ok) {
                    const data = await response.json();
                    console.log('Users fetched successfully:', data.length, 'users');
                    console.log('User data:', data);
                    setUsers(data);
                } else {
                    const errorText = await response.text();
                    console.error('Failed to fetch users:', response.status, errorText);
                }
            } catch (error) {
                console.error('Error fetching users:', error);
            }
        };
        fetchUsers();

        const fetchVendorNames = async () => {
            try {
                const response = await fetch('/api/vendors/names', {
                    headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
                });

                if (response.ok) {
                    const data = await response.json();
                    if (Array.isArray(data) && data.length > 0) {
                        // Merge API response with fallback list — deduplicate case-insensitively, sort A-Z
                        const combined = [...data];
                        const lowerSet = new Set(data.map((n) => n.toLowerCase()));
                        for (const name of DEFAULT_VENDOR_NAMES) {
                            if (!lowerSet.has(name.toLowerCase())) {
                                combined.push(name);
                            }
                        }
                        combined.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
                        setVendorNames(combined);
                    }
                    // If API returns empty array, keep the pre-seeded DEFAULT_VENDOR_NAMES (no-op)
                } else {
                    console.error('Failed to fetch vendor names:', response.status);
                    // Keep pre-seeded DEFAULT_VENDOR_NAMES — no state update needed
                }
            } catch (vendorError) {
                console.error('Error fetching vendor names:', vendorError);
                // Keep pre-seeded DEFAULT_VENDOR_NAMES — no state update needed
            }
        };

        fetchVendorNames();
    }, []); // Run once on mount

    const handleFileSelect = (e) => {
        appendSelectedFiles(e.target.files);
    };

    useEffect(() => {
        if (!activeFile) {
            setPreview(null);
            return;
        }

        setPreviewZoom(100);

        const objectUrl = URL.createObjectURL(activeFile);
        setPreview(objectUrl);

        return () => {
            URL.revokeObjectURL(objectUrl);
        };
    }, [activeFile]);

    const handleAnalyzeWithAI = async () => {
        if (!activeFile) {
            setError('Please select a file first');
            return;
        }

        setAiAnalyzing(true);
        setError('');
        setSuccess('');

        try {
            const payload = new FormData();
            payload.append('invoice', activeFile);

            const response = await fetch('/api/invoices/extract-ai', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: payload,
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(errText || 'AI extraction failed');
            }

            const data = await response.json();

            const merged = extractedData
                ? {
                    ...extractedData,
                    ...data,
                    vendorName: data.vendorName || extractedData.vendorName || '',
                    invoiceNumber: data.invoiceNumber || extractedData.invoiceNumber || '',
                    amount: data.amount || extractedData.amount || '',
                    date: data.date || extractedData.date || '',
                    poNumber: data.poNumber || extractedData.poNumber || '',
                    rawText: data.rawText || extractedData.rawText || '',
                }
                : {
                    ...data,
                    vendorName: data.vendorName || '',
                    invoiceNumber: data.invoiceNumber || '',
                    amount: data.amount || '',
                    date: data.date || '',
                    poNumber: data.poNumber || '',
                    rawText: data.rawText || '',
                };

            setExtractedData(merged);

            if (data.usedAI) {
                setSuccess(`✓ Analyze with AI complete! Invoice: ${merged.invoiceNumber || 'N/A'} | Amount: ${merged.amount || 'N/A'} | Date: ${merged.date || 'N/A'} | PO: ${merged.poNumber || 'N/A'}`);
            } else {
                setSuccess('⚠️ AI analysis not available, showing OCR extraction results.');
            }
        } catch (err) {
            setError(`AI analysis failed: ${err.message}`);
        } finally {
            setAiAnalyzing(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!activeFile) return;

        setUploading(true);
        setError('');
        setSuccess('');

        const formData = new FormData();
        formData.append('invoice', activeFile);
        formData.append('vendorName', extractedData.vendorName);
        formData.append('invoiceNumber', extractedData.invoiceNumber);
        formData.append('amount', extractedData.amount);
        formData.append('invoiceDate', extractedData.date);
        formData.append('assignedTo', extractedData.assignedTo);
        formData.append('poNumber', extractedData.poNumber || '');

        try {
            const response = await fetch('/api/invoices/upload', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: formData,
            });

            // Read body once as text to safely handle JSON and HTML error pages
            const responseText = await response.text();
            let responseData = null;
            try { responseData = JSON.parse(responseText); } catch { /* non-JSON response */ }

            if (response.ok) {
                const result = responseData || {};
                setSuccess(`✅ ${result.message || 'Invoice assigned successfully!'} The user can now see this invoice in their "Assigned Invoices" page.`);

                setFiles((prev) => {
                    const removedFile = prev[activeFileIndex];
                    const removedFileKey = getFileKey(removedFile);

                    if (removedFileKey) {
                        setFileExtractedDataMap((prevMap) => {
                            const nextMap = { ...prevMap };
                            delete nextMap[removedFileKey];
                            return nextMap;
                        });
                    }

                    const next = prev.filter((_, idx) => idx !== activeFileIndex);
                    if (next.length === 0) {
                        setActiveFileIndex(0);
                        setPreview(null);
                    } else {
                        const nextIndex = Math.min(activeFileIndex, next.length - 1);
                        setActiveFileIndex(nextIndex);
                    }
                    return next;
                });
            } else {
                const serverError = responseData?.error || responseData?.message;
                throw new Error(serverError || `Server error (${response.status}): Please check your connection and try again.`);
            }
        } catch (err) {
            const errorMessage = err.message || 'Failed to upload invoice. Please try again.';
            setError(errorMessage);
            console.error('Upload error details:', err);
        } finally {
            setUploading(false);
        }
    };

    const unsortedFilesCount = files.length;
    const hasFileSelected = files.length > 0;

    return (
        <div className="container th-page-shell" style={{ paddingTop: 'var(--spacing-2xl)', paddingBottom: 'var(--spacing-2xl)' }}>
            <div className="fade-in">
                {hasFileSelected ? (
                    <header className="th-header">
                        <h2>You have {unsortedFilesCount} unsorted files</h2>
                    </header>
                ) : (
                    <div className="th-empty-state">
                        <svg className="th-empty-icon" fill="none" stroke="currentColor" viewBox="0 0 64 64" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
                            {/* Document body */}
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 8a4 4 0 0 1 4-4h20l12 12v36a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V8z" />
                            {/* Folded corner */}
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M38 4v12h12" />
                            {/* Upload arrow */}
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M32 44v-14m0 0-5 5m5-5 5 5" />
                            {/* Lines on document */}
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M22 54h8" />
                        </svg>
                        <p className="th-empty-title">Everything is clear! Congrats!</p>
                        <p className="th-empty-subtitle">Drag and drop new files here to analyze</p>
                        <div className="th-empty-actions">
                            <button type="button" className="th-btn th-btn-dark th-empty-btn" onClick={() => fileInputRef.current?.click()}>
                                Upload New File
                            </button>
                        </div>
                    </div>
                )}

                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,image/*"
                    multiple
                    onChange={handleFileSelect}
                    style={{ display: 'none' }}
                />

                {success && (
                    <div style={{
                        padding: '1rem',
                        background: 'rgba(16, 185, 129, 0.1)',
                        border: '1px solid var(--success)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: 'var(--spacing-lg)',
                        color: 'var(--success)'
                    }}>
                        {success}
                    </div>
                )}

                {error && (
                    <div style={{
                        padding: '1rem',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid var(--danger)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: 'var(--spacing-lg)',
                        color: 'var(--danger)'
                    }}>
                        {error}
                    </div>
                )}

                {hasFileSelected && <div className="th-unsorted-card">
                    <div className="glass-card th-left-panel">
                        <h3 className="mb-lg">Select Invoice File</h3>

                        <div className="th-file-toolbar">
                            <button type="button" className="th-add-files-btn" onClick={() => fileInputRef.current?.click()}>
                                + Add files
                            </button>
                            <span className="th-files-count">{files.length} file(s) selected</span>
                        </div>

                        <div className="th-file-list">
                            {files.map((queuedFile, idx) => {
                                const isActive = idx === activeFileIndex;
                                return (
                                    <div
                                        key={`${queuedFile.name}-${queuedFile.size}-${queuedFile.lastModified}`}
                                        className={`th-file-item-row ${isActive ? 'th-file-item-active' : ''}`}
                                    >
                                        <button
                                            type="button"
                                            className="th-file-item"
                                            onClick={() => selectFile(idx)}
                                        >
                                            {queuedFile.name}
                                        </button>
                                        <button
                                            type="button"
                                            className="th-file-delete-btn"
                                            onClick={() => removeFile(idx)}
                                            aria-label={`Remove ${queuedFile.name}`}
                                            title="Remove file"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                );
                            })}
                        </div>

                        {SHOW_ANALYZE_WITH_AI_BUTTON && activeFile && (
                            <button
                                type="button"
                                onClick={handleAnalyzeWithAI}
                                disabled={aiAnalyzing}
                                className="th-btn th-btn-dark"
                            >
                                {aiAnalyzing ? '⏳ Analyzing with AI...' : '🧠 Analyze with AI'}
                            </button>
                        )}

                        {extractedData && (
                            <form onSubmit={handleSubmit} className="th-analyze-form" style={{ marginTop: 'var(--spacing-xl)' }}>
                                <h4 style={{ marginBottom: 'var(--spacing-md)', color: 'var(--primary)' }}>Extracted Data</h4>

                                <div className="input-group">
                                    <label className="input-label" htmlFor="vendorName">Vendor Name</label>
                                    <select
                                        id="vendorName"
                                        className="input-field"
                                        value={extractedData.vendorName}
                                        onChange={(e) => handleVendorSelection(e.target.value)}
                                    >
                                        <option value="">Select Vendor</option>
                                        {uploadVendorOptions.map((vendor) => (
                                            <option key={vendor} value={vendor}>{vendor}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="input-group">
                                    <label className="input-label" htmlFor="invoiceNumber">Invoice Number</label>
                                    <input
                                        id="invoiceNumber"
                                        type="text"
                                        className="input-field"
                                        value={extractedData.invoiceNumber}
                                        onChange={(e) => setExtractedData({ ...extractedData, invoiceNumber: e.target.value })}
                                        placeholder="INV-001"
                                    />
                                </div>

                                <div className="input-group">
                                    <label className="input-label" htmlFor="amount">Final Amount (₹)</label>
                                    <input
                                        id="amount"
                                        type="number"
                                        step="0.01"
                                        className="input-field"
                                        value={extractedData.amount}
                                        onChange={(e) => setExtractedData({ ...extractedData, amount: e.target.value })}
                                        placeholder="0.00"
                                    />
                                </div>

                                <div className="input-group">
                                    <label className="input-label" htmlFor="invoiceDate">Invoice Date</label>
                                    <input
                                        id="invoiceDate"
                                        type="date"
                                        className="input-field"
                                        value={extractedData.date}
                                        onChange={(e) => setExtractedData({ ...extractedData, date: e.target.value })}
                                    />
                                </div>

                                <div className="input-group">
                                    <label className="input-label" htmlFor="poNumber">PO No.</label>
                                    <input
                                        id="poNumber"
                                        type="text"
                                        className="input-field"
                                        value={extractedData.poNumber || ''}
                                        onChange={(e) => setExtractedData({ ...extractedData, poNumber: e.target.value })}
                                        placeholder="PO Number"
                                    />
                                </div>

                                <div className="input-group">
                                    <label className="input-label" htmlFor="assignedTo">
                                        Assign To *
                                        {users.length > 0 ? (
                                            <span style={{ color: '#10B981', marginLeft: '0.5rem' }}>
                                                ({users.length} users loaded)
                                            </span>
                                        ) : (
                                            <span style={{ color: '#DC2626', marginLeft: '0.5rem' }}>
                                                (Loading users...)
                                            </span>
                                        )}
                                    </label>
                                    <select
                                        id="assignedTo"
                                        className="input-field"
                                        value={extractedData.assignedTo || ''}
                                        onChange={(e) => setExtractedData({ ...extractedData, assignedTo: e.target.value })}
                                        required
                                    >
                                        <option value="">Select Person</option>
                                        {users.length === 0 && (
                                            <option value="" disabled>No users available - Check console for errors</option>
                                        )}
                                        {users.map(u => (
                                            <option key={u.id} value={u.ps_number || u.email}>
                                                {u.name} ({u.ps_number || u.role})
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <button
                                    type="submit"
                                    className="btn btn-primary"
                                    style={{ width: '100%', padding: '1rem', fontSize: '1.1rem', fontWeight: 600 }}
                                    disabled={uploading || !extractedData.assignedTo}
                                >
                                    {uploading ? (
                                        <div className="flex items-center justify-center gap-sm">
                                            <div className="spinner" style={{ width: '20px', height: '20px', borderWidth: '2px' }}></div>
                                            <span>Assigning...</span>
                                        </div>
                                    ) : (
                                        'Assign to User'
                                    )}
                                </button>

                                {!extractedData.assignedTo && (
                                    <small style={{ display: 'block', marginTop: '0.5rem', color: '#DC2626', textAlign: 'center' }}>
                                        Please select a user to assign this invoice
                                    </small>
                                )}
                            </form>
                        )}
                    </div>

                    {preview && (
                        <div className="glass-card th-right-panel slide-in-right">
                            <div className="flex justify-between items-center mb-lg">
                                <h3 style={{ margin: 0 }}>Preview</h3>
                                <div className="flex items-center gap-sm">
                                    <div className="flex items-center gap-sm" style={{ padding: '0.25rem 0.5rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                                        <button
                                            type="button"
                                            className="btn btn-sm btn-outline"
                                            onClick={() => setPreviewZoom((prev) => Math.max(50, prev - 10))}
                                            title="Zoom out"
                                        >
                                            -
                                        </button>
                                        <span style={{ minWidth: '48px', textAlign: 'center', fontWeight: 600 }}>{previewZoom}%</span>
                                        <button
                                            type="button"
                                            className="btn btn-sm btn-outline"
                                            onClick={() => setPreviewZoom((prev) => Math.min(300, prev + 10))}
                                            title="Zoom in"
                                        >
                                            +
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-sm btn-outline"
                                            onClick={() => setPreviewZoom(100)}
                                            title="Reset zoom"
                                        >
                                            Reset
                                        </button>
                                    </div>

                                    <button
                                        onClick={() => setIsFullScreen(true)}
                                        className="btn btn-sm btn-outline"
                                        title="View Full Screen"
                                    >
                                        ⤢ Full Screen
                                    </button>
                                </div>
                            </div>

                            {/* Extracted Line Items Table */}
                            {extractedData?.lineItems?.length > 0 && (
                                <div className="form-group th-items-box" style={{ marginTop: '1.5rem' }}>
                                    <label className="input-label">Extracted Items ({extractedData.lineItems.length})</label>
                                    <div style={{
                                        overflowX: 'auto',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'rgba(255,255,255,0.5)'
                                    }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                                            <thead>
                                                <tr style={{ background: 'rgba(0,0,0,0.03)', borderBottom: '1px solid var(--border-color)' }}>
                                                    {extractedData.tableHeaders ? (
                                                        extractedData.tableHeaders.map((header) => (
                                                            <th key={header} style={{ padding: '8px', textAlign: 'left', textTransform: 'capitalize' }}>
                                                                {header}
                                                            </th>
                                                        ))
                                                    ) : (
                                                        <>
                                                            <th style={{ padding: '8px', textAlign: 'left' }}>Description</th>
                                                            <th style={{ padding: '8px', textAlign: 'right' }}>Qty</th>
                                                            <th style={{ padding: '8px', textAlign: 'right' }}>Rate</th>
                                                            <th style={{ padding: '8px', textAlign: 'right' }}>Amount</th>
                                                        </>
                                                    )}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {extractedData.lineItems.map((item) => (
                                                    <tr key={`${item.description || ''}-${item.quantity || ''}-${item.amount || ''}`} style={{ borderBottom: '1px solid var(--border-color-light)' }}>
                                                        {extractedData.tableHeaders ? (
                                                            extractedData.tableHeaders.map((header, hIdx) => {
                                                                // Find the key corresponding to this header
                                                                // We stored normalized keys in the item
                                                                let key = header.toLowerCase();
                                                                if (key.includes('desc') || key.includes('particular')) key = 'description';
                                                                else if (key.includes('qty') || key.includes('quant')) key = 'quantity';
                                                                else if (key.includes('rate') || key.includes('price')) key = 'rate';
                                                                else if (key.includes('amount') || key.includes('total')) key = 'amount';
                                                                else key = header; // Custom key

                                                                // Try flexible lookup
                                                                const lookupKey = Object.keys(item).find((k) => k.toLowerCase().includes(header.toLowerCase()));
                                                                const val = item[key] || item[header] || item[lookupKey] || '';

                                                                return (
                                                                    <td key={`${header}-${hIdx}-${String(val)}`} style={{ padding: '8px' }}>{val}</td>
                                                                );
                                                            })
                                                        ) : (
                                                            <>
                                                                <td style={{ padding: '8px' }}>{item.description}</td>
                                                                <td style={{ padding: '8px', textAlign: 'right' }}>{item.quantity}</td>
                                                                <td style={{ padding: '8px', textAlign: 'right' }}>{item.rate}</td>
                                                                <td style={{ padding: '8px', textAlign: 'right' }}>{item.amount}</td>
                                                            </>
                                                        )}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}

                            <div style={{
                                border: '2px solid #E0E0E0',
                                borderRadius: 'var(--radius-md)',
                                overflow: 'hidden',
                                background: 'rgba(255, 255, 255, 0.05)',
                                marginTop: '1.5rem' // Added margin to separate from table
                            }}>
                                {activeFile?.type === 'application/pdf' ? (
                                    <embed
                                        src={`${preview}#zoom=${previewZoom}`}
                                        type="application/pdf"
                                        style={{
                                            width: '100%',
                                            height: '600px',
                                            border: 'none'
                                        }}
                                    />
                                ) : (
                                    <img
                                        src={preview}
                                        alt="Invoice preview"
                                        style={{
                                            width: '100%',
                                            maxHeight: '600px',
                                            objectFit: 'contain',
                                            background: '#fff',
                                            transform: `scale(${previewZoom / 100})`,
                                            transformOrigin: 'center top'
                                        }}
                                    />
                                )}
                            </div>
                        </div>
                    )}
                </div>}

                {/* Full Screen Modal */}
                {isFullScreen && preview && (
                    <div className="app-modal-backdrop" style={{ zIndex: 9999, padding: '2rem', background: 'rgba(0,0,0,0.85)' }}>
                        <div className="app-modal" style={{ width: '90%', height: '90%', maxWidth: 'none', padding: '1rem', display: 'flex', flexDirection: 'column' }}>
                            <div className="flex justify-between items-center mb-md">
                                <h3 style={{ margin: 0 }}>File Preview</h3>
                                <div className="flex items-center gap-sm">
                                    <div className="flex items-center gap-sm" style={{ background: 'rgba(255,255,255,0.9)', padding: '0.35rem 0.5rem', borderRadius: 'var(--radius-md)' }}>
                                        <button
                                            type="button"
                                            className="btn btn-sm btn-outline"
                                            onClick={() => setPreviewZoom((prev) => Math.max(50, prev - 10))}
                                            title="Zoom out"
                                        >
                                            -
                                        </button>
                                        <span style={{ minWidth: '48px', textAlign: 'center', fontWeight: 600 }}>{previewZoom}%</span>
                                        <button
                                            type="button"
                                            className="btn btn-sm btn-outline"
                                            onClick={() => setPreviewZoom((prev) => Math.min(300, prev + 10))}
                                            title="Zoom in"
                                        >
                                            +
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-sm btn-outline"
                                            onClick={() => setPreviewZoom(100)}
                                            title="Reset zoom"
                                        >
                                            Reset
                                        </button>
                                    </div>

                                    <button
                                        onClick={() => setIsFullScreen(false)}
                                        style={{
                                            background: '#EF4444',
                                            color: 'white',
                                            border: 'none',
                                            padding: '0.5rem 1rem',
                                            borderRadius: 'var(--radius-md)',
                                            cursor: 'pointer',
                                            fontWeight: 600
                                        }}
                                    >
                                        ✕ Close
                                    </button>
                                </div>
                            </div>

                            <div style={{ flex: 1, overflow: 'auto', background: '#f0f0f0', borderRadius: '4px' }}>
                                {activeFile?.type === 'application/pdf' ? (
                                    <embed
                                        src={`${preview}#zoom=${previewZoom}`}
                                        type="application/pdf"
                                        style={{ width: '100%', height: '100%', border: 'none' }}
                                    />
                                ) : (
                                    <img
                                        src={preview}
                                        alt="Full screen preview"
                                        style={{ width: '100%', height: '100%', objectFit: 'contain', transform: `scale(${previewZoom / 100})`, transformOrigin: 'center top' }}
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default VendorUploadPage;
