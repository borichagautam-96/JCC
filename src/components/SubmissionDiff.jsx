import React from 'react';
import { formatDateTime } from '../utils/datetime';

// Renders what changed between two submissions of a printing request.
//
// Used on three screens — the coordinator re-verifying a resubmit, the requestor
// reviewing their own edit history, and the activity log — so the shape of the
// answer is identical everywhere and only one place needs changing when the
// wording is wrong.

const TRIGGER_LABEL = {
    initial: 'Initial submission',
    after_recall: 'Resubmitted after recall',
    after_return: 'Resubmitted after return for correction',
};

const KIND_LABEL = {
    added: 'Document added',
    removed: 'Document removed',
    pdf_replaced: 'PDF replaced',
    modified: 'Document amended',
};

const KIND_COLOUR = {
    added: 'var(--stat-emerald)',
    removed: 'var(--stat-red)',
    pdf_replaced: 'var(--stat-amber)',
    modified: 'var(--stat-blue)',
};

const Delta = ({ label, totals }) => {
    if (!totals || totals.delta === 0) return null;
    const up = totals.delta > 0;
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'baseline', gap: '0.3rem',
            fontSize: '0.8rem', padding: '0.15rem 0.5rem', borderRadius: '999px',
            background: 'var(--surface-3)', border: '1px solid var(--border)',
            whiteSpace: 'nowrap',
        }}>
            <span style={{ color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ color: 'var(--text-strong)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {totals.from} → {totals.to}
            </span>
            <span style={{ color: up ? 'var(--stat-emerald)' : 'var(--stat-red)', fontWeight: 700 }}>
                {up ? '+' : ''}{totals.delta}
            </span>
        </span>
    );
};

const FieldRow = ({ change }) => (
    <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(120px,180px) 1fr',
        gap: '0.6rem', padding: '0.2rem 0', fontSize: '0.82rem',
    }}>
        <span style={{ color: 'var(--text-muted)' }}>{change.label}</span>
        <span style={{ color: 'var(--text-strong)' }}>
            <span style={{ textDecoration: 'line-through', opacity: 0.6 }}>{change.from}</span>
            {'  →  '}
            <strong>{change.to}</strong>
        </span>
    </div>
);

const SubmissionDiff = ({ submission }) => {
    if (!submission) return null;
    const { diff, triggerKind, triggerReason, submittedBy, submittedAt, seq } = submission;

    const header = (
        <div style={{ marginBottom: '0.6rem' }}>
            <strong style={{ color: 'var(--text-strong)', fontSize: '0.88rem' }}>
                {TRIGGER_LABEL[triggerKind] || 'Submitted'} · Submission {seq}
            </strong>
            <span className="text-muted" style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>
                {submittedBy} · {formatDateTime(submittedAt)}
            </span>
            {triggerReason && (
                <div style={{ fontSize: '0.82rem', color: 'var(--text-body)', marginTop: '0.2rem', fontStyle: 'italic' }}>
                    “{triggerReason}”
                </div>
            )}
        </div>
    );

    if (!diff) {
        return (
            <div style={{ padding: '0.7rem 0.9rem', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '8px' }}>
                {header}
                <span className="text-muted" style={{ fontSize: '0.82rem' }}>
                    Nothing to compare — this is the first submission.
                </span>
            </div>
        );
    }

    if (diff.isNoOp) {
        return (
            <div style={{ padding: '0.7rem 0.9rem', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '8px' }}>
                {header}
                <span style={{ fontSize: '0.82rem', color: 'var(--stat-amber)' }}>
                    Resubmitted with no changes — nothing was edited.
                </span>
            </div>
        );
    }

    return (
        <div style={{ padding: '0.7rem 0.9rem', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '8px' }}>
            {header}

            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
                <Delta label="Documents" totals={diff.totals?.books} />
                <Delta label="Total pages" totals={diff.totals?.pages} />
                <Delta label="Total copies" totals={diff.totals?.copies} />
            </div>

            {diff.documentChanges?.map((change, i) => (
                <div key={`${change.documentName}-${i}`} style={{ marginBottom: '0.5rem' }}>
                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{
                            fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.04em',
                            textTransform: 'uppercase', color: KIND_COLOUR[change.kind] || 'var(--text-muted)',
                        }}>
                            {KIND_LABEL[change.kind] || change.kind}
                        </span>
                        <strong style={{ color: 'var(--text-strong)', fontSize: '0.85rem' }}>{change.documentName}</strong>
                        {change.kind === 'added' && change.pages != null && (
                            <span className="text-muted" style={{ fontSize: '0.78rem' }}>{change.pages} pages</span>
                        )}
                        {change.pdfReplaced && change.kind === 'modified' && (
                            <span style={{ fontSize: '0.72rem', color: 'var(--stat-amber)' }}>· PDF replaced</span>
                        )}
                    </div>
                    {change.fieldChanges?.map((fc) => <FieldRow key={fc.field} change={fc} />)}
                </div>
            ))}

            {diff.headerChanges?.length > 0 && (
                <div style={{ marginTop: '0.4rem', paddingTop: '0.4rem', borderTop: '1px solid var(--border)' }}>
                    <div style={{
                        fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.04em',
                        textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.2rem',
                    }}>
                        Request details
                    </div>
                    {diff.headerChanges.map((hc) => <FieldRow key={hc.field} change={hc} />)}
                </div>
            )}
        </div>
    );
};

export default SubmissionDiff;
