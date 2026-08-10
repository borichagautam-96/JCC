import React, { useState, useEffect, useRef } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { DEPARTMENT_CODES } from '../constants/departments';
import { useDialog } from '../components/DialogProvider';
import DatePicker from '../components/DatePicker';
import { useLocation, useNavigate } from 'react-router-dom';
import '../voucher-styles.css';
import { getVendorNames } from '../utils/vendorList';
import { formatDateTimeShort, toDateInputValue } from '../utils/datetime';

// Animated PDF-extraction step sequence (visual only — overlays the real extract call).
const EXTRACT_STEPS = [
    '📄 Reading PDF…',
    '🧠 AI detecting Invoice Number…',
    '🏢 Reading Vendor Name…',
    '📅 Extracting Invoice Date…',
    '💰 Detecting Amount…',
    '📑 Reading GST Details…',
    '✅ Extraction Complete',
];
const formatFileSize = (bytes) => {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const CLAIM_DATE_LOOKBACK_DAYS = 15;
const INVOICE_DATE_LOOKBACK_DAYS = 15;
// Outdoor/field-duty exception: allows an invoice older than 15 days (bounded).
const OUTDOOR_DUTY_LOOKBACK_DAYS = 45;
const OUTDOOR_REMARK_MIN_LENGTH = 10;

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

const getMinOutdoorDateValue = () => {
    const date = new Date();
    date.setDate(date.getDate() - OUTDOOR_DUTY_LOOKBACK_DAYS);
    return toDateInputValue(date);
};

const normalizePoNumber = (value) => String(value || '').trim().toUpperCase();

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
        // Defaults to the code every voucher used while the field was hardcoded, so
        // nothing changes for anyone who does not touch it.
        departmentCode: DEPARTMENT_CODES[0],
        claimedDate: getTodayDateValue(),

        // Voucher Header
        supplier: extractedData.vendorName || extractedData.vendor_name || '',
        buyerName: '',
        buyerEmail: '',
        expenseBookingLocation: '',
        description: '', // User writes this manually per request
        invoiceNumber: extractedData.invoiceNumber || extractedData.invoice_number || '',
        invoiceDate: extractedData.date || extractedData.invoice_date || '',
        // Outdoor/field-duty exception (invoice older than 15 days)
        outdoorDuty: false,
        outdoorFrom: '',
        outdoorTo: '',
        outdoorRemark: '',
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
        { amount: '', projectCode: '', projectName: '', descriptionOfMaterial: '', quantity: '' }
    ]);

    const [attachmentFile, setAttachmentFile] = useState(null);
    // Visual-only extraction progress: -1 idle, 0..5 processing steps, 6 complete.
    const [extractStep, setExtractStep] = useState(-1);
    const wasExtractingRef = useRef(false);
    const [managers, setManagers] = useState([]);
    const [finalApprovers, setFinalApprovers] = useState([]);

    // Productivity: drafts, clone, GST auto-split
    const [draftId, setDraftId] = useState(null);
    const [drafts, setDrafts] = useState([]);
    const [savingDraft, setSavingDraft] = useState(false);
    const [draftStatus, setDraftStatus] = useState(''); // e.g. "Saved 2:04 PM"
    const [gstRate, setGstRate] = useState('');
    const [duplicateInfo, setDuplicateInfo] = useState(null); // possible duplicate invoice
    const autoSaveTimer = useRef(null);
    const dupTimer = useRef(null);
    const formTouched = useRef(false);
    const draftIdRef = useRef(null);          // synchronous draft id (state lags in closures)
    const draftSaveQueue = useRef(Promise.resolve()); // serialize saves → never double-create


    const [submitting, setSubmitting] = useState(false);
    const [isExtracting, setIsExtracting] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');
    const [extractedLines, setExtractedLines] = useState([]);

    // Drive the animated extraction step sequence off the real isExtracting flag.
    useEffect(() => {
        if (isExtracting) {
            wasExtractingRef.current = true;
            setExtractStep(0);
            const id = setInterval(() => {
                setExtractStep((s) => (s < EXTRACT_STEPS.length - 2 ? s + 1 : s)); // hold at last processing step
            }, 280);
            return () => clearInterval(id);
        }
        if (wasExtractingRef.current) {
            wasExtractingRef.current = false;
            setExtractStep(EXTRACT_STEPS.length - 1); // ✅ Extraction Complete
            const t = setTimeout(() => setExtractStep(-1), 1100);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [isExtracting]);
    const [poSuppliers, setPoSuppliers] = useState([]);
    const [poOptions, setPoOptions] = useState([]);
    const [poLookup, setPoLookup] = useState({});
    const [poBudgetMap, setPoBudgetMap] = useState({}); // poNumber -> budget info

    const authHeaders = () => ({ 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() });

    const handleSupplierSelection = (value) => {
        setFormData(prev => ({
            ...prev,
            supplier: value,
            poNumber: '',
            buyerName: '',
            buyerEmail: ''
        }));
        setPoOptions([]);
        setPoLookup({});

        // Smart chained autofill: pull PO / buyer / project / approvers from the
        // user's most recent claim for this vendor, filling only empty fields.
        const supplier = String(value || '').trim();
        if (!supplier) return;
        (async () => {
            try {
                const res = await fetch(`/api/jcc/last-used-by-vendor?supplier=${encodeURIComponent(supplier)}`, { headers: authHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                const p = data?.prefill;
                if (!p) return;
                setFormData(prev => ({
                    ...prev,
                    poNumber: prev.poNumber || p.poNumber || '',
                    buyerName: prev.buyerName || p.buyerName || '',
                    buyerEmail: prev.buyerEmail || p.buyerEmail || '',
                    department: prev.department || p.department || '',
                    expenseBookingLocation: prev.expenseBookingLocation || p.expenseBookingLocation || '',
                    natureOfExpenses: prev.natureOfExpenses || p.natureOfExpenses || '',
                    projectCode: prev.projectCode || p.projectCode || '',
                    projectName: prev.projectName || p.projectName || '',
                    approver1: prev.approver1 || p.approver1 || '',
                    approver2: prev.approver2 || p.approver2 || '',
                }));
                if (p.poNumber) {
                    setSuccess(`Auto-filled PO / project / approvers from your last claim for ${supplier}. Review before submitting.`);
                    setTimeout(() => setSuccess(''), 6000);
                }
            } catch (err) {
                console.error('Vendor autofill failed:', err);
            }
        })();
    };

    // ── Drafts: build payload, save (create/update), list, resume, delete ──────
    const buildDraftPayload = () => ({ formData, materials, gstRate });

    // Serialize saves through a promise queue so overlapping saves (auto-save +
    // manual clicks) can never each create a new draft — the first creates, the
    // rest update the SAME draft via draftIdRef.
    const saveDraft = (silent = false) => {
        const run = draftSaveQueue.current.then(() => doSaveDraft(silent));
        draftSaveQueue.current = run.catch(() => {}); // keep the chain alive on errors
        return run;
    };

    const doSaveDraft = async (silent) => {
        try {
            if (!silent) setSavingDraft(true);
            const res = await fetch('/api/jcc/drafts', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                // draftIdRef is synchronous — after the first save it's set, so this
                // becomes an UPDATE of the same draft, not a new one.
                body: JSON.stringify({ id: draftIdRef.current, title: formData.supplier || formData.invoiceNumber || 'Untitled draft', formData: buildDraftPayload() }),
            });
            if (!res.ok) throw new Error('Save failed');
            const data = await res.json();
            if (data.id) { draftIdRef.current = data.id; setDraftId(data.id); }
            setDraftStatus(`Draft saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
            if (!silent) {
                await loadDrafts();
                await dialog.alert('Claim has been saved as a draft.', { title: 'Saved to Drafts', variant: 'success' });
            }
        } catch (err) {
            console.error('Draft save error:', err);
            if (!silent) setError('Could not save draft. Please try again.');
        } finally {
            if (!silent) setSavingDraft(false);
        }
    };

    const loadDrafts = async () => {
        try {
            const res = await fetch('/api/jcc/drafts', { headers: authHeaders() });
            if (res.ok) setDrafts(await res.json());
        } catch (err) {
            console.error('Load drafts error:', err);
        }
    };

    const resumeDraft = async (id) => {
        if (!id) return;
        try {
            const res = await fetch(`/api/jcc/drafts/${id}`, { headers: authHeaders() });
            if (!res.ok) throw new Error('Draft not found');
            const data = await res.json();
            const saved = data.formData || {};
            if (saved.formData) {
                setFormData(prev => ({ ...prev, ...saved.formData }));
                if (Array.isArray(saved.materials) && saved.materials.length) setMaterials(saved.materials);
                if (saved.gstRate !== undefined) setGstRate(saved.gstRate);
            } else {
                // Backwards-compatible: draft stored the formData object directly
                setFormData(prev => ({ ...prev, ...saved }));
            }
            draftIdRef.current = id;
            setDraftId(id);
            setDraftStatus('Draft resumed');
            setSuccess('Draft loaded — finish and submit when ready.');
            setTimeout(() => setSuccess(''), 5000);
        } catch (err) {
            console.error('Resume draft error:', err);
            setError('Could not open that draft.');
        }
    };

    const deleteDraft = async (id) => {
        try {
            await fetch(`/api/jcc/drafts/${id}`, { method: 'DELETE', headers: authHeaders() });
            if (id === draftId) { draftIdRef.current = null; setDraftId(null); }
            loadDrafts();
        } catch (err) {
            console.error('Delete draft error:', err);
        }
    };

    // Repeat last claim — prefill vendor/PO/project/approvers from the most recent claim
    const repeatLastClaim = async () => {
        try {
            const res = await fetch('/api/jcc/last-claim', { headers: authHeaders() });
            if (!res.ok) throw new Error('No previous claim');
            const data = await res.json();
            if (!data.prefill) { setError('No previous claim found to repeat.'); return; }
            applyPrefill(data.prefill);
            setSuccess(`Cloned from ${data.fromJcc || 'your last claim'}. Update the invoice number, date and amount.`);
            setTimeout(() => setSuccess(''), 7000);
        } catch (err) {
            console.error('Repeat last claim error:', err);
            setError('Could not load your last claim.');
        }
    };

    // Apply a prefill object (from clone / repeat), keeping invoice-specific fields blank
    const applyPrefill = (p) => {
        // Cloning/repeating starts a NEW claim → a fresh draft, not the current one
        draftIdRef.current = null;
        setDraftId(null);
        setFormData(prev => ({
            ...prev,
            supplier: p.supplier || prev.supplier,
            buyerName: p.buyerName || '',
            buyerEmail: p.buyerEmail || '',
            department: p.department || prev.department,
            expenseBookingLocation: p.expenseBookingLocation || '',
            natureOfExpenses: p.natureOfExpenses || '',
            poNumber: p.poNumber || '',
            projectCode: p.projectCode || '',
            projectName: p.projectName || '',
            approver1: p.approver1 || '',
            approver2: p.approver2 || '',
            // Invoice-specific fields intentionally cleared for re-entry
            invoiceNumber: '',
            invoiceDate: '',
            basicAmount: '',
            grossAmount: '',
            projectAmount: '',
        }));
    };

    // GST auto-split: when a GST rate is chosen, derive Basic from Gross (or Gross from Basic)
    const applyGstRate = (rate) => {
        setGstRate(rate);
        const r = parseFloat(rate);
        if (!(r > 0)) return;
        const basic = parseFloat(formData.basicAmount);
        const gross = parseFloat(formData.grossAmount);
        if (gross > 0) {
            const derivedBasic = gross / (1 + r / 100);
            setFormData(prev => ({ ...prev, basicAmount: derivedBasic.toFixed(2) }));
        } else if (basic > 0) {
            const derivedGross = basic * (1 + r / 100);
            setFormData(prev => ({ ...prev, grossAmount: derivedGross.toFixed(2) }));
        }
    };


    const handleExtractWithPDF = async () => {
        if (!attachmentFile) {
            setError('Please select a file first.');
            return;
        }

        const fileType = String(attachmentFile.type || '').toLowerCase();
        const fileName = String(attachmentFile.name || '').toLowerCase();
        if (fileType !== 'application/pdf' && !fileName.endsWith('.pdf')) {
            setError('Only PDF files are supported for OpenDataLoader extraction.');
            return;
        }

        setIsExtracting(true);
        setError('');
        setSuccess('');

        try {
            const formDataToSend = new FormData();
            formDataToSend.append('invoice', attachmentFile);

            const response = await fetch('/api/jcc/extract-pdf', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: formDataToSend
            });

            if (!response.ok) {
                let errText = await response.text();
                try {
                    const json = JSON.parse(errText);
                    if (json.error) errText = json.error;
                } catch (e) {}
                throw new Error(errText || 'PDF extraction failed');
            }

            const data = await response.json();

            // ── Compute basicAmount and grossAmount from line items if backend didn't derive them ──
            const dataLineItems = data.lineItems || [];
            const nonSummary = dataLineItems.filter(item => !item.isSummary);
            if (nonSummary.length > 0) {
                const itemsSum = nonSummary.reduce((sum, item) => {
                    const raw = String(item.amount || '').replace(/[₹,\s]/g, '');
                    return sum + (parseFloat(raw) || 0);
                }, 0);
                if (itemsSum > 0) {
                    if (!data.basicAmount || parseFloat(data.basicAmount) <= 0) {
                        data.basicAmount = itemsSum.toFixed(2);
                    }
                    if (!data.amount || parseFloat(data.amount) <= 0) {
                        data.amount = (parseFloat(data.basicAmount) * 1.18).toFixed(2);
                    }
                }
            }

            setFormData(prev => ({
                ...prev,
                supplier: data.vendorName || prev.supplier,
                invoiceNumber: data.invoiceNumber || prev.invoiceNumber,
                invoiceDate: data.date || prev.invoiceDate,
                // grossAmount = total with tax (Invoice Total), basicAmount = without tax
                grossAmount: data.amount || prev.grossAmount,
                basicAmount: data.basicAmount || prev.basicAmount,
                poNumber: data.poNumber || prev.poNumber,
                // Remark is intentionally NOT auto-filled — user must write it manually
            }));


            if (data.lineItems && data.lineItems.length > 0) {
                setExtractedLines(data.lineItems);

                
                // Auto-populate Project Details with smart description matching (excluding summary rows)
                const newMaterials = data.lineItems
                    .filter(item => !item.isSummary)
                    .map(item => ({
                    descriptionOfMaterial: item.description || item.text || '',
                    amount: item.amount ? item.amount.toString().replace(/[^0-9.-]/g, '') : '',
                    quantity: item.quantity ? item.quantity.toString().replace(/[^0-9.-]/g, '') : '',
                    unitPrice: item.unitPrice ? item.unitPrice.toString().replace(/[^0-9.-]/g, '') : '',
                    projectCode: '',
                    projectName: ''
                }));
                setMaterials(newMaterials);
            }

            // Honest feedback: count how many key fields we actually captured.
            const capturedFields = [data.vendorName, data.invoiceNumber, data.date, data.amount, data.poNumber].filter(v => v && String(v).trim());
            const gotLineItems = data.lineItems && data.lineItems.length > 0;
            const rawTextLen = (data.rawText || '').replace(/!\[.*?\]\(.*?\)/g, '').trim().length;

            if (capturedFields.length === 0 && !gotLineItems) {
                // Nothing usable came back — almost always a scanned copy the OCR couldn't read
                setSuccess('');
                setError(
                    rawTextLen < 20
                        ? '⚠ This looks like a scanned or photographed copy we could not read automatically. Please enter the Invoice Number, Date, Amount and PO manually below.'
                        : '⚠ We could not confidently read the key fields from this file. Please check and enter the Invoice Number, Date, Amount and PO manually below.'
                );
            } else {
                const missing = [];
                if (!data.invoiceNumber) missing.push('Invoice No.');
                if (!data.date) missing.push('Date');
                if (!data.amount) missing.push('Amount');
                if (!data.poNumber) missing.push('PO');
                const base = `✓ Extracted — Invoice: ${data.invoiceNumber || '—'} | Amount: ${data.amount || '—'} | Date: ${data.date || '—'} | PO: ${data.poNumber || '—'}`;
                setError('');
                setSuccess(missing.length ? `${base}. Please fill the remaining field(s) manually: ${missing.join(', ')}.` : base);
                setTimeout(() => setSuccess(''), 9000);
            }

        } catch (err) {
            console.error(err);
            setError(err.message);
        } finally {
            setIsExtracting(false);
        }
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
                // Auto-populate Project Details (excluding summary rows)
                const newMaterials = data.lineItems
                    .filter(item => !item.isSummary)
                    .map(item => ({
                    descriptionOfMaterial: item.description || item.text || '',
                    amount: item.amount ? item.amount.toString().replace(/[^0-9.-]/g, '') : '',
                    projectCode: '',
                    projectName: ''
                }));
                setMaterials(newMaterials);
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
        const { name, value, type, checked } = e.target;
        formTouched.current = true;
        if (type === 'checkbox') {
            if (name === 'outdoorDuty' && !checked) {
                // Clearing the exception resets its dependent fields
                setFormData({ ...formData, outdoorDuty: false, outdoorFrom: '', outdoorTo: '', outdoorRemark: '' });
                return;
            }
            setFormData({ ...formData, [name]: checked });
            return;
        }
        // Auto-apply 18% GST: typing the Basic Amount fills Gross = Basic + 18%.
        if (name === 'basicAmount') {
            const b = parseFloat(value);
            setFormData(prev => ({
                ...prev,
                basicAmount: value,
                grossAmount: b > 0 ? (b * 1.18).toFixed(2) : '',
            }));
            return;
        }
        setFormData({ ...formData, [name]: value });
    };

    // Handle material entry changes
    const handleMaterialChange = (index, field, value) => {
        formTouched.current = true;
        const updatedMaterials = [...materials];
        updatedMaterials[index][field] = value;
        setMaterials(updatedMaterials);
    };

    // Removed auto-calculation of Basic Amount from materials sum to prevent overwriting OCR basicAmount

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

    // On mount: load the user's saved drafts, and apply any clone prefill passed
    // in via navigation state (from the "Clone" button on Voucher History).
    useEffect(() => {
        loadDrafts();
        const clonePrefill = location.state?.prefill;
        if (clonePrefill) {
            applyPrefill(clonePrefill);
            setSuccess('Cloned claim — update the invoice number, date and amount, then submit.');
            setTimeout(() => setSuccess(''), 7000);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Auto-save: once the user has meaningfully started a claim, debounce-save the
    // draft so nothing is lost (great for field users who get interrupted).
    useEffect(() => {
        if (!formTouched.current) return;
        const hasContent = String(formData.supplier || '').trim() || String(formData.invoiceNumber || '').trim() || String(formData.grossAmount || '').trim();
        if (!hasContent) return;
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = setTimeout(() => { saveDraft(true); }, 4000);
        return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formData, materials]);

    // Duplicate-invoice check — warn early if this vendor+invoice already exists
    useEffect(() => {
        const supplier = String(formData.supplier || '').trim();
        const invoiceNumber = String(formData.invoiceNumber || '').trim();
        if (!supplier || !invoiceNumber) { setDuplicateInfo(null); return; }
        if (dupTimer.current) clearTimeout(dupTimer.current);
        dupTimer.current = setTimeout(async () => {
            try {
                const params = new URLSearchParams({ supplier, invoiceNumber, amount: formData.basicAmount || '' });
                const res = await fetch(`/api/jcc/check-duplicate?${params.toString()}`, { headers: authHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                setDuplicateInfo(data.duplicates && data.duplicates.length > 0 ? data.duplicates : null);
            } catch (err) {
                console.warn('Duplicate check failed:', err);
            }
        }, 600);
        return () => { if (dupTimer.current) clearTimeout(dupTimer.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formData.supplier, formData.invoiceNumber, formData.basicAmount]);

    useEffect(() => {
        const fetchPoList = async () => {
            const supplier = String(formData.supplier || '').trim();
            if (!supplier) {
                setPoOptions([]);
                setPoLookup({});
                return;
            }

            try {
                const response = await fetch(`/api/purchase-orders/by-vendor?vendor=${encodeURIComponent(supplier)}`, {
                    headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
                });

                if (!response.ok) {
                    setPoOptions([]);
                    setPoLookup({});
                    return;
                }

                const data = await response.json();
                const rows = Array.isArray(data) ? data : [];
                const lookup = rows.reduce((acc, row) => {
                    if (row?.po_number) {
                        acc[normalizePoNumber(row.po_number)] = row;
                    }
                    return acc;
                }, {});

                setPoOptions(rows);
                setPoLookup(lookup);

                // Fetch budget status for all POs of this supplier in parallel
                // so we can mark exceeded/near-limit ones in the dropdown
                const budgetResults = await Promise.allSettled(
                    rows.map(async (po) => {
                        const r = await fetch(
                            `/api/dashboard/po-budget/${encodeURIComponent(po.po_number)}`,
                            { headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() } }
                        );
                        if (!r.ok) return null;
                        const b = await r.json();
                        return b.found ? { poNumber: po.po_number, ...b } : null;
                    })
                );
                const budgetMap = {};
                for (const result of budgetResults) {
                    if (result.status === 'fulfilled' && result.value) {
                        budgetMap[normalizePoNumber(result.value.poNumber)] = result.value;
                    }
                }
                setPoBudgetMap(budgetMap);

                const normalizedPo = normalizePoNumber(formData.poNumber);
                if (normalizedPo && lookup[normalizedPo]) {
                    setFormData(prev => ({
                        ...prev,
                        buyerName: lookup[normalizedPo]?.buyer_name || '',
                        buyerEmail: lookup[normalizedPo]?.buyer_email || ''
                    }));
                }
            } catch (error) {
                console.error('Error fetching PO list:', error);
                setPoOptions([]);
                setPoLookup({});
            }
        };

        fetchPoList();
    }, [formData.supplier, getToken]);

    const handlePoSelection = async (value) => {
        const selectedPo = poLookup[normalizePoNumber(value)] || null;
        setFormData(prev => ({
            ...prev,
            poNumber: value,
            buyerName: selectedPo?.buyer_name || '',
            buyerEmail: selectedPo?.buyer_email || ''
        }));

        if (!value || !value.trim()) return;

        // Real-time PO budget check
        try {
            const res = await fetch(`/api/dashboard/po-budget/${encodeURIComponent(value.trim())}`, {
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });
            if (!res.ok) return;
            const budget = await res.json();
            if (!budget.found) return;

            const fmt = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

            if (budget.isExceeded) {
                // EXCEEDED: hard block — show error and immediately deselect the PO
                await dialog.alert(
                    `PO Number: ${budget.poNumber}\n` +
                    `Total Budget: ${fmt(budget.totalAmount)}\n` +
                    `Amount Used: ${fmt(budget.usedAmount)}\n` +
                    `Overspent by: ${fmt(Math.abs(budget.remainingAmount))}\n` +
                    `Utilization: ${budget.utilizationPercent}%\n\n` +
                    `This PO has exceeded its approved budget and cannot be used for new claims.`,
                    {
                        title: '🚨 PO Blocked — Budget Exceeded!',
                        variant: 'error',
                    }
                );
                // Always deselect — no way to bypass
                setFormData(prev => ({ ...prev, poNumber: '', buyerName: '', buyerEmail: '' }));

            } else if (budget.isNearLimit) {
                // NEAR LIMIT: warning only, PO stays selected
                await dialog.alert(
                    `PO Number: ${budget.poNumber}\n` +
                    `Total Budget: ${fmt(budget.totalAmount)}\n` +
                    `Amount Used: ${fmt(budget.usedAmount)}\n` +
                    `Remaining: ${fmt(budget.remainingAmount)}\n` +
                    `Utilization: ${budget.utilizationPercent}%\n\n` +
                    `This PO is approaching its budget limit. Please verify the claim amount before submitting.`,
                    {
                        title: '⚠️ PO Budget Near Limit',
                        variant: 'warning',
                    }
                );
            }
        } catch (err) {
            console.warn('PO budget check failed (non-critical):', err.message);
        }
    };

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
        setMaterials([...materials, { amount: '', projectCode: '', projectName: '', descriptionOfMaterial: '', quantity: '' }]);

    };

    // Remove material entry
    const removeMaterial = (index) => {
        if (materials.length > 1) {
            setMaterials(materials.filter((_, i) => i !== index));
        }
    };

    // Completeness check — collect ALL missing required fields at once so the user
    // fixes everything before submitting, instead of bouncing back one field at a time.
    const getMissingFields = () => {
        const missing = [];
        if (!String(formData.supplier || '').trim()) missing.push('Supplier');
        if (!String(formData.invoiceNumber || '').trim()) missing.push('Invoice Number');
        if (!String(formData.invoiceDate || '').trim()) missing.push('Invoice Date');
        if (!(parseFloat(formData.basicAmount) > 0)) missing.push('Basic Amount');
        if (!(parseFloat(formData.grossAmount) > 0)) missing.push('Gross Amount');
        if (!String(formData.approver1 || '').trim()) missing.push('Approver 1 (Manager)');
        if (!String(formData.approver2 || '').trim()) missing.push('Approver 2 (Final Approver)');
        const hasMaterial = materials.some(m => parseFloat(m.amount) > 0);
        if (!hasMaterial) missing.push('At least one Project/Material row with an amount');
        return missing;
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        // Pre-flight completeness check (one clear message, all gaps at once)
        const missing = getMissingFields();
        if (missing.length > 0) {
            setError(`Please complete the following before submitting: ${missing.join(', ')}.`);
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }

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

            const maxInvoiceDate = getTodayDateValue();
            const invoiceDateValue = String(formData.invoiceDate || '').trim();
            if (!invoiceDateValue) {
                throw new Error('Invoice Date is required');
            }

            if (formData.outdoorDuty) {
                // Outdoor/field-duty exception: validate the trip window and that the
                // invoice actually falls inside it (mirrors the server-side rules).
                const outdoorFromValue = String(formData.outdoorFrom || '').trim();
                const outdoorToValue = String(formData.outdoorTo || '').trim();
                const outdoorRemarkValue = String(formData.outdoorRemark || '').trim();
                const minOutdoorDate = getMinOutdoorDateValue();

                if (!outdoorFromValue || !outdoorToValue) {
                    throw new Error('Please enter both outdoor duty "From" and "To" dates');
                }
                if (outdoorRemarkValue.length < OUTDOOR_REMARK_MIN_LENGTH) {
                    throw new Error(`Please provide a reason for the outdoor duty (at least ${OUTDOOR_REMARK_MIN_LENGTH} characters)`);
                }
                if (outdoorFromValue > outdoorToValue) {
                    throw new Error('Outdoor duty "From" date cannot be after the "To" date');
                }
                if (outdoorToValue > maxInvoiceDate) {
                    throw new Error('Outdoor duty "To" date cannot be in the future');
                }
                if (outdoorFromValue < minOutdoorDate) {
                    throw new Error(`Outdoor duty cannot start more than ${OUTDOOR_DUTY_LOOKBACK_DAYS} days ago`);
                }
                if (invoiceDateValue < outdoorFromValue || invoiceDateValue > maxInvoiceDate) {
                    throw new Error('Invoice Date must fall within your outdoor duty period');
                }
            } else {
                const minInvoiceDate = getMinInvoiceDateValue();
                if (invoiceDateValue < minInvoiceDate || invoiceDateValue > maxInvoiceDate) {
                    throw new Error(`Invoice Date must be within the last ${INVOICE_DATE_LOOKBACK_DAYS} days`);
                }
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

            // ── PO Budget Check at Submit Time ────────────────────────────────────────────
            // Layer 1: Synchronous pre-check using poBudgetMap (already loaded, no network)
            // Layer 2: Async check with claim amount to the API
            // FAIL-SAFE: if async check fails, fall back to sync data
            const selectedPoNumber = String(formData.poNumber || '').trim();
            if (selectedPoNumber) {
                const fmt = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
                const claimAmt = basicAmount; // already parsed above

                // Layer 1 — synchronous check against already-loaded poBudgetMap
                const syncBudget = poBudgetMap[normalizePoNumber(selectedPoNumber)];
                if (syncBudget) {
                    const wouldExceedSync = claimAmt > 0 && (syncBudget.usedAmount + claimAmt) > syncBudget.totalAmount;
                    if (syncBudget.isExceeded || wouldExceedSync) {
                        const overBy = syncBudget.isExceeded
                            ? Math.abs(syncBudget.remainingAmount)
                            : (syncBudget.usedAmount + claimAmt) - syncBudget.totalAmount;
                        await dialog.alert(
                            `You cannot submit this claim.\n\n` +
                            `PO Number: ${selectedPoNumber}\n` +
                            `Total Budget: ${fmt(syncBudget.totalAmount)}\n` +
                            `Already Used: ${fmt(syncBudget.usedAmount)}\n` +
                            `Remaining: ${fmt(syncBudget.remainingAmount)}\n` +
                            (claimAmt > 0 ? `This Claim Amount: ${fmt(claimAmt)}\n` : '') +
                            `\nThis PO ${syncBudget.isExceeded ? 'has exceeded' : 'would exceed'} its approved budget by ${fmt(overBy)}.\nPlease select a different PO.`,
                            { title: '🚨 Cannot Submit — PO Budget Exceeded!', variant: 'error' }
                        );
                        setSubmitting(false);
                        return;
                    }
                }

                // Layer 2 — async API check (with claimAmount for precise calculation)
                let poBlocked = false;
                let poBlockMsg = '';
                let asyncCheckDone = false;

                try {
                    const budgetUrl = `/api/dashboard/po-budget/${encodeURIComponent(selectedPoNumber)}` +
                        (claimAmt > 0 ? `?claimAmount=${claimAmt}` : '');
                    const budgetRes = await fetch(budgetUrl,
                        { headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() } }
                    );
                    if (budgetRes.ok) {
                        const budget = await budgetRes.json();
                        asyncCheckDone = true;
                        if (budget.found && (budget.isExceeded || budget.wouldExceed)) {
                            poBlocked = true;
                            const overBy = budget.isExceeded
                                ? Math.abs(budget.remainingAmount)
                                : (budget.usedAmount + claimAmt) - budget.totalAmount;
                            poBlockMsg =
                                `You cannot submit this claim.\n\n` +
                                `PO Number: ${budget.poNumber}\n` +
                                `Total Budget: ${fmt(budget.totalAmount)}\n` +
                                `Already Used: ${fmt(budget.usedAmount)}\n` +
                                `Remaining Budget: ${fmt(budget.remainingAmount)}\n` +
                                (claimAmt > 0 ? `This Claim Amount: ${fmt(claimAmt)}\n` : '') +
                                `\nThis PO ${budget.isExceeded ? 'has exceeded' : 'would exceed'} its approved budget by ${fmt(overBy)}.\nPlease select a different PO.`;
                        }
                    }
                } catch (budgetNetworkErr) {
                    console.warn('PO budget API check failed:', budgetNetworkErr.message);
                    // asyncCheckDone remains false — fall through to fail-safe below
                }

                // If async check failed (network error) AND sync data says it could be a problem → BLOCK
                if (!asyncCheckDone && syncBudget) {
                    const wouldExceed2 = claimAmt > 0 && (syncBudget.usedAmount + claimAmt) > syncBudget.totalAmount;
                    if (syncBudget.isNearLimit || syncBudget.isExceeded || wouldExceed2) {
                        poBlocked = true;
                        poBlockMsg =
                            `Cannot verify PO budget — please try again.\n\n` +
                            `PO ${selectedPoNumber} is near or over its limit.\n` +
                            `Please verify the PO budget before submitting.`;
                    }
                }

                // Final gate — if blocked for ANY reason, stop submission
                if (poBlocked) {
                    await dialog.alert(poBlockMsg, { title: '🚨 Cannot Submit — PO Budget Exceeded!', variant: 'error' });
                    setSubmitting(false);
                    return;
                }
            }

            // ── Build FormData entirely from React state ──────────────────────────────────
            // React controlled inputs are the ONLY reliable source of truth.
            // new FormData(e.currentTarget) reads DOM values which can be stale or mismatched
            // for controlled inputs, especially for the materials table rows.
            const formDataToSend = new FormData();

            // Core voucher fields from formData state
            formDataToSend.append('claimedBy', formData.claimedBy || '');
            formDataToSend.append('department', formData.department || '');
            formDataToSend.append('departmentCode', formData.departmentCode || '');
            formDataToSend.append('claimedDate', formData.claimedDate || '');
            formDataToSend.append('supplier', formData.supplier || '');
            formDataToSend.append('expenseBookingLocation', formData.expenseBookingLocation || '');
            formDataToSend.append('description', formData.description || '');
            formDataToSend.append('invoiceNumber', formData.invoiceNumber || '');
            formDataToSend.append('invoiceDate', formData.invoiceDate || '');
            formDataToSend.append('outdoorDuty', formData.outdoorDuty ? 'true' : 'false');
            formDataToSend.append('outdoorFrom', formData.outdoorDuty ? (formData.outdoorFrom || '') : '');
            formDataToSend.append('outdoorTo', formData.outdoorDuty ? (formData.outdoorTo || '') : '');
            formDataToSend.append('outdoorRemark', formData.outdoorDuty ? (formData.outdoorRemark || '') : '');
            formDataToSend.append('basicAmount', formData.basicAmount || '');
            formDataToSend.append('grossAmount', formData.grossAmount || '');
            formDataToSend.append('natureOfExpenses', formData.natureOfExpenses || '');
            formDataToSend.append('poNumber', formData.poNumber || '');
            formDataToSend.append('projectCode', formData.projectCode || '');
            formDataToSend.append('projectName', formData.projectName || '');
            formDataToSend.append('projectAmount', formData.projectAmount || '');
            formDataToSend.append('approver1', formData.approver1 || '');
            formDataToSend.append('approver2', formData.approver2 || '');

            // Attachment file from state
            if (attachmentFile) {
                formDataToSend.append('attachment', attachmentFile);
            }

            // Materials: use React state — always accurate, includes descriptionOfMaterial
            const effectiveMaterials = materials.filter(
                (item) => item.amount || item.projectCode || item.projectName || item.descriptionOfMaterial
            );

            // Append materials as JSON string (three encodings for multipart parser resilience)
            const materialsJson = JSON.stringify(effectiveMaterials);
            formDataToSend.append('materials', materialsJson);
            formDataToSend.append('materialsPayload', materialsJson);
            formDataToSend.append('materialsPayloadB64', btoa(materialsJson));

            // Append invoice ID if this voucher is being created from an assigned invoice
            if (extractedData.id) {
                formDataToSend.append('invoiceId', extractedData.id);
            }

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
                console.log('=== DEBUG: Server response data ===', data);
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
            const jccId = data.jccNumber || (voucherId !== 'Unknown' ? `JCC${String(voucherId).padStart(4, '0')}` : voucherId);
            const successMsg = `✅ JCC Voucher Created Successfully!\n\nJCC No.: ${jccId}\nSupplier: ${formData.supplier}\nAmount: ₹${formData.basicAmount}\n\nYour JCC request has been submitted for approval.`;

            await dialog.alert(successMsg);

            setSuccess(`JCC request created successfully! JCC No.: ${jccId}`);

            // Reset form
            setFormData({
                claimedBy: user?.name || '',
                department: 'Documentation & Training',
                claimedDate: getTodayDateValue(),
                supplier: '',
                buyerName: '',
                buyerEmail: '',
                expenseBookingLocation: '',
                description: '',
                invoiceNumber: '',
                invoiceDate: '',
                outdoorDuty: false,
                outdoorFrom: '',
                outdoorTo: '',
                outdoorRemark: '',
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
            setMaterials([{ amount: '', projectCode: '', projectName: '', descriptionOfMaterial: '', quantity: '' }]);

            // Claim submitted successfully — discard the working draft if any
            if (draftIdRef.current) {
                deleteDraft(draftIdRef.current);
            }
            draftIdRef.current = null;
            setDraftId(null);
            formTouched.current = false;
            setDraftStatus('');

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
                    <h1>Create Claim Request</h1>
                    <p>Fill in the details below to submit a new claim request</p>
                </div>

                {/* Productivity toolbar: repeat last claim, resume a draft, auto-save status */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', margin: '0 0 1rem 0' }}>
                    <button type="button" className="btn btn-outline btn-sm" onClick={repeatLastClaim} title="Clone your most recent claim (vendor, PO, project, approvers)">
                        🔁 Repeat last claim
                    </button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <select
                            className="input-field"
                            style={{ width: 'auto', minWidth: '200px', margin: 0 }}
                            value=""
                            onChange={(e) => { if (e.target.value) resumeDraft(Number(e.target.value)); }}
                        >
                            <option value="">📄 Resume a draft ({drafts.length})</option>
                            {drafts.map(d => (
                                <option key={d.id} value={d.id}>
                                    {(d.title || 'Untitled')} — {formatDateTimeShort(d.updated_at)}
                                </option>
                            ))}
                        </select>
                        {draftId && (
                            <button type="button" className="btn btn-outline btn-sm" title="Delete the current draft" onClick={() => deleteDraft(draftId)}>
                                🗑
                            </button>
                        )}
                    </div>

                    {draftStatus && (
                        <span style={{ fontSize: '0.8rem', color: '#059669' }}>✓ {draftStatus}</span>
                    )}
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

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.65rem', paddingBottom: '0.5rem' }}>
                                <div className="input-group" style={{ marginBottom: 0 }}>
                                    <label className="input-label">Name *</label>
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

                                <div className="input-group" style={{ marginBottom: 0 }}>
                                    <label className="input-label">Department *</label>
                                    <input
                                        type="text"
                                        name="department"
                                        className="input-field voucher-readonly"
                                        value="DOCUMENTATION & TRAINING"
                                        readOnly
                                    />
                                </div>

                                <div className="input-group" style={{ marginBottom: 0 }}>
                                    <label className="input-label">Department Code *</label>
                                    {/* Was a read-only input hardcoded to "3559" — not bound to
                                        formData and never submitted. With two codes in use the
                                        choice has to be made and recorded per voucher. */}
                                    <select
                                        name="departmentCode"
                                        className="input-field"
                                        value={formData.departmentCode}
                                        onChange={handleChange}
                                        required
                                    >
                                        {DEPARTMENT_CODES.map((c) => (
                                            <option key={c} value={c}>{c}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="input-group" style={{ marginBottom: 0 }}>
                                    <label className="input-label">Claim Date *</label>
                                    <DatePicker
                                        name="claimedDate"
                                        value={formData.claimedDate}
                                        onChange={handleChange}
                                        required
                                        min={getMinClaimDateValue()}
                                        max={getTodayDateValue()}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Voucher Header */}
                        <div className="glass-card voucher-section-card">
                            <div className="voucher-section-head">
                                <h3 className="voucher-section-head-title">Claim Header</h3>
                            </div>

                            <div className="voucher-grid-2 voucher-claim-grid">
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
                                    <select
                                        name="poNumber"
                                        className="input-field"
                                        value={formData.poNumber}
                                        onChange={(e) => handlePoSelection(e.target.value)}
                                    >
                                        <option value="">Select PO Number</option>
                                        {poOptions.map((po) => {
                                            const budgetInfo = poBudgetMap[normalizePoNumber(po.po_number)];
                                            const isExceeded = budgetInfo?.isExceeded;
                                            const isNearLimit = budgetInfo?.isNearLimit;
                                            const label = isExceeded
                                                ? `🚨 ${po.po_number} — BLOCKED (${budgetInfo.utilizationPercent}% exceeded)`
                                                : isNearLimit
                                                    ? `⚠️ ${po.po_number} — Near Limit (${budgetInfo.utilizationPercent}%)`
                                                    : po.po_number;
                                            return (
                                                <option
                                                    key={po.po_number}
                                                    value={po.po_number}
                                                    disabled={!!isExceeded}
                                                    style={isExceeded
                                                        ? { color: '#B91C1C', fontWeight: 700, background: '#FEF2F2' }
                                                        : isNearLimit
                                                            ? { color: '#D97706', fontWeight: 600 }
                                                            : {}}
                                                >
                                                    {label}
                                                </option>
                                            );
                                        })}
                                    </select>
                                </div>


                                <div className="input-group">
                                    <label className="input-label">Buyer Name</label>
                                    <input
                                        type="text"
                                        name="buyerName"
                                        className="input-field voucher-readonly"
                                        value={formData.buyerName}
                                        readOnly
                                    />
                                </div>

                                <div className="input-group">
                                    <label className="input-label">Buyer Email</label>
                                    <div className="input-field voucher-readonly" style={{ wordBreak: 'break-word', lineHeight: '1.6' }}>
                                        {formData.buyerEmail || '-'}
                                    </div>
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

                                <div className="input-group full-span">
                                    <label className="input-label">Remark</label>
                                    <textarea
                                        name="description"
                                        className="input-field"
                                        value={formData.description}
                                        onChange={handleChange}
                                        rows="2"
                                        placeholder="Brief remark about the expense"
                                    />
                                </div>
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
                                {duplicateInfo && (
                                    <div style={{ marginTop: '6px', padding: '8px 10px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', fontSize: '0.8rem', color: '#B91C1C' }}>
                                        ⚠ Possible duplicate — this vendor + invoice number is already used by:{' '}
                                        {duplicateInfo.map((d, i) => (
                                            <span key={d.id}>
                                                {i > 0 ? ', ' : ''}
                                                <strong>{d.jccNumber}</strong> ({d.status}{d.sameAmount ? ', same amount' : ''})
                                            </span>
                                        ))}
                                        . An exact same-amount duplicate will be blocked at submit.
                                    </div>
                                )}
                            </div>

                            <div className="input-group">
                                <label className="input-label">Invoice Date *</label>
                                <DatePicker
                                    name="invoiceDate"
                                    value={formData.invoiceDate}
                                    onChange={handleChange}
                                    min={formData.outdoorDuty ? (formData.outdoorFrom || getMinOutdoorDateValue()) : getMinInvoiceDateValue()}
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

                        {/* Outdoor / field-duty exception — allows an invoice older than 15 days */}
                        <div
                            className={`voucher-notice${formData.outdoorDuty ? ' voucher-notice-active' : ''}`}
                            style={{ marginTop: 'var(--spacing-lg)' }}
                        >
                            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', margin: 0 }}>
                                <input
                                    type="checkbox"
                                    name="outdoorDuty"
                                    checked={formData.outdoorDuty}
                                    onChange={handleChange}
                                    style={{ marginTop: '3px', width: '16px', height: '16px', cursor: 'pointer' }}
                                />
                                <span style={{ color: 'var(--text-body)', fontSize: '0.9rem' }}>
                                    <strong>I was on outdoor / field duty</strong> — my invoice is older than {INVOICE_DATE_LOOKBACK_DAYS} days.
                                    <br />
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                        Tick this only if you were away on work. You can then submit an invoice up to {OUTDOOR_DUTY_LOOKBACK_DAYS} days old, but it must fall within your duty period and needs a reason.
                                    </span>
                                </span>
                            </label>

                            {formData.outdoorDuty && (
                                <div className="voucher-grid-3" style={{ marginTop: 'var(--spacing-md)' }}>
                                    <div className="input-group">
                                        <label className="input-label">Outdoor Duty From *</label>
                                        <DatePicker
                                            name="outdoorFrom"
                                            value={formData.outdoorFrom}
                                            onChange={handleChange}
                                            min={getMinOutdoorDateValue()}
                                            max={getTodayDateValue()}
                                            required={formData.outdoorDuty}
                                        />
                                    </div>
                                    <div className="input-group">
                                        <label className="input-label">Outdoor Duty To *</label>
                                        <DatePicker
                                            name="outdoorTo"
                                            value={formData.outdoorTo}
                                            onChange={handleChange}
                                            min={formData.outdoorFrom || getMinOutdoorDateValue()}
                                            max={getTodayDateValue()}
                                            required={formData.outdoorDuty}
                                        />
                                    </div>
                                    <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                                        <label className="input-label">Reason for Outdoor Duty *</label>
                                        <textarea
                                            name="outdoorRemark"
                                            className="input-field"
                                            value={formData.outdoorRemark}
                                            onChange={handleChange}
                                            rows="2"
                                            placeholder="e.g. Site commissioning at Vadodara plant — away from office during this period"
                                            required={formData.outdoorDuty}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="voucher-grid-2" style={{ marginTop: 'var(--spacing-lg)' }}>
                            <div className="input-group">
                                <label className="input-label">Basic Amount * (₹)</label>
                                <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)', margin: '-4px 0 6px 0' }}>
                                    Amount <strong>before</strong> tax — the value shown as “Taxable Value” / “Sub-total” (excluding GST).
                                </span>
                                <input
                                    type="number"
                                    step="0.01"
                                    name="basicAmount"
                                    className="input-field"
                                    value={formData.basicAmount}
                                    onChange={handleChange}
                                    placeholder="e.g. 10000.00 (before GST)"
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Gross Amount (₹)</label>
                                <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)', margin: '-4px 0 6px 0' }}>
                                    Total <strong>including</strong> tax — the final “Invoice Total” / “Grand Total” (basic + GST).
                                </span>
                                <input
                                    type="number"
                                    step="0.01"
                                    name="grossAmount"
                                    className="input-field"
                                    value={formData.grossAmount}
                                    onChange={handleChange}
                                    placeholder="e.g. 11800.00 (with GST)"
                                />
                            </div>
                        </div>

                        {/* GST @ 18% — Gross auto-fills as you type Basic. Button also
                            works the other way (fills Basic from a typed Gross). */}
                        <div style={{ marginTop: '0.75rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '0.82rem', color: 'var(--text-body)' }}>GST @</span>
                            <button
                                type="button"
                                onClick={() => applyGstRate('18')}
                                className="btn btn-sm"
                                style={{
                                    padding: '3px 12px',
                                    fontSize: '0.8rem',
                                    border: '1px solid var(--border-strong)',
                                    background: '#0066CC',
                                    color: '#FFFFFF',
                                    borderRadius: '6px',
                                }}
                            >
                                18%
                            </button>
                            <span style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>
                                Gross fills automatically as you type Basic. (Click 18% to fill Basic from a Gross you entered.)
                            </span>
                        </div>

                        {/* Live tax hint — reassures the user they filled the two amounts the right way round */}
                        {(() => {
                            const basic = parseFloat(formData.basicAmount);
                            const gross = parseFloat(formData.grossAmount);
                            if (!(basic > 0) || !(gross > 0)) {
                                return (
                                    <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--text-faint)' }}>
                                        Tip: Basic is the pre-tax amount; Gross is the full invoice total. Gross is always the larger of the two.
                                    </p>
                                );
                            }
                            if (gross < basic) {
                                return (
                                    <p style={{ marginTop: '0.75rem', fontSize: '0.82rem', color: '#B91C1C', fontWeight: 500 }}>
                                        ⚠ Gross (₹{gross.toLocaleString()}) is less than Basic (₹{basic.toLocaleString()}). Gross must include tax, so it should be higher — you may have swapped the two.
                                    </p>
                                );
                            }
                            const tax = gross - basic;
                            const pct = ((tax / basic) * 100).toFixed(1);
                            return (
                                <p style={{ marginTop: '0.75rem', fontSize: '0.82rem', color: '#047857', fontWeight: 500 }}>
                                    ✓ GST / Tax = Gross − Basic = ₹{tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({pct}% of Basic)
                                </p>
                            );
                        })()}
                    </div>

                    {/* Project Details & Attachment */}
                    <div className="glass-card voucher-section-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                        <div style={{ marginBottom: 'var(--spacing-md)' }}>
                            <h3 className="voucher-section-head-title" style={{ margin: 0 }}>Project Details</h3>
                        </div>

                        {/* Compact Materials Table */}
                        <div style={{ overflowX: 'auto', maxHeight: '300px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '1rem' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                                <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface-2)' }}>
                                    <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border)' }}>
                                        <th style={{ padding: '8px', minWidth: '200px', color: 'var(--text-body)', fontWeight: 600 }}>Description of Materials</th>
                                        <th style={{ padding: '8px', width: '90px', color: 'var(--text-body)', fontWeight: 600 }}>Quantity</th>
                                        <th style={{ padding: '8px', width: '120px', color: 'var(--text-body)', fontWeight: 600 }}>Basic Amount (₹)</th>
                                        <th style={{ padding: '8px', width: '150px', color: 'var(--text-body)', fontWeight: 600 }}>Project/Debit Code</th>
                                        <th style={{ padding: '8px', width: '150px', color: 'var(--text-body)', fontWeight: 600 }}>Project Name</th>
                                        <th style={{ padding: '8px', width: '50px', textAlign: 'center', color: 'var(--text-body)', fontWeight: 600 }}>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {materials.map((material, index) => (
                                        <tr key={index} style={{ borderBottom: '1px solid var(--surface-3)' }}>
                                            <td style={{ padding: '4px 8px' }}>
                                            <input
                                                    type="text"
                                                    className="input-field"
                                                    name={`materials[${index}][descriptionOfMaterial]`}
                                                    style={{ padding: '6px 8px', fontSize: '0.85rem', marginBottom: 0, height: 'auto' }}
                                                    value={material.descriptionOfMaterial || ''}
                                                    onChange={(e) => handleMaterialChange(index, 'descriptionOfMaterial', e.target.value)}
                                                    placeholder="Description"
                                                />
                                            </td>
                                            <td style={{ padding: '4px 8px' }}>
                                            <input
                                                    type="number"
                                                    step="0.01"
                                                    min="0"
                                                    className="input-field"
                                                    name={`materials[${index}][quantity]`}
                                                    style={{ padding: '6px 8px', fontSize: '0.85rem', marginBottom: 0, height: 'auto' }}
                                                    value={material.quantity ?? ''}
                                                    onChange={(e) => handleMaterialChange(index, 'quantity', e.target.value)}
                                                    placeholder="0"
                                                />
                                            </td>
                                            <td style={{ padding: '4px 8px' }}>
                                            <input
                                                    type="number"
                                                    step="0.01"
                                                    className="input-field"
                                                    name={`materials[${index}][amount]`}
                                                    style={{ padding: '6px 8px', fontSize: '0.85rem', marginBottom: 0, height: 'auto' }}
                                                    value={material.amount}
                                                    onChange={(e) => handleMaterialChange(index, 'amount', e.target.value)}
                                                    placeholder="0.00"
                                                />
                                            </td>
                                            <td style={{ padding: '4px 8px' }}>
                                            <input
                                                    type="text"
                                                    className="input-field"
                                                    name={`materials[${index}][projectCode]`}
                                                    style={{ padding: '6px 8px', fontSize: '0.85rem', marginBottom: 0, height: 'auto' }}
                                                    value={material.projectCode}
                                                    onChange={(e) => handleMaterialChange(index, 'projectCode', e.target.value)}
                                                    placeholder="Code"
                                                />
                                            </td>
                                            <td style={{ padding: '4px 8px' }}>
                                            <input
                                                    type="text"
                                                    className="input-field"
                                                    name={`materials[${index}][projectName]`}
                                                    style={{ padding: '6px 8px', fontSize: '0.85rem', marginBottom: 0, height: 'auto' }}
                                                    value={material.projectName}
                                                    onChange={(e) => handleMaterialChange(index, 'projectName', e.target.value)}
                                                    placeholder="Project Name"
                                                />
                                            </td>
                                            <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                                                {materials.length > 1 && (
                                                    <button
                                                        type="button"
                                                        onClick={() => removeMaterial(index)}
                                                        style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: '1.1rem', fontWeight: 'bold' }}
                                                        title="Remove row"
                                                    >
                                                        ✕
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

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
                            <label className="input-label">Attachment (Invoice/Supporting Document)</label>
                            <div className="voucher-file-upload">
                                <input
                                    type="file"
                                    name="attachment"
                                    className="input-field"
                                    onChange={(e) => setAttachmentFile(e.target.files[0])}
                                    accept=".pdf,.jpg,.jpeg,.png"
                                />
                                {attachmentFile && (String(attachmentFile.name).toLowerCase().endsWith('.pdf') || String(attachmentFile.type).toLowerCase() === 'application/pdf') && (
                                    <button
                                        type="button"
                                        onClick={handleExtractWithPDF}
                                        disabled={isExtracting}
                                        className="btn btn-outline voucher-extract-btn"
                                        style={{ marginLeft: '10px' }}
                                    >
                                        {isExtracting ? '⏳ Extracting PDF...' : '📄 Extract from PDF'}
                                    </button>
                                )}
                            </div>
                            {attachmentFile && (
                                <div className="voucher-file-card" key={`${attachmentFile.name}-${attachmentFile.size}`}>
                                    <div className="voucher-file-card-icon">📄</div>
                                    <div className="voucher-file-card-body">
                                        <div className="voucher-file-card-name" title={attachmentFile.name}>{attachmentFile.name}</div>
                                        <div className="voucher-file-card-meta">
                                            Size: {formatFileSize(attachmentFile.size)}
                                            <span className="voucher-file-card-ok"><span className="voucher-file-card-tick">✓</span> Selected</span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {extractStep >= 0 && (
                                <div className="voucher-extract-steps">
                                    <div className="voucher-extract-bar">
                                        <div
                                            className={`voucher-extract-bar-fill${extractStep === EXTRACT_STEPS.length - 1 ? ' is-complete' : ''}`}
                                            style={{ width: `${((extractStep + 1) / EXTRACT_STEPS.length) * 100}%` }}
                                        />
                                    </div>
                                    <ul className="voucher-extract-list">
                                        {EXTRACT_STEPS.map((label, i) => {
                                            const complete = extractStep === EXTRACT_STEPS.length - 1;
                                            const done = complete ? i <= EXTRACT_STEPS.length - 1 : i < extractStep;
                                            const active = !complete && i === extractStep;
                                            const isFinal = i === EXTRACT_STEPS.length - 1;
                                            return (
                                                <li key={i} className={`voucher-extract-step${done ? ' is-done' : ''}${active ? ' is-active' : ''}${isFinal && complete ? ' is-final' : ''}`}>
                                                    <span className="voucher-extract-dot">
                                                        {(done || (isFinal && complete)) ? '✓' : active ? <span className="voucher-extract-spin" /> : ''}
                                                    </span>
                                                    <span className="voucher-extract-label">{label}</span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            )}
                        </div>

                        {extractedLines.length > 0 && (() => {
                            // Calculate total from non-summary line items
                            const lineTotal = extractedLines
                                .filter(item => !item.isSummary)
                                .reduce((sum, item) => {
                                    const raw = String(item.amount || '').replace(/[₹,\s]/g, '');
                                    const num = parseFloat(raw);
                                    return sum + (isNaN(num) ? 0 : num);
                                }, 0);
                            const formattedTotal = lineTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                            return (
                                <div className="glass-card voucher-extracted" style={{ padding: '1rem', marginTop: '1rem' }}>
                                    <h4 style={{ margin: '0 0 0.75rem 0', color: '#0369A1', fontSize: '0.95rem' }}>Extracted Line Items (From PDF)</h4>
                                    <div style={{ overflowX: 'auto', maxHeight: '240px', overflowY: 'auto', border: '1px solid #BAE6FD', borderRadius: '6px' }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                                            <thead style={{ position: 'sticky', top: 0, background: '#E0F2FE' }}>
                                                <tr style={{ textAlign: 'left' }}>
                                                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #7DD3FC', fontWeight: 600 }}>Description</th>
                                                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #7DD3FC', fontWeight: 600 }}>Qty</th>
                                                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #7DD3FC', fontWeight: 600 }}>Rate</th>
                                                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #7DD3FC', fontWeight: 600 }}>Amount</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {extractedLines.filter(item => !item.isSummary).map((item, idx) => (
                                                    <tr key={idx} style={{ borderBottom: '1px solid var(--surface-3)', background: idx % 2 === 0 ? '#FFFFFF' : '#F8FAFC' }}>
                                                        <td style={{ padding: '6px 8px', color: 'var(--text-body)' }}>{item.description || item.text || '-'}</td>
                                                        <td style={{ padding: '6px 8px', color: 'var(--text-body)' }}>{item.quantity || '-'}</td>
                                                        <td style={{ padding: '6px 8px', color: 'var(--text-body)' }}>{item.unitPrice || '-'}</td>
                                                        <td style={{ padding: '6px 8px', color: 'var(--text-body)', fontWeight: 500 }}>{item.amount}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                            <tfoot>
                                                <tr style={{ background: '#EFF6FF', borderTop: '2px solid #7DD3FC' }}>
                                                    <td colSpan={3} style={{ padding: '7px 8px', fontWeight: 700, color: '#0369A1', fontSize: '0.82rem' }}>
                                                        Total Amount
                                                    </td>
                                                    <td style={{ padding: '7px 8px', fontWeight: 700, color: '#0369A1', fontSize: '0.82rem' }}>
                                                        ₹ {formattedTotal}
                                                    </td>
                                                </tr>
                                            </tfoot>
                                        </table>
                                    </div>
                                </div>
                            );
                        })()}

                    </div>

                    {/* Approvers Section */}
                    <div className="glass-card voucher-section-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                        <h3 className="voucher-section-head-title mb-lg">Approvers</h3>

                        <div className="voucher-grid-2">
                            <div className="input-group">
                                <label className="input-label">REVIEWER *</label>
                                <select
                                    name="approver1"
                                    className="input-field"
                                    value={formData.approver1}
                                    onChange={handleChange}
                                    required
                                >
                                    <option value="">Select Reviewer</option>
                                    {managers.map(m => (
                                        <option key={m.id} value={m.name}>{m.ps_number ? `${m.ps_number} - ` : ''}{m.name}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="input-group">
                                <label className="input-label">APPROVER *</label>
                                <select
                                    name="approver2"
                                    className="input-field"
                                    value={formData.approver2}
                                    onChange={handleChange}
                                    required
                                >
                                    <option value="">Select Approver</option>
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
                            {submitting ? 'Submitting...' : 'Submit Claim Request'}
                        </button>

                        <button
                            type="button"
                            onClick={() => saveDraft(false)}
                            disabled={savingDraft}
                            className="btn btn-outline"
                            title="Save your progress and finish later — nothing is submitted for approval"
                        >
                            {savingDraft ? 'Saving…' : '💾 Save as Draft'}
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
