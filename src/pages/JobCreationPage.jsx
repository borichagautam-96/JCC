import React, { useState, useEffect, useRef } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { useNavigate, useLocation } from 'react-router-dom';
import '../voucher-styles.css';

// Request Information option lists (can be moved to master data later).
const DEPARTMENT_CODES = ['3559', '3988'];
const CLASSIFICATIONS = ['Restricted', 'Secret', 'Confidential', 'Not Applicable'];
const VL_REVIEWS = ['Cleared', 'Not Cleared'];
const PURPOSES = ['Customer Submission for Review', 'Final Dispatch', 'Self Study', 'Rework', 'Training Purpose'];
const YES_NO = ['Yes', 'No'];

// Paper, binding and finishing options are published by the rate master
// (GET /api/rates/print-options) rather than hardcoded, so adding a rate to the
// Rate Master is all it takes for a new option to appear here — no code change.
// The lists below are only the fallback used when no rate card is in force; work
// must never be blocked because the master is unconfigured.
const FALLBACK_SIZES = ['A4', 'A3', 'A5', 'A2', 'A1'];
const FALLBACK_GSMS = ['80', '100', '130', '250', '300'];
const FALLBACK_BINDINGS = ['Staple', 'Spiral', 'Wiro', 'Screw', 'Perfect / Glue', 'Hard Case', 'Hard Rexine'];
const FALLBACK_FINISHING = [
    { field: 'soft_lamination', label: 'Soft Lamination' },
    { field: 'separators', label: 'Separators' },
];

// A document saved before the master narrowed still holds its old value. Keep it
// selectable so opening an old job doesn't silently blank the field.
const withLegacy = (options, current) =>
    current && !options.includes(String(current)) ? [...options, String(current)] : options;

// The sheet prices size, weight and colour together — 300 GSM exists for A4/A3 in
// colour only. So the weights on offer depend on the size and colour already chosen,
// and a NULL colour on the card means the rate covers either mode.
const gsmsFor = (combinations, size, colourCode) => {
    const hits = combinations.filter(
        (c) => c.size === size && (!c.colour || !colourCode || c.colour === colourCode)
    );
    return [...new Set(hits.map((c) => String(c.gsm)))].sort((a, b) => Number(a) - Number(b));
};

const PRINT_SIDES = ['Single-sided', 'Double-sided'];
const COLOR_MODES = ['Black & White', 'Colour'];
const colourCodeOf = (mode) => (String(mode).toLowerCase().startsWith('colour') ? 'COLOUR' : 'BW');

const emptyDoc = () => ({
    document_name: '',
    quantity: 1,
    num_pages: '',
    print_side: 'Single-sided',
    paper_size: 'A4',
    paper_gsm: '80',
    color_mode: 'Black & White',
    cover_page: '',
    soft_lamination: false,
    separators: false,
    separator_thickness: '',
    hole_punch: false,
    binding_type: 'None',
    binding_variant: '',
    // [{ code, size, gsm, colour, variant, quantity, label, uom, costGroup }]
    extra_services: [],
    file_colour: '',
    remarks: '',
});

