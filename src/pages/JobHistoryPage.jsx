import React, { useState, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { useDialog } from '../components/DialogProvider';
import { formatDateTime } from '../utils/datetime';
import SubmissionDiff from '../components/SubmissionDiff';

// Status → badge. Covers the full Phase 3–10 lifecycle; Slice A only produces
// draft / submitted, but the map is complete so later slices need no change here.
const STATUS_BADGE = {
    draft: { cls: 'bg-slate-100 text-slate-700', label: 'Draft' },
    submitted: { cls: 'bg-blue-100 text-blue-800', label: 'Pending Verification' },
    returned: { cls: 'bg-orange-100 text-orange-800', label: '↩ Returned' },
    recalled: { cls: 'bg-slate-100 text-slate-700', label: '↩ Recalled — edit & resubmit' },
    rejected: { cls: 'bg-red-100 text-red-800', label: 'Rejected' },
    accepted: { cls: 'bg-teal-100 text-teal-800', label: 'Accepted (Queued)' },
    assigned: { cls: 'bg-indigo-100 text-indigo-800', label: 'Assigned' },
    printing: { cls: 'bg-purple-100 text-purple-800', label: 'Printing' },
    paused: { cls: 'bg-amber-100 text-amber-800', label: 'Paused' },
    printing_completed: { cls: 'bg-teal-100 text-teal-800', label: 'Printed' },
    ready_for_collection: { cls: 'bg-green-100 text-green-800', label: 'Ready for Collection' },
    awaiting_receipt: { cls: 'bg-amber-100 text-amber-800', label: 'Confirm Receipt' },
    proof_review: { cls: 'bg-blue-100 text-blue-800', label: 'Your Review' },
    rework_requested: { cls: 'bg-orange-100 text-orange-800', label: 'Rework Pending' },
    rework_printing: { cls: 'bg-purple-100 text-purple-800', label: 'Rework Printing' },
    dispatched: { cls: 'bg-purple-100 text-purple-800', label: 'In Transit' },
    completed: { cls: 'bg-green-100 text-green-800', label: 'Completed' },
    cancelled: { cls: 'bg-slate-100 text-slate-500', label: 'Cancelled' },
};

const formatDate = (v) => formatDateTime(v);

// Audit action code → friendly label + dot colour for the activity timeline.
const ACTION_META = {
    CREATE_PRINT_REQUEST: { label: 'Request created', color: 'var(--text-muted)' },
    SUBMIT_PRINT_JOB: { label: 'Submitted for verification', color: '#2563EB' },
    ACCEPT_PRINT_JOB: { label: 'Accepted & queued', color: '#0D9488' },
    RETURN_PRINT_JOB: { label: 'Returned for correction', color: '#EA580C' },
    REJECT_PRINT_JOB: { label: 'Rejected', color: '#DC2626' },
    ASSIGN_PRINT_JOB: { label: 'Assigned to operator', color: '#4F46E5' },
    START_PRINTING: { label: 'Printing started', color: '#7C3AED' },
    PAUSE_PRINTING: { label: 'Printing paused', color: '#D97706' },
    RESUME_PRINTING: { label: 'Printing resumed', color: '#7C3AED' },
    COMPLETE_PRINTING: { label: 'Printing completed', color: '#0891B2' },
    READY_FOR_COLLECTION: { label: 'Ready for collection', color: '#16A34A' },
    DISPATCH_PRINT_JOB: { label: 'Dispatched (courier)', color: '#7C3AED' },
    DELIVER_PRINT_JOB: { label: 'Delivered', color: '#15803D' },
    HANDOVER_PRINT_JOB: { label: 'Handed over — awaiting confirmation', color: '#D97706' },
    CONFIRM_PRINT_RECEIPT: { label: 'Receipt confirmed by requestor', color: '#15803D' },
    COMPLETE_PRINT_JOB: { label: 'Collected & closed', color: '#15803D' },
    CLONE_PRINT_REQUEST: { label: 'Cloned from another request', color: 'var(--text-muted)' },
    RECALL_PRINT_JOB: { label: 'Recalled for correction', color: '#D97706' },
    RELEASE_PROOF: { label: 'Proof copy released', color: '#2563EB' },
    PROOF_APPROVED: { label: 'Proof approved', color: '#15803D' },
    REWORK_REQUESTED: { label: 'Corrections reported', color: '#EA580C' },
    REQUEST_REWORK: { label: 'Rework requested by requestor', color: '#D97706' },
    CREATE_REWORK: { label: 'Rework created', color: '#D97706' },
    ASSIGN_REWORK: { label: 'Rework assigned to operator', color: '#4F46E5' },
    START_REWORK: { label: 'Rework printing started', color: '#7C3AED' },
    COMPLETE_REWORK: { label: 'Rework completed', color: '#15803D' },
    CANCEL_REWORK: { label: 'Rework cancelled', color: '#DC2626' },
    REPLACE_DOCUMENT_PDF: { label: 'Document PDF replaced', color: '#D97706' },
};
const actionMeta = (action) => ACTION_META[action] || { label: action, color: 'var(--text-muted)' };

const JobHistoryPage = () => {
    const { getToken } = useAuth();
    const navigate = useNavigate();
    const dialog = useDialog();
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(null);
    const [details, setDetails] = useState({});
    const [logs, setLogs] = useState({}); // jobId -> { events, totals }
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [reworkJob, setReworkJob] = useState(null);
    const [reworkForm, setReworkForm] = useState(null);
    const [reworkBusy, setReworkBusy] = useState(false);
    const [pagePreview, setPagePreview] = useState(null);
    const [versions, setVersions] = useState({});
    const [changeLog, setChangeLog] = useState({});   // jobId -> submissions[]

    // Statuses where something has actually been printed, so a rework makes sense.
    // Before that the job is still editable in the normal way.
    const REWORKABLE = ['printing_completed', 'proof_review', 'rework_requested', 'ready_for_collection'];
    const EMPTY_REWORK = {
        file: null, modified_pages: '', additional_pages: '0',
        insert_mode: 'end', insert_page: '', change_description: '',
    };

    const openReworkForm = (job) => {
        setReworkForm({ ...EMPTY_REWORK });
        setPagePreview(null);
        setReworkJob(job);
    };

    // Echoes what the operator will read, before it is submitted. The server
    // re-parses and is authoritative — this is only a courtesy.
    const previewPages = (value) => {
        const raw = String(value || '').trim();
        if (!raw) { setPagePreview(null); return; }
        const normalised = raw.replace(/(\d)\s*(?:-{1,2}|\u2013|\u2014|to)\s*(\d)/gi, '$1-$2');
        const pages = new Set();
        for (const token of normalised.split(/[,;\s]+/).filter(Boolean)) {
            const parts = token.split('-');
            if (parts.length > 2 || parts.some((x) => !/^\d+$/.test(x))) {
                setPagePreview({ error: `"${token}" is not a page or a range.` }); return;
            }
            const nums = parts.map(Number);
            if (nums.some((n) => n < 1)) { setPagePreview({ error: 'Page numbers start at 1.' }); return; }
            if (parts.length === 2 && nums[0] > nums[1]) {
                setPagePreview({ error: `Range ${nums[0]}-${nums[1]} runs backwards.` }); return;
            }
            if (parts.length === 1) pages.add(nums[0]);
            else for (let n = nums[0]; n <= nums[1]; n += 1) pages.add(n);
        }
        const sorted = [...pages].sort((a, b) => a - b);
        setPagePreview({ count: sorted.length, list: sorted.join(', ') });
    };

    const submitRework = async () => {
        const f = reworkForm;
        const job = reworkJob;
        if (!f.file) { await dialog.alert('Attach the complete revised PDF.', { title: 'PDF required', variant: 'warning' }); return; }
        if (!f.modified_pages.trim()) { await dialog.alert('Enter the page numbers you changed.', { title: 'Changed pages required', variant: 'warning' }); return; }
        if (f.change_description.trim().length < 10) { await dialog.alert('Describe what changed in at least a few words — the operator reads this.', { title: 'Description required', variant: 'warning' }); return; }

        const additional = Number(f.additional_pages || 0);
        let insertPosition = '';
        if (additional > 0) {
            if (f.insert_mode === 'end') insertPosition = 'End of document';
            else if (!f.insert_page) { await dialog.alert(`Say where the ${additional} new page(s) go.`, { title: 'Insert position required', variant: 'warning' }); return; }
            else insertPosition = `${f.insert_mode === 'after' ? 'After' : 'Before'} page ${f.insert_page}`;
        }

        const body = new FormData();
        body.append('pdf', f.file);
        body.append('modified_pages', f.modified_pages.trim());
        body.append('additional_pages', String(additional));
        if (insertPosition) body.append('insert_position', insertPosition);
        body.append('change_description', f.change_description.trim());

        setReworkBusy(true);
        try {
            const res = await fetch(`/api/jobs/${job.id}/reworks/request`, {
                method: 'POST', headers: authHeaders(), body,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not send the rework');
            setReworkJob(null);
            await dialog.alert(data.message, { title: 'Rework sent', variant: 'success' });
            fetchJobs();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        } finally {
            setReworkBusy(false);
        }
    };

    const recallJob = async (job) => {
        const label = job.job_number || job.request_id;
        const reason = await dialog.prompt(
            `Pull ${label} back to fix it? It keeps the same number and returns for verification once you resubmit.`,
            { title: 'Recall & edit', placeholder: 'What needs changing? (optional)', multiline: true }
        );
        if (reason == null) return;
        try {
            const res = await fetch(`/api/jobs/${job.id}/recall`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: (reason || '').trim() }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not recall this request');
            await dialog.alert(data.message, { title: 'Recalled', variant: 'success' });
            fetchJobs();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    const loadVersions = async (jobId) => {
        try {
            const res = await fetch(`/api/jobs/${jobId}/versions`, { headers: authHeaders() });
            if (!res.ok) return;
            const rows = await res.json();
            setVersions((prev) => ({ ...prev, [jobId]: rows }));
        } catch (e) { console.warn('version load failed', e); }
    };

    const openVersionPdf = async (jobId, v) => {
        const url = v.rework_row_id
            ? `/api/jobs/${jobId}/reworks/${v.rework_row_id}/file`
            : `/api/jobs/${jobId}/documents/${v.document_id}/file`;
        try {
            const res = await fetch(url, { headers: authHeaders() });
            if (!res.ok) return;
            const blob = await res.blob();
            const objectUrl = window.URL.createObjectURL(blob);
            window.open(objectUrl, '_blank', 'noopener');
            setTimeout(() => window.URL.revokeObjectURL(objectUrl), 60000);
        } catch (e) { console.warn('open version failed', e); }
    };

    // Opens the new-request form pre-filled. Nothing is created until the user saves
    // step 1 — clicking Clone by accident now costs nothing, where it used to leave a
    // permanent draft that could not be removed.
    const cloneJob = (job) => {
        navigate('/job-creation', { state: { cloneFromJobId: job.id } });
    };

    // Only ever offered on a draft. Anything submitted belongs to the workflow and the
    // server refuses to delete it, so the button is not shown for those.
    const deleteDraft = async (job) => {
        const ok = await dialog.confirm(
            `Discard ${job.request_id}? This cannot be undone.`
            + (job.document_count ? ` Its ${job.document_count} uploaded document(s) will be removed too.` : ''),
            { title: 'Discard draft', confirmLabel: 'Yes, discard', variant: 'danger' }
        );
        if (!ok) return;
        try {
            const res = await fetch(`/api/jobs/${job.id}`, { method: 'DELETE', headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not discard the request');
            fetchJobs();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    const authHeaders = () => ({
        Authorization: `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
    });

    // Only the requestor can do this — it is the record that the materials
    // actually reached them, so it must be their action, not the coordinator's.
    const confirmReceipt = async (job) => {
        const label = job.job_number || job.request_id;
        const ok = await dialog.confirm(
            `Confirm you have received the printed materials for ${label}? This closes the job.`,
            { title: 'Confirm receipt', confirmLabel: 'Yes, I received it' }
        );
        if (!ok) return;
        try {
            const res = await fetch(`/api/jobs/${job.id}/confirm-receipt`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: '{}',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not confirm receipt');
            await dialog.alert(data.message, { title: 'Thank you', variant: 'success' });
            fetchJobs();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    const fetchJobs = async () => {
        try {
            const res = await fetch('/api/jobs/mine', { headers: authHeaders() });
            if (res.ok) setJobs(await res.json());
            else setJobs([]);
        } catch (e) {
            console.error('fetch jobs failed', e);
            setJobs([]);
        } finally {
            setLoading(false);
        }
    };

    // The printer coordinator/operator prepare and correct the cost annexure to what
    // was actually printed; the requestor's role is to check the amount and pages and
    // sign off on it — that approval is what this modal is for.
    const [costReview, setCostReview] = useState(null);
    const openCostReview = async (job) => {
        try {
            const res = await fetch(`/api/jobs/${job.id}/annexure`, { headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not load the cost annexure');
            setCostReview(data);
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    // Rejecting hands the annexure back to the printing team rather than superseding it,
    // so the reason and the correction stay on one document's history. The reason is
    // required — without it the operator has nothing to act on.
    const rejectCostAnnexure = async () => {
        const a = costReview.annexure;
        const reason = window.prompt(
            `What is wrong with ${a.annexure_no}? This goes back to the printing team.`);
        if (reason === null) return;
        if (!reason.trim()) {
            await dialog.alert('Give a reason so the printing team knows what to correct.',
                { title: 'Reason required', variant: 'error' });
            return;
        }
        try {
            const res = await fetch(`/api/annexures/${a.annexure_no}/reject`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: reason.trim() }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not reject the annexure');
            await dialog.alert(data.message, { title: 'Sent back', variant: 'success' });
            setCostReview(null);
            fetchJobs();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    const approveCostAnnexure = async () => {
        const a = costReview.annexure;
        const ok = await dialog.confirm(
            `Approve ${a.annexure_no} for ${a.totals_display?.grand_total ?? costReview.totals_display.grand_total}? `
            + 'This locks the figures.',
            { title: 'Approve cost annexure', confirmLabel: 'Yes, approve' }
        );
        if (!ok) return;
        try {
            const res = await fetch(`/api/annexures/${a.annexure_no}/approve`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: '{}',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not approve the annexure');
            await dialog.alert(data.message, { title: 'Approved', variant: 'success' });
            setCostReview(null);
            fetchJobs();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    useEffect(() => {
        fetchJobs();
        const interval = setInterval(fetchJobs, 30000);
        return () => clearInterval(interval);
    }, []);

    // File endpoint requires the Bearer header, so fetch as a blob and open it
    // (a plain <a href> can't attach the Authorization header).
    const openDocument = async (jobId, docId) => {
        try {
            const res = await fetch(`/api/jobs/${jobId}/documents/${docId}/file`, { headers: authHeaders() });
            if (!res.ok) return;
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            window.open(url, '_blank', 'noopener');
            setTimeout(() => window.URL.revokeObjectURL(url), 60000);
        } catch (e) {
            console.warn('open document failed', e);
        }
    };

    const toggleDetails = async (job) => {
        if (expanded === job.id) {
            setExpanded(null);
            return;
        }
        setExpanded(job.id);
        if (!details[job.id]) {
            try {
                const res = await fetch(`/api/jobs/${job.id}`, { headers: authHeaders() });
                if (res.ok) {
                    const data = await res.json();
                    setDetails((prev) => ({ ...prev, [job.id]: data.documents || [] }));
                }
            } catch (e) {
                console.warn('detail load failed', e);
            }
        }
        // Always refresh the activity log (it changes as the job progresses).
        try {
            const res = await fetch(`/api/jobs/${job.id}/log`, { headers: authHeaders() });
            if (res.ok) {
                const logData = await res.json();
                setLogs((prev) => ({ ...prev, [job.id]: logData }));
            }
        } catch (e) {
            console.warn('log load failed', e);
        }
        // Edit history: only interesting once the job has been submitted more than once.
        try {
            const res = await fetch(`/api/jobs/${job.id}/submissions`, { headers: authHeaders() });
            if (res.ok) {
                const data = await res.json();
                setChangeLog((prev) => ({ ...prev, [job.id]: data.submissions || [] }));
            }
        } catch (e) {
            console.warn('submission history load failed', e);
        }
    };

    const badge = (status) => STATUS_BADGE[status] || { cls: 'bg-slate-100 text-slate-700', label: status };

    const q = search.trim().toLowerCase();
    const filtered = jobs.filter((j) => {
        if (statusFilter !== 'all' && j.status !== statusFilter) return false;
        if (!q) return true;
        return [(j.job_number || ''), (j.request_id || ''), (j.project_name || '')].some((v) => v.toLowerCase().includes(q));
    });
    const statusOptions = [...new Set(jobs.map((j) => j.status))];

    if (loading) {
        return (
            <div className="flex items-center justify-center" style={{ minHeight: '80vh' }}>
                <div className="spinner"></div>
            </div>
        );
    }

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h1 className="page-title">My Printing Jobs</h1>
                        <p className="page-subtitle">Track your printing requests and their status</p>
                    </div>
                    <button className="btn btn-primary" onClick={() => navigate('/job-creation')}>+ New Printing Job</button>
                </div>

                {/* Search + filter */}
                <div className="glass-card" style={{ marginBottom: '1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input className="input-field premium-search-field" style={{ flex: '1 1 240px' }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search job no or project…" />
                    <select className="input-field" style={{ width: 'auto' }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                        <option value="all">All statuses</option>
                        {statusOptions.map((s) => <option key={s} value={s}>{badge(s).label}</option>)}
                    </select>
                    <span className="text-muted" style={{ fontSize: '0.82rem' }}>{filtered.length} of {jobs.length}</span>
                </div>

                <div className="glass-card">
                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Request / Job No</th>
                                    <th>Project</th>
                                    <th>Docs</th>
                                    <th>Version</th>
                                    <th>Status</th>
                                    <th>Queue</th>
                                    <th>Submitted</th>
                                    <th style={{ textAlign: 'center' }}>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan="8" className="text-center" style={{ color: '#999', padding: '2rem' }}>
                                            {jobs.length === 0 ? 'No printing jobs yet. Click “New Printing Job” to create one.' : 'No jobs match your search.'}
                                        </td>
                                    </tr>
                                ) : (
                                    filtered.map((job) => {
                                        const b = badge(job.status);
                                        const isDraftLike = ['draft', 'returned', 'recalled'].includes(job.status);
                                        // Before anything is printed the fix is to pull the job back and edit it;
                                        // after printing it is a rework. Different problems, different buttons.
                                        const isRecallable = ['submitted', 'accepted'].includes(job.status) && !job.assigned_operator_id;
                                        return (
                                            <React.Fragment key={job.id}>
                                                <tr>
                                                    <td style={{ fontWeight: 600 }}>
                                                        {job.job_number || job.request_id}
                                                        {Number(job.priority) === 1 && (
                                                            <span style={{ marginLeft: '0.4rem', fontSize: '0.68rem', fontWeight: 700, color: '#B91C1C', background: '#FEE2E2', borderRadius: '6px', padding: '1px 5px' }}>🔥 RUSH</span>
                                                        )}
                                                        {job.job_number && (
                                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)', fontWeight: 400 }}>{job.request_id}</div>
                                                        )}
                                                    </td>
                                                    <td>{job.project_name || '-'}</td>
                                                    <td>{job.document_count}</td>
                                                    <td style={{ whiteSpace: 'nowrap' }}>
                                                        <span style={{ fontWeight: 700 }}>V{job.current_version || 1}</span>
                                                        {job.rework_count > 0 && (
                                                            <span className="text-muted" style={{ fontSize: '0.72rem', marginLeft: '0.3rem' }}>
                                                                {job.rework_count} rework{job.rework_count === 1 ? '' : 's'}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td>
                                                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${b.cls}`}>{b.label}</span>
                                                    </td>
                                                    <td>{job.queue_position ? `#${job.queue_position}` : '-'}</td>
                                                    <td className="text-muted">{formatDate(job.submitted_at)}</td>
                                                    <td style={{ textAlign: 'center' }}>
                                                        <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                            <button className="btn btn-sm btn-outline" onClick={() => toggleDetails(job)}>
                                                                {expanded === job.id ? 'Hide' : 'View'}
                                                            </button>
                                                            {isDraftLike && (
                                                                <button
                                                                    className="btn btn-sm btn-primary"
                                                                    onClick={() => navigate('/job-creation', { state: { jobId: job.id } })}
                                                                >
                                                                    {job.status === 'draft' ? 'Continue' : 'Edit & Resubmit'}
                                                                </button>
                                                            )}
                                                            {job.status === 'awaiting_receipt' && (
                                                                <button
                                                                    className="btn btn-sm btn-primary"
                                                                    onClick={() => confirmReceipt(job)}
                                                                    title="Confirm the printed materials reached you"
                                                                >
                                                                    Confirm receipt
                                                                </button>
                                                            )}
                                                            {job.annexure_status === 'under_review' && (
                                                                <button
                                                                    className="btn btn-sm btn-primary"
                                                                    onClick={() => openCostReview(job)}
                                                                    title="Verify the pages, sizes and amount, then approve or reject"
                                                                >
                                                                    Review cost
                                                                </button>
                                                            )}
                                                            {/* A draft is still with the printing team — the operator has to
                                                                check it against the actual print before it comes here. */}
                                                            {job.annexure_status === 'draft' && (
                                                                <span className="text-muted" style={{ fontSize: '0.75rem', alignSelf: 'center' }}
                                                                      title="The printer operator is checking the figures against what was actually printed">
                                                                    Cost being checked
                                                                </span>
                                                            )}
                                                            {job.annexure_status === 'approved' && (
                                                                <button
                                                                    className="btn btn-sm btn-outline"
                                                                    onClick={() => openCostReview(job)}
                                                                    title="You already approved this cost annexure"
                                                                >
                                                                    View approved cost
                                                                </button>
                                                            )}
                                                            {/* A completed job with no annexure means costing has not been
                                                                issued yet. Say so rather than showing nothing, which reads
                                                                as though the job simply has no cost. */}
                                                            {job.status === 'completed' && !job.annexure_status && (
                                                                <span className="text-muted" style={{ fontSize: '0.75rem', alignSelf: 'center' }}
                                                                      title="The printing team has not issued the cost annexure yet">
                                                                    Cost pending
                                                                </span>
                                                            )}
                                                            {isRecallable && (
                                                                <button
                                                                    className="btn btn-sm btn-primary"
                                                                    onClick={() => recallJob(job)}
                                                                    title="Pull this back to correct the document or details"
                                                                >
                                                                    Recall &amp; edit
                                                                </button>
                                                            )}
                                                            {REWORKABLE.includes(job.status) && (
                                                                <button
                                                                    className="btn btn-sm btn-primary"
                                                                    onClick={() => openReworkForm(job)}
                                                                    title="Send a corrected PDF for reprinting"
                                                                >
                                                                    Request rework
                                                                </button>
                                                            )}
                                                            {(job.rework_count > 0 || job.current_version > 1) && (
                                                                <button className="btn btn-sm btn-outline" onClick={() => loadVersions(job.id)}>Versions</button>
                                                            )}
                                                            <button className="btn btn-sm btn-outline" onClick={() => cloneJob(job)} title="Open a new request pre-filled from this one — nothing is created until you save it">Clone</button>
                                                            {/* Drafts only. A submitted request is part of the
                                                                workflow and the server refuses to delete it. */}
                                                            {job.status === 'draft' && (
                                                                <button className="btn btn-sm btn-danger" onClick={() => deleteDraft(job)}
                                                                        title="Discard this unsubmitted draft">
                                                                    Discard
                                                                </button>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                                {expanded === job.id && (
                                                    <tr>
                                                        <td colSpan="8" style={{ background: 'var(--surface-2)' }}>
                                                            {job.return_reason && (
                                                                <div style={{ marginBottom: '0.75rem', color: '#9A3412', background: '#FFF7ED', border: '1px solid #FDBA74', borderRadius: '8px', padding: '0.6rem 0.85rem' }}>
                                                                    <strong>Returned for correction:</strong> {job.return_reason}
                                                                </div>
                                                            )}
                                                            {job.reject_reason && (
                                                                <div style={{ marginBottom: '0.75rem', color: '#7F1D1D', background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: '8px', padding: '0.6rem 0.85rem' }}>
                                                                    <strong>Rejected:</strong> {job.reject_reason}
                                                                </div>
                                                            )}
                                                            {!details[job.id] ? (
                                                                <div className="text-muted" style={{ padding: '0.5rem' }}>Loading documents…</div>
                                                            ) : details[job.id].length === 0 ? (
                                                                <div className="text-muted" style={{ padding: '0.5rem' }}>No documents.</div>
                                                            ) : (
                                                                <table className="table" style={{ margin: 0 }}>
                                                                    <thead>
                                                                        <tr>
                                                                            <th>Document</th><th>Qty</th><th>Pages</th><th>Side</th>
                                                                            <th>Size / GSM</th><th>Colour</th><th>Binding</th><th>PDF</th>
                                                                        </tr>
                                                                    </thead>
                                                                    <tbody>
                                                                        {details[job.id].map((d) => (
                                                                            <tr key={d.id}>
                                                                                <td style={{ fontWeight: 600 }}>{d.document_name}</td>
                                                                                <td>{d.quantity}</td>
                                                                                <td>{d.num_pages || '-'}</td>
                                                                                <td>{d.print_side || '-'}</td>
                                                                                <td>{[d.paper_size, d.paper_gsm].filter(Boolean).join(' / ') || '-'}</td>
                                                                                <td>{d.color_mode || '-'}</td>
                                                                                <td>{d.binding_type || '-'}</td>
                                                                                <td>
                                                                                    <button className="btn btn-sm btn-outline" onClick={() => openDocument(job.id, d.id)}>
                                                                                        Open
                                                                                    </button>
                                                                                </td>
                                                                            </tr>
                                                                        ))}
                                                                    </tbody>
                                                                </table>
                                                            )}

                                                            {/* Edit history — only once the job has been submitted more than once */}
                                                            {changeLog[job.id]?.length > 1 && (
                                                                <div style={{ marginTop: '1rem' }}>
                                                                    <strong style={{ fontSize: '0.85rem', color: 'var(--text-strong)' }}>Edit history</strong>
                                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.4rem' }}>
                                                                        {[...changeLog[job.id]].reverse().map((sub) => (
                                                                            <SubmissionDiff key={sub.seq} submission={sub} />
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {/* Totals + Activity Log */}
                                                            {logs[job.id] && (
                                                                <div style={{ marginTop: '1rem' }}>
                                                                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}>
                                                                        <span style={{ background: '#EEF2FF', color: '#4338CA', borderRadius: '8px', padding: '0.4rem 0.75rem', fontSize: '0.82rem', fontWeight: 600 }}>
                                                                            📄 {logs[job.id].totals.documents} document(s)
                                                                        </span>
                                                                        <span style={{ background: '#ECFDF5', color: '#047857', borderRadius: '8px', padding: '0.4rem 0.75rem', fontSize: '0.82rem', fontWeight: 600 }}>
                                                                            📚 {logs[job.id].totals.copies} book(s) / copies
                                                                        </span>
                                                                        <span style={{ background: '#FEF3C7', color: '#92400E', borderRadius: '8px', padding: '0.4rem 0.75rem', fontSize: '0.82rem', fontWeight: 600 }}>
                                                                            🖨 {logs[job.id].totals.pages} total page-prints
                                                                        </span>
                                                                    </div>

                                                                    <div style={{ fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.6rem', fontSize: '0.9rem' }}>Activity Log</div>
                                                                    {logs[job.id].events.length === 0 ? (
                                                                        <div className="text-muted" style={{ fontSize: '0.85rem' }}>No activity recorded yet.</div>
                                                                    ) : (
                                                                        <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                                                                            {logs[job.id].events.map((ev, i) => {
                                                                                const m = actionMeta(ev.action);
                                                                                return (
                                                                                    <div key={i} style={{ position: 'relative' }}>
                                                                                        <span style={{ position: 'absolute', left: '-1.28rem', top: '3px', width: '10px', height: '10px', borderRadius: '50%', background: m.color, border: '2px solid var(--surface)' }} />
                                                                                        <div style={{ fontSize: '0.87rem', fontWeight: 600, color: 'var(--text-strong)' }}>{m.label}</div>
                                                                                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                                                                            {formatDate(ev.created_at)}{ev.user_name ? ` · ${ev.user_name}` : ''}
                                                                                        </div>
                                                                                        {ev.details && <div style={{ fontSize: '0.78rem', color: 'var(--text-body)', marginTop: '2px' }}>{ev.details}</div>}
                                                                                    </div>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Version history, opened from the Versions button on a row */}
                {Object.keys(versions).length > 0 && (
                    <div className="glass-card" style={{ marginTop: '1rem' }}>
                        {Object.entries(versions).map(([jobId, rows]) => (
                            <div key={jobId} style={{ marginBottom: '0.75rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <strong style={{ color: 'var(--text-strong)', fontSize: '0.9rem' }}>
                                        Revision history — {jobs.find((j) => String(j.id) === String(jobId))?.job_number || `Job ${jobId}`}
                                    </strong>
                                    <button className="btn btn-sm btn-outline"
                                            onClick={() => setVersions((prev) => { const n = { ...prev }; delete n[jobId]; return n; })}>
                                        Hide
                                    </button>
                                </div>
                                <div className="table-container" style={{ marginTop: '0.5rem' }}>
                                    <table className="table">
                                        <thead>
                                            <tr><th>Ver</th><th>Uploaded By</th><th>Date</th><th>Changed Pages</th><th>Addl</th><th>PDF</th></tr>
                                        </thead>
                                        <tbody>
                                            {rows.map((v) => (
                                                <tr key={v.version_no}>
                                                    <td style={{ fontWeight: 700 }}>V{v.version_no}</td>
                                                    <td>{v.uploaded_by} <span className="text-muted" style={{ fontSize: '0.75rem' }}>({v.uploaded_by_role})</span></td>
                                                    <td className="text-muted">{formatDate(v.uploaded_at)}</td>
                                                    <td>{v.modified_pages || '\u2014'}</td>
                                                    <td>{v.additional_pages ? `+${v.additional_pages}` : '0'}</td>
                                                    <td><button className="btn btn-sm btn-outline" onClick={() => openVersionPdf(jobId, v)}>Open</button></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Request rework — the requestor sends a corrected PDF */}
                {reworkJob && reworkForm && (
                    <div className="app-modal-backdrop" onClick={() => !reworkBusy && setReworkJob(null)}>
                        <div className="app-modal app-modal-md" onClick={(e) => e.stopPropagation()}
                             style={{ display: 'flex', flexDirection: 'column', maxHeight: '88vh', overflow: 'hidden' }}>
                            <h2 className="app-modal-title" style={{ flex: 'none' }}>Request rework</h2>
                            {/* Only the fields scroll — the action bar below must never leave the screen. */}
                            <div style={{ overflowY: 'auto', minHeight: 0, flex: '1 1 auto' }}>
                            <p className="text-muted" style={{ fontSize: '0.84rem', margin: '0 0 1rem' }}>
                                Send the corrected document for <strong>{reworkJob.job_number || reworkJob.request_id}</strong>.
                                The printing coordinator will assign it to an operator.
                            </p>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: '0.6rem',
                                          background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '8px',
                                          padding: '0.7rem 0.85rem', margin: '0 0 1rem', fontSize: '0.8rem' }}>
                                <div><div className="text-muted" style={{ fontSize: '0.7rem' }}>Job</div><strong>{reworkJob.job_number || reworkJob.request_id}</strong></div>
                                <div><div className="text-muted" style={{ fontSize: '0.7rem' }}>New version</div><strong>V{(reworkJob.current_version || 1) + 1}</strong></div>
                                <div><div className="text-muted" style={{ fontSize: '0.7rem' }}>Project</div><strong>{reworkJob.project_name || '\u2014'}</strong></div>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Revised PDF <span style={{ color: '#DC2626' }}>*</span></label>
                                <input type="file" accept="application/pdf" className="input-field"
                                       onChange={(e) => setReworkForm({ ...reworkForm, file: e.target.files?.[0] || null })} />
                                <span className="text-muted" style={{ fontSize: '0.75rem' }}>
                                    Attach the complete corrected document, not only the pages you changed. PDF, any size.
                                </span>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Which pages did you change? <span style={{ color: '#DC2626' }}>*</span></label>
                                <input className="input-field" value={reworkForm.modified_pages}
                                       placeholder="e.g. 5, 8, 30-36"
                                       onChange={(e) => { setReworkForm({ ...reworkForm, modified_pages: e.target.value }); previewPages(e.target.value); }} />
                                {pagePreview?.error
                                    ? <span style={{ fontSize: '0.75rem', color: '#DC2626' }}>{pagePreview.error}</span>
                                    : pagePreview
                                        ? <span style={{ fontSize: '0.75rem', color: 'var(--stat-emerald)' }}>Reads as {pagePreview.count} page{pagePreview.count === 1 ? '' : 's'}: {pagePreview.list}</span>
                                        : <span className="text-muted" style={{ fontSize: '0.75rem' }}>Single pages, lists or ranges — 12 · 5, 8, 19 · 30-36 · 5, 8, 30-36</span>}
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0.85rem' }}>
                                <div className="input-group">
                                    <label className="input-label">Pages added</label>
                                    <input type="number" min="0" className="input-field" value={reworkForm.additional_pages}
                                           onChange={(e) => setReworkForm({ ...reworkForm, additional_pages: e.target.value })} />
                                    <span className="text-muted" style={{ fontSize: '0.75rem' }}>0 if you added none</span>
                                </div>
                                <div className="input-group">
                                    <label className="input-label">
                                        Where do they go? {Number(reworkForm.additional_pages) > 0 && <span style={{ color: '#DC2626' }}>*</span>}
                                    </label>
                                    <select className="input-field" value={reworkForm.insert_mode} disabled={!(Number(reworkForm.additional_pages) > 0)}
                                            onChange={(e) => setReworkForm({ ...reworkForm, insert_mode: e.target.value })}>
                                        <option value="end">End of document</option>
                                        <option value="after">After page…</option>
                                        <option value="before">Before page…</option>
                                    </select>
                                    {Number(reworkForm.additional_pages) > 0 && reworkForm.insert_mode !== 'end' && (
                                        <input type="number" min="1" className="input-field" style={{ marginTop: '0.4rem' }}
                                               placeholder="Page number" value={reworkForm.insert_page}
                                               onChange={(e) => setReworkForm({ ...reworkForm, insert_page: e.target.value })} />
                                    )}
                                </div>
                            </div>

                            <div className="input-group">
                                <label className="input-label">What changed? <span style={{ color: '#DC2626' }}>*</span></label>
                                <textarea className="input-field" rows="3" value={reworkForm.change_description}
                                          placeholder="e.g. Corrected the revision table on page 25 and updated the drawing on pages 12-14."
                                          onChange={(e) => setReworkForm({ ...reworkForm, change_description: e.target.value })} />
                                <span className="text-muted" style={{ fontSize: '0.75rem' }}>The operator reads this before reprinting.</span>
                            </div>

                            </div>

                            <div className="app-modal-actions" style={{ flex: 'none' }}>
                                <button className="btn btn-outline" disabled={reworkBusy} onClick={() => setReworkJob(null)}>Cancel</button>
                                <button className="btn btn-primary" disabled={reworkBusy} onClick={submitRework}>
                                    {reworkBusy ? 'Sending\u2026' : 'Send rework request'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Review the printing cost annexure and approve it. The coordinator/operator
                    already corrected the figures to what was actually printed — this is the
                    requestor's check on amount, pages and services before it is locked. */}
                {costReview && (
                    <div className="app-modal-backdrop" onClick={() => setCostReview(null)}>
                        <div className="app-modal app-modal-lg" onClick={(e) => e.stopPropagation()}
                             style={{ display: 'flex', flexDirection: 'column', maxHeight: '90vh', overflow: 'hidden' }}>
                            <div style={{ flex: 'none' }}>
                                <h2 className="app-modal-title" style={{ marginBottom: '0.3rem' }}>
                                    {costReview.annexure.annexure_no}
                                    {costReview.annexure.version > 1 ? ` v${costReview.annexure.version}` : ''}
                                </h2>
                                <p className="text-muted" style={{ fontSize: '0.82rem', margin: 0 }}>
                                    Printing cost for {costReview.annexure.job_number || costReview.annexure.request_id}
                                    {costReview.annexure.status === 'approved' && (
                                        <span style={{ color: 'var(--stat-emerald)', fontWeight: 700 }}> · Approved</span>
                                    )}
                                </p>
                            </div>

                            <div style={{ overflowY: 'auto', minHeight: 0, flex: '1 1 auto', marginTop: '1rem' }}>
                                {costReview.documents?.length > 0 && (
                                    <div className="table-container" style={{ marginBottom: '1rem' }}>
                                        <table className="table">
                                            <thead><tr><th>Document</th><th>Copies</th><th>Pages</th><th>Size / GSM</th><th>Colour</th><th>Binding</th></tr></thead>
                                            <tbody>
                                                {costReview.documents.map((d, i) => (
                                                    <tr key={i}>
                                                        <td style={{ fontWeight: 600 }}>{d.document_name}</td>
                                                        <td>{d.quantity}</td><td>{d.num_pages || '—'}</td>
                                                        <td>{[d.paper_size, d.paper_gsm].filter(Boolean).join(' / ') || '—'}</td>
                                                        <td>{d.color_mode || '—'}</td><td>{d.binding_type || '—'}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                <div className="table-container">
                                    <table className="table">
                                        <thead><tr><th>Service</th><th style={{ textAlign: 'right' }}>Qty</th><th>Unit</th>
                                            <th style={{ textAlign: 'right' }}>Rate (₹)</th>
                                            <th style={{ textAlign: 'right' }}>Amount (₹)</th></tr></thead>
                                        <tbody>
                                            {costReview.lines.map((l) => (
                                                <tr key={l.id}>
                                                    <td>
                                                        {l.label}
                                                        {l.detail && <div className="text-muted" style={{ fontSize: '0.75rem' }}>{l.detail}</div>}
                                                    </td>
                                                    <td style={{ textAlign: 'right' }}>{Number(l.quantity).toLocaleString()}</td>
                                                    <td className="text-muted">{l.uom}</td>
                                                    <td style={{ textAlign: 'right', fontFamily: 'monospace',
                                                                 color: l.unpriced ? 'var(--stat-amber)' : undefined }}>{l.rate_display}</td>
                                                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{l.amount_display}</td>
                                                </tr>
                                            ))}
                                            <tr>
                                                <td colSpan="4" style={{ textAlign: 'right', fontWeight: 800, color: 'var(--text-strong)' }}>GRAND TOTAL</td>
                                                <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 800, fontSize: '1.05rem',
                                                             color: 'var(--stat-emerald)', borderTop: '2px solid var(--border-strong)' }}>
                                                    {costReview.totals_display.grand_total}
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                                <p className="text-muted" style={{ fontSize: '0.82rem', marginTop: '0.5rem', fontStyle: 'italic' }}>
                                    {costReview.totals_display.in_words}
                                </p>

                                {costReview.lines.some((l) => l.unpriced) && (
                                    <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.9rem', borderRadius: '8px',
                                                  background: 'var(--surface-2)', borderLeft: '3px solid var(--stat-amber)' }}>
                                        <strong style={{ color: 'var(--stat-amber)', fontSize: '0.85rem' }}>
                                            {costReview.lines.filter((l) => l.unpriced).length} item(s) have no rate configured yet
                                        </strong>
                                        <p className="text-muted" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0' }}>
                                            They are shown above but left out of the total. You can still approve — the
                                            amount will be revised once those rates are added.
                                        </p>
                                    </div>
                                )}
                            </div>

                            <div className="app-modal-actions" style={{ flex: 'none' }}>
                                <button className="btn btn-outline" onClick={() => setCostReview(null)}>Close</button>
                                {costReview.annexure.status === 'under_review' && (
                                    <>
                                        <button className="btn btn-danger" onClick={rejectCostAnnexure}>
                                            Reject
                                        </button>
                                        <button className="btn btn-primary" onClick={approveCostAnnexure}>
                                            Approve cost
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default JobHistoryPage;
