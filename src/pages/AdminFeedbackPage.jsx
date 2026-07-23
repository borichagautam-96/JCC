import React, { useEffect, useMemo, useState } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Solved' },
  { value: 'closed', label: 'Closed' },
];

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const TYPE_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'bug', label: 'Bug' },
  { value: 'feature_request', label: 'Feature Request' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'ui_ux', label: 'UI/UX' },
  { value: 'performance', label: 'Performance' },
  { value: 'other', label: 'Other' },
];

const formatDateTime = (value) => {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString();
};

const AdminFeedbackPage = () => {
  const { getToken } = useAuth();
  const dialog = useDialog();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [assignees, setAssignees] = useState([]);

  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
    'X-Device-ID': getDeviceId(),
  }), [getToken]);

  const updateDraft = (id, key, value) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: prev[id]
        ? {
            ...prev[id],
            [key]: value,
          }
        : { [key]: value },
    }));
  };

  const getEffectiveValue = (row, key) => {
    const draft = drafts[row.id] || {};
    if (Object.hasOwn(draft, key)) {
      return draft[key];
    }
    return row[key] ?? '';
  };

  const fetchFeedback = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '300');
      if (statusFilter) params.set('status', statusFilter);
      if (typeFilter) params.set('type', typeFilter);
      if (search.trim()) params.set('search', search.trim());

      const response = await fetch(`/api/feedback?${params.toString()}`, { headers: authHeaders });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load feedback');
      }

      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not load feedback inbox');
    } finally {
      setLoading(false);
    }
  };

  const fetchAssignees = async () => {
    try {
      const response = await fetch('/api/users', { headers: authHeaders });
      const data = await response.json();
      if (!response.ok) return;

      const list = Array.isArray(data) ? data : [];
      const filtered = list
        .filter((user) => ['admin', 'manager', 'coordinator'].includes(String(user.role || '').toLowerCase()))
        .map((user) => ({ id: user.id, name: user.name, role: user.role }));

      setAssignees(filtered);
    } catch (error) {
      console.error('Failed to load assignees:', error);
    }
  };

  const handleResolve = async (row) => {
    const payload = {
      status: 'resolved',
      priority: getEffectiveValue(row, 'priority'),
      assignedTo: getEffectiveValue(row, 'assigned_to') || null,
      adminNote: getEffectiveValue(row, 'admin_note') || '',
    };

    setSavingId(row.id);
    try {
      const response = await fetch(`/api/feedback/${row.id}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to resolve feedback');
      }

      setDrafts((prev) => {
        const clone = { ...prev };
        delete clone[row.id];
        return clone;
      });

      await fetchFeedback();
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not resolve feedback');
    } finally {
      setSavingId(null);
    }
  };

  useEffect(() => {
    fetchFeedback();
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    fetchAssignees();
  }, []);

  let tableBodyContent = null;
  if (loading) {
    tableBodyContent = (
      <tr>
        <td colSpan="10" className="text-center">Loading feedback...</td>
      </tr>
    );
  } else if (rows.length === 0) {
    tableBodyContent = (
      <tr>
        <td colSpan="10" className="text-center" style={{ color: 'var(--text-muted)' }}>No feedback found.</td>
      </tr>
    );
  } else {
    tableBodyContent = rows.map((row) => {
      const currentStatus = String(getEffectiveValue(row, 'status') || row.status || 'new');
      const isResolved = currentStatus === 'resolved';
      let actionLabel = 'Resolve';
      if (isResolved) {
        actionLabel = 'Solved';
      }
      if (savingId === row.id) {
        actionLabel = 'Resolving...';
      }

      return (
      <tr key={row.id}>
        <td>{formatDateTime(row.created_at)}</td>
        <td>
          <div style={{ fontWeight: 600 }}>{row.submitted_by_name || 'Unknown'}</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{row.submitted_by_email || '-'}</div>
        </td>
        <td style={{ textTransform: 'capitalize' }}>{String(row.feedback_type || 'other').replaceAll('_', ' ')}</td>
        <td>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', whiteSpace: 'normal', wordBreak: 'break-word' }}>{row.description}</div>
        </td>
        <td>{row.module_path || '-'}</td>
        <td>
          <select
            className="input-field feedback-control-select"
            value={getEffectiveValue(row, 'status')}
            onChange={(event) => updateDraft(row.id, 'status', event.target.value)}
          >
            {STATUS_OPTIONS.map((status) => (
              <option key={status.value} value={status.value}>{status.label}</option>
            ))}
          </select>
        </td>
        <td>
          <select
            className="input-field feedback-control-select"
            value={getEffectiveValue(row, 'priority')}
            onChange={(event) => updateDraft(row.id, 'priority', event.target.value)}
          >
            {PRIORITY_OPTIONS.map((priority) => (
              <option key={priority.value} value={priority.value}>{priority.label}</option>
            ))}
          </select>
        </td>
        <td>
          <select
            className="input-field feedback-control-select feedback-control-assignee"
            value={getEffectiveValue(row, 'assigned_to') || ''}
            onChange={(event) => updateDraft(row.id, 'assigned_to', event.target.value ? Number.parseInt(event.target.value, 10) : null)}
          >
            <option value="">Unassigned</option>
            {assignees.map((assignee) => (
              <option key={assignee.id} value={assignee.id}>{assignee.name} ({assignee.role})</option>
            ))}
          </select>
        </td>
        <td>
          <textarea
            className="input-field feedback-note-field"
            rows={2}
            value={getEffectiveValue(row, 'admin_note') || ''}
            onChange={(event) => updateDraft(row.id, 'admin_note', event.target.value)}
            placeholder="Admin note"
          />
        </td>
        <td>
          <button
            className="btn btn-success feedback-action-button"
            type="button"
            disabled={savingId === row.id || isResolved}
            onClick={() => handleResolve(row)}
          >
            {actionLabel}
          </button>
        </td>
      </tr>
    );
    });
  }

  return (
    <div className="container page-shell fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Feedback Inbox</h1>
          <p className="page-subtitle">Review and triage user feedback submissions.</p>
        </div>
      </div>

      <div className="glass-card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '200px 220px 1fr auto', gap: '0.75rem', alignItems: 'end' }}>
          <div className="input-group" style={{ margin: 0 }}>
            <label className="input-label" htmlFor="feedback-status-filter">Status</label>
            <select
              id="feedback-status-filter"
              className="input-field"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">All Statuses</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status.value} value={status.value}>{status.label}</option>
              ))}
            </select>
          </div>

          <div className="input-group" style={{ margin: 0 }}>
            <label className="input-label" htmlFor="feedback-type-filter">Type</label>
            <select
              id="feedback-type-filter"
              className="input-field"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
            >
              {TYPE_OPTIONS.map((type) => (
                <option key={type.value || 'all'} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>

          <div className="input-group" style={{ margin: 0 }}>
            <label className="input-label" htmlFor="feedback-search-filter">Search</label>
            <input
              id="feedback-search-filter"
              className="input-field premium-search-field"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search description, page, user"
            />
          </div>

          <button className="btn btn-outline" type="button" onClick={fetchFeedback} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="glass-card feedback-inbox-scroll">
        <table className="table feedback-inbox-table">
          <colgroup>
            <col style={{ width: '160px' }} />
            <col style={{ width: '240px' }} />
            <col style={{ width: '90px' }} />
            <col style={{ width: '360px' }} />
            <col style={{ width: '140px' }} />
            <col style={{ width: '140px' }} />
            <col style={{ width: '130px' }} />
            <col style={{ width: '200px' }} />
            <col style={{ width: '260px' }} />
            <col style={{ width: '130px' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Created</th>
              <th>Submitted By</th>
              <th>Type</th>
              <th>Description</th>
              <th>Module</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Assigned To</th>
              <th>Admin Note</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>{tableBodyContent}</tbody>
        </table>
      </div>
    </div>
  );
};

export default AdminFeedbackPage;