const JobCreationPage = () => {
    const { user, getToken } = useAuth();
    const dialog = useDialog();
    const navigate = useNavigate();
    const location = useLocation();
    const resumeJobId = location.state?.jobId || null;

    const [step, setStep] = useState(1);
    const [jobId, setJobId] = useState(null);
    const [requestId, setRequestId] = useState(null);
    const [saving, setSaving] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    // What the rate master can actually price. Until it loads (or if no card is in
    // force) the fallback lists apply, so the form is never empty.
    const [rateOptions, setRateOptions] = useState(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/rates/print-options', {
                    headers: { Authorization: `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() },
                });
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled && data?.card) setRateOptions(data);
            } catch {
                /* fall back to the static lists */
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const combinations = rateOptions?.combinations || [];
    // Common sizes lead in the familiar order; anything the master adds later that
    // isn't in that list sorts after them rather than jumping to the front.
    const sizeRank = (s) => (FALLBACK_SIZES.indexOf(s) === -1 ? FALLBACK_SIZES.length : FALLBACK_SIZES.indexOf(s));
    const paperSizes = combinations.length
        ? [...new Set(combinations.map((c) => c.size))].sort(
            (a, b) => sizeRank(a) - sizeRank(b) || String(a).localeCompare(String(b)))
        : FALLBACK_SIZES;
    const bindingList = rateOptions?.bindings || FALLBACK_BINDINGS.map((label) => ({ label, variants: [] }));
    const bindingTypes = ['None', ...bindingList.map((b) => b.label)];
    // Only a binding the master prices by variant (box file → spine thickness) asks
    // for one; everything else resolves on paper size alone.
    const variantsForBinding = (label) => bindingList.find((b) => b.label === label)?.variants || [];

    // Extras the card prices but that have no dedicated field. Ticking one adds it to
    // the document at the option and quantity chosen.
    const extraServices = rateOptions?.services || [];
    const extraFor = (entry, code) => (entry.extra_services || []).find((x) => x.code === code) || null;

    const toggleExtra = (uid, service, on) => {
        setEntries((prev) => prev.map((e) => {
            if (e.uid !== uid) return e;
            const rest = (e.extra_services || []).filter((x) => x.code !== service.code);
            if (!on) return { ...e, extra_services: rest };
            const first = service.options[0] || {};
            return {
                ...e,
                extra_services: [...rest, {
                    code: service.code, label: service.label, uom: service.uom,
                    costGroup: service.costGroup,
                    size: first.size || null, gsm: first.gsm || null,
                    colour: first.colour || null, variant: first.variant || null,
                    quantity: Number(e.quantity) || 1,
                }],
            };
        }));
    };

    const patchExtra = (uid, code, patch) => {
        setEntries((prev) => prev.map((e) => e.uid !== uid ? e : {
            ...e,
            extra_services: (e.extra_services || []).map((x) => x.code === code ? { ...x, ...patch } : x),
        }));
    };
    const finishingFields = rateOptions?.finishing || FALLBACK_FINISHING;
    const showsField = (field) => finishingFields.some((f) => f.field === field);
    const gsmOptionsFor = (doc) => {
        if (!combinations.length) return FALLBACK_GSMS;
        const list = gsmsFor(combinations, doc.paper_size, colourCodeOf(doc.color_mode));
        return list.length ? list : FALLBACK_GSMS;
    };

    const [form1, setForm1] = useState({
        employee_name: user?.name || '',
        employee_id: user?.ps_number || '',
        department_name: '',
        department_code: '',
        debit_code: '',
        project_name: '',
        dt_number: '',
        shipset_batch: '',
        classification: '',
        number_of_pages: '',
        lead_name: user?.manager_name || '',
        edc: '',
        recipient_name: '',
        recipient_contact: '',
        recipient_address: '',
        vl_review: '',
        drp_remarks: '',
        pre_printing_checklist: '',
        purpose: '',
        printing_form_available: '',
        remarks: '',
        location_id: user?.location_id ? String(user.location_id) : '',
    });

    const [debitCodes, setDebitCodes] = useState([]);
    const [projectOptions, setProjectOptions] = useState([]);
    const [locations, setLocations] = useState([]);

    const [documents, setDocuments] = useState([]); // already-saved docs (resume case)
    // Client-side repeatable document entries. "+ Add New Entry" just appends a blank
    // one — nothing is uploaded until Save & Exit / Submit.
    const entryUid = useRef(1);
    // A resumed request starts with no open row: if it already has documents, a blank
    // row reads as "add another" and is how a recalled job ended up carrying both the
    // old and the corrected file. The effect below puts a row back when there is
    // genuinely nothing to type into.
    const [entries, setEntries] = useState(() => (location.state?.jobId ? [] : [{ uid: 1, ...emptyDoc(), file: null }]));
    const [openUid, setOpenUid] = useState(1); // which entry is expanded (accordion)

    const authHeaders = (extra = {}) => ({
        Authorization: `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
        ...extra,
    });

    // Read-only "auto-fetched" identity fields (Employee Name, PS No, Request Date).
    const requestDate = new Date().toLocaleDateString();
    const readOnlyStyle = { background: 'var(--surface-3)', cursor: 'not-allowed', color: 'var(--text-body)' };

    // Resume an existing draft/returned job (from Job History "Continue").
    useEffect(() => {
        if (!resumeJobId) return;
        (async () => {
            try {
                const res = await fetch(`/api/jobs/${resumeJobId}`, { headers: authHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                setJobId(data.id);
                setRequestId(data.request_id);
                setForm1({
                    employee_name: data.employee_name || user?.name || '',
                    employee_id: data.employee_id || user?.ps_number || '',
                    department_name: data.department_name || '',
                    department_code: data.department_code || '',
                    debit_code: data.debit_code || '',
                    project_name: data.project_name || '',
                    dt_number: data.dt_number || '',
                    shipset_batch: data.shipset_batch || '',
                    classification: data.classification || '',
                    number_of_pages: data.number_of_pages != null ? String(data.number_of_pages) : '',
                    lead_name: data.lead_name || '',
                    edc: data.edc || '',
                    recipient_name: data.recipient_name || '',
                    recipient_contact: data.recipient_contact || '',
                    recipient_address: data.recipient_address || '',
                    vl_review: data.vl_review || '',
                    drp_remarks: data.drp_remarks || '',
                    pre_printing_checklist: data.pre_printing_checklist || '',
                    purpose: data.purpose || '',
                    printing_form_available: data.printing_form_available || '',
                    remarks: data.remarks || '',
                    location_id: data.location_id ? String(data.location_id) : '',
                });
                setDocuments(data.documents || []);
                setStep(2);
            } catch (e) {
                console.warn('resume job failed', e);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resumeJobId]);

    // Step 2 must never show nothing. With no saved documents *and* no open entry
    // row there is nowhere to type — which happened on a request resumed before any
    // document was added, and again after deleting the last saved one. Suppressing
    // the blank row is only correct while documents already exist.
    useEffect(() => {
        if (step !== 2) return;
        if (documents.length > 0 || entries.length > 0) return;
        entryUid.current += 1;
        const uid = entryUid.current;
        setEntries([{ uid, ...emptyDoc(), file: null }]);
        setOpenUid(uid);
    }, [step, documents.length, entries.length]);

    // Load distinct debit codes for the Phase-1 dropdown.
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/projects/meta/debit-codes', { headers: authHeaders() });
                if (res.ok) setDebitCodes(await res.json());
            } catch (e) {
                console.warn('debit code load failed', e);
            }
        })();
    }, []);

    // Load sites for the location dropdown.
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/locations', { headers: authHeaders() });
                if (res.ok) setLocations(await res.json());
            } catch (e) {
                console.warn('location load failed', e);
            }
        })();
    }, []);

    // When a debit code is chosen/typed, fetch its projects for the project dropdown.
    useEffect(() => {
        const code = form1.debit_code.trim();
        if (!code) {
            setProjectOptions([]);
            return;
        }
        (async () => {
            try {
                const res = await fetch(`/api/projects?debit_code=${encodeURIComponent(code)}&limit=200`, {
                    headers: authHeaders(),
                });
                if (res.ok) {
                    const data = await res.json();
                    setProjectOptions((data.projects || []).map((p) => p.project_name));
                }
            } catch (e) {
                console.warn('project load failed', e);
            }
        })();
    }, [form1.debit_code]);

    const handleForm1 = (e) => {
        const { name, value } = e.target;
        setForm1((prev) => ({ ...prev, [name]: value }));
    };

    // Validate the whole Request Information step (all 3 sections). Returns an error
    // string, or null if valid.
    const validateRequestInfo = () => {
        const required = [
            ['department_code', 'Department Code'],
            ['debit_code', 'Project Debit Code'],
            ['project_name', 'Project Name'],
            ['dt_number', 'DT Number'],
            ['classification', 'Classification of Document'],
            ['number_of_pages', 'Number of Pages'],
            ['lead_name', 'Lead Name'],
            ['location_id', 'Location / Site'],
            ['recipient_name', 'Recipient Name'],
            ['recipient_contact', 'Contact Number'],
            ['recipient_address', 'Address'],
            ['vl_review', 'VL Review'],
            ['pre_printing_checklist', 'Pre-Printing Checklist'],
            ['purpose', 'Purpose for Printing'],
            ['printing_form_available', 'Printing Request Form Available'],
        ];
        for (const [key, label] of required) {
            if (!String(form1[key] ?? '').trim()) return `${label} is required.`;
        }
        // Number of Pages — positive integer.
        if (!/^\d+$/.test(String(form1.number_of_pages)) || parseInt(form1.number_of_pages, 10) <= 0) {
            return 'Number of Pages must be a positive whole number.';
        }
        // Contact Number — valid phone (7–15 digits, optional +/-/spaces).
        if (!/^[+]?[\d\s-]{7,15}$/.test(String(form1.recipient_contact).trim())) {
            return 'Please enter a valid Contact Number.';
        }
        // DRP Remarks mandatory when VL Review is "Not Cleared".
        if (form1.vl_review === 'Not Cleared' && !String(form1.drp_remarks).trim()) {
            return 'DRP Remarks are required when VL Review is "Not Cleared".';
        }
        // Pre-Printing Checklist must be completed (Yes).
        if (form1.pre_printing_checklist === 'No') {
            return 'Complete the Pre-Printing Checklist (set to "Yes") before continuing.';
        }
        // Printing Request Form must be available — admins may override.
        if (form1.printing_form_available !== 'Yes' && user?.role !== 'admin') {
            return 'The Printing Request Form must be marked "Yes" before continuing.';
        }
        return null;
    };

    // Create the draft (first time) or update it (returning to step 1), then go to step 2.
    const goToDocuments = async () => {
        const err = validateRequestInfo();
        if (err) {
            await dialog.alert(err, { title: 'Please check the form', variant: 'warning' });
            return;
        }
        // Warn (but allow) when VL Review is Not Cleared.
        if (form1.vl_review === 'Not Cleared') {
            const ok = await dialog.confirm('VL Review is "Not Cleared". Do you still want to continue?', { title: 'VL Review not cleared' });
            if (!ok) return;
        }
        setSaving(true);
        try {
            const url = jobId ? `/api/jobs/${jobId}` : '/api/jobs';
            const method = jobId ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(form1),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to save request');
            if (!jobId) {
                setJobId(data.id);
                setRequestId(data.request_id);
            }
            await loadDocuments(jobId || data.id);
            setStep(2);
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const loadDocuments = async (id) => {
        try {
            const res = await fetch(`/api/jobs/${id}`, { headers: authHeaders() });
            if (res.ok) {
                const data = await res.json();
                setDocuments(data.documents || []);
            }
        } catch (e) {
            console.warn('load documents failed', e);
        }
    };

    // ── Repeatable document entries (client-side) ──────────────────────────────
    const addEntry = () => {
        const uid = ++entryUid.current;
        setEntries((prev) => [...prev, { uid, ...emptyDoc(), file: null }]);
        setOpenUid(uid); // open the new one, collapse the rest
    };
    const removeEntry = (uid) => {
        setEntries((prev) => {
            if (prev.length <= 1) return prev;
            const next = prev.filter((e) => e.uid !== uid);
            if (openUid === uid) setOpenUid(next[next.length - 1].uid);
            return next;
        });
    };
    const updateEntry = (uid, name, value) => {
        setEntries((prev) => prev.map((e) => {
            if (e.uid !== uid) return e;
            const next = { ...e, [name]: value };
            // Changing the size or colour can strand the chosen weight — the master
            // prices 300 GSM for A4/A3 in colour only. Move to the nearest weight
            // that is still priced rather than leaving an uncostable combination.
            // A thickness picked for one binding is meaningless on another.
            if (name === 'binding_type') next.binding_variant = '';
            if ((name === 'paper_size' || name === 'color_mode') && combinations.length) {
                const allowed = gsmsFor(combinations, next.paper_size, colourCodeOf(next.color_mode));
                if (allowed.length && !allowed.includes(String(next.paper_gsm))) {
                    const wanted = Number(next.paper_gsm);
                    next.paper_gsm = allowed.reduce((best, g) =>
                        Math.abs(Number(g) - wanted) < Math.abs(Number(best) - wanted) ? g : best, allowed[0]);
                }
            }
            return next;
        }));
    };
    const handleEntryField = (uid) => (ev) => {
        const { name, value, type, checked } = ev.target;
        updateEntry(uid, name, type === 'checkbox' ? checked : value);
    };

    // Upload one entry as a document on the current job (same request number).
    const uploadEntry = async (entry) => {
        const fd = new FormData();
        Object.entries(entry).forEach(([k, v]) => {
            if (k === 'uid' || k === 'file') return;
            if (typeof v === 'boolean') return fd.append(k, v ? '1' : '0');
            // Extras are a list — send as JSON, not the default comma-joined coercion.
            if (v && typeof v === 'object') return fd.append(k, JSON.stringify(v));
            fd.append(k, v ?? '');
        });
        fd.append('pdf', entry.file);
        const res = await fetch(`/api/jobs/${jobId}/documents`, { method: 'POST', headers: authHeaders(), body: fd });
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || `Failed to add "${entry.document_name || 'document'}"`);
        }
    };

    // Swap the PDF on an already-saved document, keeping its name and specs. This is
    // the correction path: replace the file rather than adding a second document.
    const replaceSavedPdf = async (doc, file) => {
        if (!file) return;
        const fd = new FormData();
        fd.append('pdf', file);
        try {
            const res = await fetch(`/api/jobs/${jobId}/documents/${doc.id}/file`, {
                method: 'PUT', headers: authHeaders(), body: fd,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not replace the PDF');
            await loadDocuments(jobId);
            await dialog.alert(data.message, { title: 'PDF replaced', variant: 'success' });
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    // Validate an entry that has content; returns error string or null.
    const validateEntry = (e) => {
        if (!String(e.document_name).trim()) return 'Every document needs a name.';
        if (!e.file) return `Please upload the PDF for "${e.document_name}".`;
        if (!(Number(e.quantity) > 0)) return `Quantity must be greater than zero for "${e.document_name}".`;
        return null;
    };
    const isBlankEntry = (e) => !String(e.document_name).trim() && !e.file;

    const deleteSavedDocument = async (docId) => {
        const ok = await dialog.confirm('Remove this saved document?', { title: 'Remove document' });
        if (!ok) return;
        try {
            const res = await fetch(`/api/jobs/${jobId}/documents/${docId}`, { method: 'DELETE', headers: authHeaders() });
            if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Failed to delete'); }
            await loadDocuments(jobId);
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    // Save & Exit — upload every complete entry (skip blank ones), then leave.
    const saveAndExit = async () => {
        const complete = entries.filter((e) => !isBlankEntry(e) && !validateEntry(e));
        setSubmitting(true);
        try {
            for (const e of complete) await uploadEntry(e);
            navigate('/job-history');
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        } finally {
            setSubmitting(false);
        }
    };

    const submitRequest = async () => {
        // Validate all non-blank entries fully.
        const filled = entries.filter((e) => !isBlankEntry(e));
        for (const e of filled) {
            const err = validateEntry(e);
            if (err) { await dialog.alert(err, { title: 'Please check the documents', variant: 'warning' }); return; }
        }
        const totalDocs = documents.length + filled.length;
        if (totalDocs === 0) {
            await dialog.alert('Add at least one document before submitting.', { title: 'No documents', variant: 'warning' });
            return;
        }
        const ok = await dialog.confirm(
            `Submit this printing request with ${totalDocs} document(s)? It will go to the Printing Coordinator for verification.`,
            { title: 'Submit request' }
        );
        if (!ok) return;
        setSubmitting(true);
        try {
            for (const e of filled) await uploadEntry(e);
            const res = await fetch(`/api/jobs/${jobId}/submit`, { method: 'POST', headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to submit');
            await dialog.alert(`Request submitted as ${data.job_number}. It is now pending coordinator verification.`, {
                title: 'Submitted',
                variant: 'success',
            });
            navigate('/job-history');
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header">
                    <div>
                        <h1 className="page-title">Create Printing Job</h1>
                        <p className="page-subtitle">
                            {requestId ? `Request ${requestId}` : 'Raise a new printing request'}
                            {' · '}Step {step} of 2
                        </p>
                    </div>
                </div>

                {/* Stepper */}
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
                    {['Request Information', 'Documents'].map((label, i) => (
                        <div
                            key={label}
                            style={{
                                flex: 1,
                                padding: '0.6rem 0.9rem',
                                borderRadius: '10px',
                                fontWeight: 600,
                                fontSize: '0.9rem',
                                textAlign: 'center',
                                background: step === i + 1 ? '#1E3A5F' : '#EEF2F7',
                                color: step === i + 1 ? '#fff' : '#64748B',
                            }}
                        >
                            {i + 1}. {label}
                        </div>
                    ))}
                </div>

                {step === 1 && (
                    <>
                        {/* ── Section 1: Initiator Details ── */}
                        <div className="glass-card" style={{ marginBottom: '1.25rem' }}>
                            <h3 style={{ marginTop: 0, color: 'var(--text-strong)' }}>1. Initiator Details</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
                                <div className="input-group">
                                    <label className="input-label">Request Date</label>
                                    <input className="input-field" value={requestDate} readOnly disabled style={readOnlyStyle} />
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Initiator Name</label>
                                    <input className="input-field" value={form1.employee_name} readOnly disabled style={readOnlyStyle} title="Auto-filled from your profile" />
                                </div>
                                <div className="input-group">
                                    <label className="input-label">PS No.</label>
                                    <input className="input-field" value={form1.employee_id} readOnly disabled style={readOnlyStyle} title="Auto-filled from your profile" />
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Department Code <span style={{ color: '#DC2626' }}>*</span></label>
                                    <select className="input-field" name="department_code" value={form1.department_code} onChange={handleForm1}>
                                        <option value="">Select…</option>
                                        {DEPARTMENT_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Project Debit Code <span style={{ color: '#DC2626' }}>*</span></label>
                                    <input className="input-field" name="debit_code" list="debit-code-options" value={form1.debit_code} onChange={handleForm1} placeholder="Select or type a debit code" />
                                    <datalist id="debit-code-options">
                                        {debitCodes.map((c) => <option key={c} value={c} />)}
                                    </datalist>
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Project Name <span style={{ color: '#DC2626' }}>*</span></label>
                                    <input className="input-field" name="project_name" list="project-options" value={form1.project_name} onChange={handleForm1} placeholder={form1.debit_code ? 'Select or type a project' : 'Choose a debit code first'} />
                                    <datalist id="project-options">
                                        {projectOptions.map((p) => <option key={p} value={p} />)}
                                    </datalist>
                                </div>
                                <div className="input-group">
                                    <label className="input-label">DT Number <span style={{ color: '#DC2626' }}>*</span></label>
                                    <input className="input-field" name="dt_number" value={form1.dt_number} onChange={handleForm1} />
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Shipset / Batch Number</label>
                                    <input className="input-field" name="shipset_batch" value={form1.shipset_batch} onChange={handleForm1} />
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Classification of Document <span style={{ color: '#DC2626' }}>*</span></label>
                                    <select className="input-field" name="classification" value={form1.classification} onChange={handleForm1}>
                                        <option value="">Select…</option>
                                        {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Number of Pages <span style={{ color: '#DC2626' }}>*</span></label>
                                    <input className="input-field" type="number" min="1" name="number_of_pages" value={form1.number_of_pages} onChange={handleForm1} />
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Lead Name (Team Lead) <span style={{ color: '#DC2626' }}>*</span></label>
                                    <input className="input-field" name="lead_name" value={form1.lead_name} onChange={handleForm1} placeholder="Team lead name" />
                                </div>
                                <div className="input-group">
                                    <label className="input-label">EDC</label>
                                    <input className="input-field" name="edc" value={form1.edc} onChange={handleForm1} />
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Location / Site <span style={{ color: '#DC2626' }}>*</span></label>
                                    <select className="input-field" name="location_id" value={form1.location_id} onChange={handleForm1}>
                                        <option value="">Select site…</option>
                                        {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                                    </select>
                                </div>
                                <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                                    <label className="input-label">Remarks</label>
                                    <textarea className="input-field" name="remarks" rows="2" value={form1.remarks} onChange={handleForm1} style={{ resize: 'vertical' }} />
                                </div>
                            </div>
                        </div>

                        {/* ── Section 2: Recipient Details ── */}
                        <div className="glass-card" style={{ marginBottom: '1.25rem' }}>
                            <h3 style={{ marginTop: 0, color: 'var(--text-strong)' }}>2. Recipient Details</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
                                <div className="input-group">
                                    <label className="input-label">Recipient Name <span style={{ color: '#DC2626' }}>*</span></label>
                                    <input className="input-field" name="recipient_name" value={form1.recipient_name} onChange={handleForm1} />
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Contact Number <span style={{ color: '#DC2626' }}>*</span></label>
                                    <input className="input-field" name="recipient_contact" value={form1.recipient_contact} onChange={handleForm1} placeholder="e.g. +91 9876543210" />
                                </div>
                                <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                                    <label className="input-label">Address <span style={{ color: '#DC2626' }}>*</span></label>
                                    <textarea className="input-field" name="recipient_address" rows="3" value={form1.recipient_address} onChange={handleForm1} style={{ resize: 'vertical' }} placeholder="Delivery address" />
                                </div>
                            </div>
                        </div>

                        {/* ── Section 3: Printing Requirement Details ── */}
                        <div className="glass-card" style={{ marginBottom: '1.25rem' }}>
                            <h3 style={{ marginTop: 0, color: 'var(--text-strong)' }}>3. Printing Requirement Details</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
                                <div className="input-group">
                                    <label className="input-label">VL Review <span style={{ color: '#DC2626' }}>*</span></label>
                                    <select className="input-field" name="vl_review" value={form1.vl_review} onChange={handleForm1}>
                                        <option value="">Select…</option>
                                        {VL_REVIEWS.map((v) => <option key={v} value={v}>{v}</option>)}
                                    </select>
                                    {form1.vl_review === 'Not Cleared' && (
                                        <small style={{ color: '#B45309' }}>⚠ VL Review not cleared — DRP Remarks required.</small>
                                    )}
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Purpose for Printing <span style={{ color: '#DC2626' }}>*</span></label>
                                    <select className="input-field" name="purpose" value={form1.purpose} onChange={handleForm1}>
                                        <option value="">Select…</option>
                                        {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
                                    </select>
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Pre-Printing Checklist <span style={{ color: '#DC2626' }}>*</span></label>
                                    <select className="input-field" name="pre_printing_checklist" value={form1.pre_printing_checklist} onChange={handleForm1}>
                                        <option value="">Select…</option>
                                        {YES_NO.map((v) => <option key={v} value={v}>{v}</option>)}
                                    </select>
                                </div>
                                <div className="input-group">
                                    <label className="input-label">Printing Request Form Available <span style={{ color: '#DC2626' }}>*</span></label>
                                    <select className="input-field" name="printing_form_available" value={form1.printing_form_available} onChange={handleForm1}>
                                        <option value="">Select…</option>
                                        {YES_NO.map((v) => <option key={v} value={v}>{v}</option>)}
                                    </select>
                                </div>
                                <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                                    <label className="input-label">
                                        DRP Remarks {form1.vl_review === 'Not Cleared' && <span style={{ color: '#DC2626' }}>*</span>}
                                    </label>
                                    <textarea className="input-field" name="drp_remarks" rows="2" value={form1.drp_remarks} onChange={handleForm1} style={{ resize: 'vertical' }} />
                                </div>
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem' }}>
                            <button className="btn btn-outline" onClick={() => navigate('/job-history')}>Cancel</button>
                            <button className="btn btn-primary" onClick={goToDocuments} disabled={saving}>
                                {saving ? 'Saving…' : 'Next: Add Documents →'}
                            </button>
                        </div>
                    </>
                )}

                {step === 2 && (
                    <>
                        {/* Header + note */}
                        <div className="flex justify-between items-center" style={{ marginBottom: '0.35rem' }}>
                            <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>Documents</h3>
                            <button className="btn btn-sm btn-outline" onClick={() => setStep(1)}>← Edit Request Info</button>
                        </div>
                        <p className="text-muted" style={{ margin: '0 0 1rem', fontSize: '0.82rem' }}>
                            {requestId ? <>All documents belong to the same request <strong>{requestId}</strong> — adding more never creates a new request number.</> : 'Add as many documents as you need — they all stay under this one request.'}
                        </p>

                        {/* Already-saved documents (resumed drafts) */}
                        {documents.length > 0 && (
                            <div className="glass-card" style={{ marginBottom: '1.25rem' }}>
                                <h4 style={{ marginTop: 0, color: 'var(--text-strong)' }}>Saved documents ({documents.length})</h4>
                                <p className="text-muted" style={{ fontSize: '0.82rem', margin: '0 0 0.75rem' }}>
                                    Correcting a file? Use <strong>Replace PDF</strong> on the document itself — adding a
                                    new one below leaves the old file on the request as well.
                                </p>
                                <div className="table-container">
                                    <table className="table">
                                        <thead>
                                            <tr><th>Document</th><th>Qty</th><th>Size / GSM</th><th>Colour</th><th>Binding</th><th style={{ textAlign: 'center' }}>Action</th></tr>
                                        </thead>
                                        <tbody>
                                            {documents.map((d) => (
                                                <tr key={d.id}>
                                                    <td style={{ fontWeight: 600 }}>{d.document_name}</td>
                                                    <td>{d.quantity}</td>
                                                    <td>{[d.paper_size, d.paper_gsm].filter(Boolean).join(' / ') || '-'}</td>
                                                    <td>{d.color_mode || '-'}</td>
                                                    <td>{d.binding_type || '-'}</td>
                                                    <td style={{ textAlign: 'center' }}>
                                                        <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                            <label className="btn btn-sm btn-primary" style={{ marginBottom: 0, cursor: 'pointer' }}
                                                                   title="Attach a corrected file to this document, keeping its name and settings">
                                                                Replace PDF
                                                                <input type="file" accept="application/pdf" style={{ display: 'none' }}
                                                                       onChange={(ev) => { replaceSavedPdf(d, ev.target.files?.[0]); ev.target.value = ''; }} />
                                                            </label>
                                                            <button className="btn btn-sm btn-outline" style={{ color: '#DC2626', borderColor: '#FCA5A5' }} onClick={() => deleteSavedDocument(d.id)}>Delete</button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Repeatable document entry cards */}
                        {entries.map((e, idx) => {
                            const on = handleEntryField(e.uid);
                            const open = openUid === e.uid;
                            const summary = [e.document_name || 'Untitled', `Qty ${e.quantity || 1}`, `${e.paper_size}/${e.paper_gsm} · ${e.color_mode}`, e.file ? 'PDF ✓' : 'No PDF'].join('  ·  ');
                            return (
                                <div className="glass-card" style={{ marginBottom: '0.85rem', padding: open ? undefined : '0.85rem 1.1rem' }} key={e.uid}>
                                    {/* Collapsible header */}
                                    <div
                                        onClick={() => setOpenUid(open ? null : e.uid)}
                                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', gap: '0.75rem' }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', minWidth: 0 }}>
                                            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{open ? '▾' : '▸'}</span>
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>Document {idx + 1}{!e.file && !open ? <span style={{ color: '#DC2626', fontWeight: 400 }}> — incomplete</span> : ''}</div>
                                                {!open && (
                                                    <div className="text-muted" style={{ fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</div>
                                                )}
                                            </div>
                                        </div>
                                        {entries.length > 1 && (
                                            <button className="btn btn-sm btn-outline" style={{ color: '#DC2626', borderColor: '#FCA5A5' }} onClick={(ev) => { ev.stopPropagation(); removeEntry(e.uid); }}>Remove</button>
                                        )}
                                    </div>
                                    {open && (<>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '0.9rem' }}>
                                        <div className="input-group">
                                            <label className="input-label">Document Name <span style={{ color: '#DC2626' }}>*</span></label>
                                            <input className="input-field" name="document_name" value={e.document_name} onChange={on} />
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Quantity <span style={{ color: '#DC2626' }}>*</span></label>
                                            <input className="input-field" type="number" min="1" name="quantity" value={e.quantity} onChange={on} />
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Upload PDF <span style={{ color: '#DC2626' }}>*</span></label>
                                            <input id={`job-doc-file-${e.uid}`} className="input-field" type="file" accept="application/pdf" onChange={(ev) => updateEntry(e.uid, 'file', ev.target.files?.[0] || null)} />
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Number of Pages</label>
                                            <input className="input-field" type="number" min="1" name="num_pages" value={e.num_pages} onChange={on} />
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Print Side</label>
                                            <select className="input-field" name="print_side" value={e.print_side} onChange={on}>
                                                {PRINT_SIDES.map((o) => <option key={o} value={o}>{o}</option>)}
                                            </select>
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Paper Size</label>
                                            <select className="input-field" name="paper_size" value={e.paper_size} onChange={on}>
                                                {withLegacy(paperSizes, e.paper_size).map((o) => <option key={o} value={o}>{o}</option>)}
                                            </select>
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Paper GSM</label>
                                            <select className="input-field" name="paper_gsm" value={e.paper_gsm} onChange={on}>
                                                {withLegacy(gsmOptionsFor(e), e.paper_gsm).map((o) => <option key={o} value={o}>{o}</option>)}
                                            </select>
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Colour / B&amp;W</label>
                                            <select className="input-field" name="color_mode" value={e.color_mode} onChange={on}>
                                                {COLOR_MODES.map((o) => <option key={o} value={o}>{o}</option>)}
                                            </select>
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Binding Type</label>
                                            <select className="input-field" name="binding_type" value={e.binding_type} onChange={on}>
                                                {withLegacy(bindingTypes, e.binding_type).map((o) => <option key={o} value={o}>{o}</option>)}
                                            </select>
                                        </div>
                                        {variantsForBinding(e.binding_type).length > 0 && (
                                            <div className="input-group">
                                                <label className="input-label">{e.binding_type} Size *</label>
                                                <select className="input-field" name="binding_variant" value={e.binding_variant || ''} onChange={on}>
                                                    <option value="">Select…</option>
                                                    {variantsForBinding(e.binding_type).map((o) => <option key={o} value={o}>{o}</option>)}
                                                </select>
                                            </div>
                                        )}
                                        {showsField('cover_page') && (
                                            <div className="input-group">
                                                <label className="input-label">Cover Page</label>
                                                <input className="input-field" name="cover_page" value={e.cover_page} onChange={on} placeholder="e.g. Yes / colour cover" />
                                            </div>
                                        )}
                                        {showsField('separators') && (
                                            <div className="input-group">
                                                <label className="input-label">Separator Thickness</label>
                                                <input className="input-field" name="separator_thickness" value={e.separator_thickness} onChange={on} />
                                            </div>
                                        )}
                                        <div className="input-group">
                                            <label className="input-label">File Colour</label>
                                            <input className="input-field" name="file_colour" value={e.file_colour} onChange={on} />
                                        </div>
                                        <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                                            <label className="input-label">Document Remarks</label>
                                            <textarea className="input-field" name="remarks" rows="2" value={e.remarks} onChange={on} style={{ resize: 'vertical' }} />
                                        </div>
                                    </div>
                                    {/* Only finishing the rate master can price is offered. Add a rate
                                        for a service and its option appears here automatically. */}
                                    <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                                        {finishingFields.filter((f) => f.field !== 'cover_page').map((f) => (
                                            <label key={f.field} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                <input type="checkbox" name={f.field} checked={!!e[f.field]} onChange={on} /> {f.label}
                                            </label>
                                        ))}
                                    </div>

                                    {/* Everything else the rate master prices. Driven entirely by the card,
                                        so a new service becomes requestable the moment it has a rate. */}
                                    {extraServices.length > 0 && (
                                        <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-subtle, #E2E8F0)', paddingTop: '0.85rem' }}>
                                            <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-strong)', marginBottom: '0.15rem' }}>
                                                Additional Services
                                            </div>
                                            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted, #64748B)', marginBottom: '0.6rem' }}>
                                                Optional — tick only what this document needs.
                                            </div>
                                            {/* align-items:start keeps a ticked row from stretching its
                                                neighbours; the controls stack under their own label. */}
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0.35rem 1.5rem', alignItems: 'start' }}>
                                                {extraServices.map((svc) => {
                                                    const picked = extraFor(e, svc.code);
                                                    return (
                                                        <div key={svc.code} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={!!picked}
                                                                    onChange={(ev) => toggleExtra(e.uid, svc, ev.target.checked)}
                                                                />
                                                                {svc.label}
                                                            </label>
                                                            {picked && (
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', paddingLeft: '1.5rem', paddingBottom: '0.35rem' }}>
                                                                    {svc.options.length > 1 && (
                                                                        <select
                                                                            className="input-field"
                                                                            style={{ width: 'auto', minWidth: '9rem', padding: '0.3rem 0.5rem', fontSize: '0.82rem' }}
                                                                            value={JSON.stringify([picked.size, picked.gsm, picked.colour, picked.variant])}
                                                                            onChange={(ev) => {
                                                                                const [size, gsm, colour, variant] = JSON.parse(ev.target.value);
                                                                                patchExtra(e.uid, svc.code, { size, gsm, colour, variant });
                                                                            }}
                                                                        >
                                                                            {svc.options.map((o) => (
                                                                                <option key={o.label} value={JSON.stringify([o.size, o.gsm, o.colour, o.variant])}>
                                                                                    {o.label}
                                                                                </option>
                                                                            ))}
                                                                        </select>
                                                                    )}
                                                                    <input
                                                                        className="input-field"
                                                                        type="number"
                                                                        min="1"
                                                                        style={{ width: '5.5rem', padding: '0.3rem 0.5rem', fontSize: '0.82rem' }}
                                                                        value={picked.quantity}
                                                                        onChange={(ev) => patchExtra(e.uid, svc.code, { quantity: ev.target.value })}
                                                                    />
                                                                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted, #64748B)' }}>{svc.uom}</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                    </>)}
                                </div>
                            );
                        })}

                        {/* Full-width add-entry button */}
                        <button
                            onClick={addEntry}
                            style={{
                                width: '100%',
                                padding: '0.95rem',
                                marginBottom: '1.25rem',
                                border: '1.5px dashed #93C5FD',
                                background: '#EFF6FF',
                                color: '#2563EB',
                                borderRadius: '12px',
                                fontWeight: 600,
                                fontSize: '0.95rem',
                                cursor: 'pointer',
                            }}
                        >
                            + Add New Entry
                        </button>

                        {/* Submit */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <button className="btn btn-outline" onClick={saveAndExit} disabled={submitting}>Save &amp; Exit</button>
                            <button className="btn btn-primary" onClick={submitRequest} disabled={submitting}>
                                {submitting ? 'Submitting…' : 'Submit Request'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default JobCreationPage;
