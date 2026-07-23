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

const PAPER_SIZES = ['A4', 'A3', 'A5', 'Letter', 'Legal'];
const PAPER_GSMS = ['70', '80', '90', '100', '120', '170', '250', '300'];
const PRINT_SIDES = ['Single-sided', 'Double-sided'];
const COLOR_MODES = ['Black & White', 'Colour'];
const BINDING_TYPES = ['None', 'Staple', 'Spiral', 'Wiro', 'Perfect / Glue', 'Hard Case'];

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
    const [entries, setEntries] = useState(() => [{ uid: 1, ...emptyDoc(), file: null }]);
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
        setEntries((prev) => prev.map((e) => (e.uid === uid ? { ...e, [name]: value } : e)));
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
            fd.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : (v ?? ''));
        });
        fd.append('pdf', entry.file);
        const res = await fetch(`/api/jobs/${jobId}/documents`, { method: 'POST', headers: authHeaders(), body: fd });
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || `Failed to add "${entry.document_name || 'document'}"`);
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
                                                        <button className="btn btn-sm btn-outline" style={{ color: '#DC2626', borderColor: '#FCA5A5' }} onClick={() => deleteSavedDocument(d.id)}>Delete</button>
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
                                                {PAPER_SIZES.map((o) => <option key={o} value={o}>{o}</option>)}
                                            </select>
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Paper GSM</label>
                                            <select className="input-field" name="paper_gsm" value={e.paper_gsm} onChange={on}>
                                                {PAPER_GSMS.map((o) => <option key={o} value={o}>{o}</option>)}
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
                                                {BINDING_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
                                            </select>
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Cover Page</label>
                                            <input className="input-field" name="cover_page" value={e.cover_page} onChange={on} placeholder="e.g. Yes / colour cover" />
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">Separator Thickness</label>
                                            <input className="input-field" name="separator_thickness" value={e.separator_thickness} onChange={on} />
                                        </div>
                                        <div className="input-group">
                                            <label className="input-label">File Colour</label>
                                            <input className="input-field" name="file_colour" value={e.file_colour} onChange={on} />
                                        </div>
                                        <div className="input-group" style={{ gridColumn: '1 / -1' }}>
                                            <label className="input-label">Document Remarks</label>
                                            <textarea className="input-field" name="remarks" rows="2" value={e.remarks} onChange={on} style={{ resize: 'vertical' }} />
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                            <input type="checkbox" name="soft_lamination" checked={e.soft_lamination} onChange={on} /> Soft Lamination
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                            <input type="checkbox" name="separators" checked={e.separators} onChange={on} /> Separators
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                            <input type="checkbox" name="hole_punch" checked={e.hole_punch} onChange={on} /> Hole Punch
                                        </label>
                                    </div>
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
