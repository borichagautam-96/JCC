import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { formatDateTime } from '../utils/datetime';

const FEEDBACK_TYPES = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature_request', label: 'Feature Request' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'ui_ux', label: 'UI/UX' },
  { value: 'performance', label: 'Performance' },
  { value: 'other', label: 'Other' },
];

const STATUS_LABELS = {
  new: 'New',
  triaged: 'Triaged',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

const getDefaultForm = (sourcePath = '/') => ({
  feedbackType: 'improvement',
  description: '',
  modulePath: sourcePath || '/',
  stepsToReproduce: '',
  expectedResult: '',
  actualResult: '',
  contactAllowed: true,
});

const FeedbackPage = () => {
  const { getToken } = useAuth();
  const dialog = useDialog();
  const location = useLocation();

  const sourcePath = useMemo(() => {
    const fromState = String(location.state?.sourcePath || '').trim();
    return fromState || '/';
  }, [location.state]);

  const [form, setForm] = useState(() => getDefaultForm(sourcePath));
  const [submitting, setSubmitting] = useState(false);
  const [loadingMine, setLoadingMine] = useState(true);
  const [mineRows, setMineRows] = useState([]);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
    'X-Device-ID': getDeviceId(),
  }), [getToken]);

  useEffect(() => {
    setForm((prev) => ({ ...prev, modulePath: sourcePath }));
  }, [sourcePath]);

  const fetchMyFeedback = async () => {
    setLoadingMine(true);
    try {
      const response = await fetch('/api/feedback/mine?limit=20', { headers: authHeaders });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load your feedback');
      }
      setMineRows(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not load your feedback history');
    } finally {
      setLoadingMine(false);
    }
  };

  useEffect(() => {
    fetchMyFeedback();
  }, []);

  const updateField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const payload = {
      feedbackType: String(form.feedbackType || '').trim(),
      description: String(form.description || '').trim(),
      modulePath: String(form.modulePath || '').trim(),
      stepsToReproduce: String(form.stepsToReproduce || '').trim(),
      expectedResult: String(form.expectedResult || '').trim(),
      actualResult: String(form.actualResult || '').trim(),
      contactAllowed: Boolean(form.contactAllowed),
    };

    if (!payload.description) {
      await dialog.alert('Please describe your feedback.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to submit feedback');
      }

      await dialog.alert('Thanks. Your feedback has been submitted.');
      setForm(getDefaultForm(sourcePath));
      fetchMyFeedback();
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not submit feedback');
    } finally {
      setSubmitting(false);
    }
  };

  let historyContent = null;
  if (loadingMine) {
    historyContent = <p style={{ margin: 0, color: 'var(--text-muted)' }}>Loading...</p>;
  } else if (mineRows.length === 0) {
    historyContent = <p style={{ margin: 0, color: 'var(--text-muted)' }}>No feedback submitted yet.</p>;
  } else {
    historyContent = (
      <div style={{ display: 'grid', gap: '0.8rem' }}>
        {mineRows.map((row) => (
          <div key={row.id} style={{ border: '1px solid var(--border)', borderRadius: '10px', padding: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', marginBottom: '0.3rem' }}>
              <strong style={{ color: 'var(--text-strong)', textTransform: 'capitalize' }}>{String(row.feedback_type || 'other').replace('_', ' ')}</strong>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-body)', textTransform: 'capitalize' }}>
                {STATUS_LABELS[row.status] || row.status}
              </span>
            </div>
            <p style={{ margin: '0 0 0.4rem 0', color: 'var(--text-body)', fontSize: '0.9rem' }}>{row.description}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.55rem', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
              {row.module_path ? <span>{row.module_path}</span> : null}
              <span>{formatDateTime(row.created_at)}</span>
            </div>
            {row.admin_note ? (
              <div style={{ marginTop: '0.55rem', fontSize: '0.82rem', color: 'var(--text-body)' }}>
                <strong>Admin Note:</strong> {row.admin_note}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="container page-shell fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Feedback</h1>
          <p className="page-subtitle">Share bugs, ideas, and improvements. Admin can review and track every submission.</p>
        </div>
      </div>

      <div className="card-grid" style={{ gridTemplateColumns: 'minmax(320px, 2fr) minmax(300px, 1fr)', alignItems: 'start' }}>
        <form className="glass-card" onSubmit={handleSubmit}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Submit Feedback</h3>

          <div className="input-group">
            <label className="input-label" htmlFor="feedback-type">Type</label>
            <select
              id="feedback-type"
              className="input-field"
              value={form.feedbackType}
              onChange={(event) => updateField('feedbackType', event.target.value)}
            >
              {FEEDBACK_TYPES.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>

          <div className="input-group">
            <label className="input-label" htmlFor="feedback-description">Description</label>
            <textarea
              id="feedback-description"
              className="input-field"
              rows={4}
              value={form.description}
              onChange={(event) => updateField('description', event.target.value)}
              placeholder="What happened, what can be improved, or what feature you need"
              required
            />
          </div>

          {form.feedbackType === 'bug' && (
            <>
              <div className="input-group">
                <label className="input-label" htmlFor="feedback-steps">Steps to Reproduce</label>
                <textarea
                  id="feedback-steps"
                  className="input-field"
                  rows={3}
                  value={form.stepsToReproduce}
                  onChange={(event) => updateField('stepsToReproduce', event.target.value)}
                  placeholder="Step 1, Step 2, Step 3"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem' }}>
                <div className="input-group">
                  <label className="input-label" htmlFor="feedback-expected">Expected Result</label>
                  <textarea
                    id="feedback-expected"
                    className="input-field"
                    rows={3}
                    value={form.expectedResult}
                    onChange={(event) => updateField('expectedResult', event.target.value)}
                    placeholder="What should happen"
                  />
                </div>

                <div className="input-group">
                  <label className="input-label" htmlFor="feedback-actual">Actual Result</label>
                  <textarea
                    id="feedback-actual"
                    className="input-field"
                    rows={3}
                    value={form.actualResult}
                    onChange={(event) => updateField('actualResult', event.target.value)}
                    placeholder="What actually happened"
                  />
                </div>
              </div>
            </>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', color: 'var(--text-body)' }}>
            <input
              type="checkbox"
              checked={form.contactAllowed}
              onChange={(event) => updateField('contactAllowed', event.target.checked)}
            />
            <span>You can contact me for clarification</span>
          </label>

          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Submitting...' : 'Submit Feedback'}
          </button>
        </form>

        <div className="glass-card" style={{ maxHeight: '680px', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.9rem' }}>
            <h3 style={{ margin: 0 }}>My Recent Feedback</h3>
            <button className="btn btn-outline" type="button" onClick={fetchMyFeedback} disabled={loadingMine}>
              {loadingMine ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          {historyContent}
        </div>
      </div>
    </div>
  );
};

export default FeedbackPage;
