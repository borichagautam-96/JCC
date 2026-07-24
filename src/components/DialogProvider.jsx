import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';

const DialogContext = createContext(null);

export const useDialog = () => {
    const ctx = useContext(DialogContext);
    if (!ctx) throw new Error('useDialog must be used within DialogProvider');
    return ctx;
};

/* ─── Icon SVGs ─── */
const icons = {
    success: (
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12l2.5 2.5L16 9" />
        </svg>
    ),
    error: (
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
    ),
    warning: (
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
    ),
    info: (
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
    ),
    confirm: (
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#6366F1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
    ),
};

const accentColors = {
    success: '#10B981',
    error: '#EF4444',
    warning: '#F59E0B',
    info: '#3B82F6',
    confirm: '#6366F1',
};

const bgTints = {
    success: 'rgba(16,185,129,0.08)',
    error: 'rgba(239,68,68,0.08)',
    warning: 'rgba(245,158,11,0.08)',
    info: 'rgba(59,130,246,0.08)',
    confirm: 'rgba(99,102,241,0.08)',
};

/* ─── Auto-detect alert type from message ─── */
function detectAlertType(message) {
    const m = (message || '').toLowerCase();
    // Error keywords must be checked FIRST — they must win over positive words.
    // e.g. "Cannot approve: claim status is approved" contains both 'cannot' AND
    // 'approved', so without this ordering it would incorrectly show as success.
    if (m.includes('fail') || m.includes('error') || m.includes('cannot') || m.includes('unable') || m.includes('invalid') || m.includes('denied') || m.includes('unauthorized')) return 'error';
    if (m.includes('please') || m.includes('provide') || m.includes('required')) return 'warning';
    if (m.includes('success') || m.includes('created') || m.includes('updated') || m.includes('deleted') || m.includes('imported') || m.includes('released') || m.includes('approved') || m.includes('resubmitted') || m.includes('uploaded') || m.includes('verified') || m.includes('sent')) return 'success';
    return 'info';
}


/* ─── Inline Styles (CSS-in-JS) ─── */
const styles = {
    overlay: {
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 99999,
        padding: '1rem',
        opacity: 0,
        transition: 'opacity 0.25s ease',
    },
    overlayVisible: {
        opacity: 1,
    },
    card: {
        background: 'var(--surface)',
        borderRadius: '16px',
        boxShadow: '0 25px 60px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.05)',
        width: '100%',
        maxWidth: '420px',
        overflow: 'hidden',
        transform: 'scale(0.85) translateY(20px)',
        opacity: 0,
        transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease',
    },
    cardVisible: {
        transform: 'scale(1) translateY(0)',
        opacity: 1,
    },
    cardExiting: {
        transform: 'scale(0.9) translateY(10px)',
        opacity: 0,
        transition: 'transform 0.2s ease, opacity 0.15s ease',
    },
    topStripe: (type) => ({
        height: '4px',
        background: `linear-gradient(90deg, ${accentColors[type]}, ${accentColors[type]}99)`,
    }),
    body: (type) => ({
        padding: '2rem 2rem 1.5rem',
        textAlign: 'center',
        background: bgTints[type],
    }),
    iconWrap: {
        display: 'flex',
        justifyContent: 'center',
        marginBottom: '1rem',
    },
    iconCircle: (type) => ({
        width: '72px',
        height: '72px',
        borderRadius: '50%',
        background: `${accentColors[type]}15`,
        border: `2px solid ${accentColors[type]}30`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    }),
    title: {
        margin: '0 0 0.5rem',
        fontSize: '1.15rem',
        fontWeight: 700,
        color: 'var(--text-strong)',
        lineHeight: 1.3,
    },
    message: {
        margin: 0,
        fontSize: '0.95rem',
        color: 'var(--text-body)',
        lineHeight: 1.6,
        wordBreak: 'break-word',
    },
    footer: {
        display: 'flex',
        gap: '0.75rem',
        padding: '1rem 2rem 1.5rem',
        justifyContent: 'center',
    },
    btnBase: {
        border: 'none',
        borderRadius: '10px',
        padding: '0.7rem 1.8rem',
        fontSize: '0.9rem',
        fontWeight: 600,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        minWidth: '110px',
        letterSpacing: '0.01em',
        outline: 'none',
    },
    btnPrimary: (type) => ({
        background: `linear-gradient(135deg, ${accentColors[type]}, ${accentColors[type]}dd)`,
        color: '#fff',
        boxShadow: `0 4px 14px ${accentColors[type]}40`,
    }),
    btnCancel: {
        background: 'var(--surface-3)',
        color: 'var(--text-body)',
        border: '1px solid var(--border)',
    },
};

/* ─── Dialog Component ─── */
const DialogBox = ({ dialog, onClose }) => {
    const [visible, setVisible] = useState(false);
    const [exiting, setExiting] = useState(false);
    const [inputValue, setInputValue] = useState(dialog.defaultValue || '');
    const primaryRef = useRef(null);
    const inputRef = useRef(null);
    const isPrompt = dialog.type === 'prompt';

    useEffect(() => {
        // Trigger enter animation
        requestAnimationFrame(() => {
            requestAnimationFrame(() => setVisible(true));
        });
        // Focus the input on a prompt, otherwise the primary button
        if (isPrompt && inputRef.current) inputRef.current.focus();
        else if (primaryRef.current) primaryRef.current.focus();
    }, [isPrompt]);

    const handleClose = useCallback((result) => {
        setExiting(true);
        setVisible(false);
        setTimeout(() => onClose(result), 220);
    }, [onClose]);

    // Keyboard support
    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'Escape') {
                handleClose(dialog.type === 'confirm' ? false : (isPrompt ? null : undefined));
            } else if (e.key === 'Enter' && !e.shiftKey) {
                if (isPrompt) { e.preventDefault(); handleClose(inputValue); }
                else handleClose(dialog.type === 'confirm' ? true : undefined);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [handleClose, dialog.type, isPrompt, inputValue]);

    const isConfirm = dialog.type === 'confirm';
    // Prompt shares the confirm two-button layout; cancel resolves to null.
    const twoButton = isConfirm || isPrompt;
    const visualType = isConfirm ? (dialog.variant || 'confirm')
        : isPrompt ? (dialog.variant || 'confirm')
        : (dialog.variant || detectAlertType(dialog.message));

    const titleText = dialog.title || (isConfirm ? 'Confirm Action' :
        visualType === 'success' ? 'Success' :
        visualType === 'error' ? 'Error' :
        visualType === 'warning' ? 'Warning' : 'Notice');

    return (
        <div
            className="lg-dialog-overlay"
            style={{
                ...styles.overlay,
                ...(visible && !exiting ? styles.overlayVisible : {}),
            }}
            onClick={(e) => {
                if (e.target === e.currentTarget) handleClose(isConfirm ? false : undefined);
            }}
        >
            <div
                className="lg-dialog-card"
                style={{
                    ...styles.card,
                    ...(visible && !exiting ? styles.cardVisible : {}),
                    ...(exiting ? styles.cardExiting : {}),
                }}
                role="dialog"
                aria-modal="true"
                aria-labelledby="dialog-title"
            >
                <div style={styles.topStripe(visualType)} />
                <div style={styles.body(visualType)}>
                    <div style={styles.iconWrap}>
                        <div style={styles.iconCircle(visualType)}>
                            {icons[visualType]}
                        </div>
                    </div>
                    <h3 id="dialog-title" style={styles.title}>{titleText}</h3>
                    <p style={styles.message}>
                        {String(dialog.message || '').split('\n').map((line, i, arr) => (
                            <React.Fragment key={i}>{line}{i < arr.length - 1 && <br />}</React.Fragment>
                        ))}
                    </p>
                    {isPrompt && (
                        dialog.multiline ? (
                            <textarea
                                ref={inputRef}
                                className="app-prompt-input"
                                rows={3}
                                placeholder={dialog.placeholder || ''}
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                            />
                        ) : (
                            <input
                                ref={inputRef}
                                type="text"
                                className="app-prompt-input"
                                placeholder={dialog.placeholder || ''}
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                            />
                        )
                    )}
                </div>
                <div style={styles.footer}>
                    {twoButton ? (
                        <>
                            <button
                                style={{ ...styles.btnBase, ...styles.btnCancel }}
                                onClick={() => handleClose(isPrompt ? null : false)}
                                onMouseEnter={(e) => {
                                    e.target.style.background = '#E5E7EB';
                                    e.target.style.transform = 'translateY(-1px)';
                                }}
                                onMouseLeave={(e) => {
                                    e.target.style.background = '#F3F4F6';
                                    e.target.style.transform = 'translateY(0)';
                                }}
                            >
                                {dialog.cancelLabel || 'Cancel'}
                            </button>
                            <button
                                ref={primaryRef}
                                style={{ ...styles.btnBase, ...styles.btnPrimary(visualType) }}
                                onClick={() => handleClose(isPrompt ? inputValue : true)}
                                onMouseEnter={(e) => {
                                    e.target.style.transform = 'translateY(-2px)';
                                    e.target.style.boxShadow = `0 6px 20px ${accentColors[visualType]}50`;
                                }}
                                onMouseLeave={(e) => {
                                    e.target.style.transform = 'translateY(0)';
                                    e.target.style.boxShadow = `0 4px 14px ${accentColors[visualType]}40`;
                                }}
                            >
                                {dialog.confirmLabel || (isPrompt ? 'OK' : 'Confirm')}
                            </button>
                        </>
                    ) : (
                        <button
                            ref={primaryRef}
                            style={{ ...styles.btnBase, ...styles.btnPrimary(visualType) }}
                            onClick={() => handleClose(undefined)}
                            onMouseEnter={(e) => {
                                e.target.style.transform = 'translateY(-2px)';
                                e.target.style.boxShadow = `0 6px 20px ${accentColors[visualType]}50`;
                            }}
                            onMouseLeave={(e) => {
                                e.target.style.transform = 'translateY(0)';
                                e.target.style.boxShadow = `0 4px 14px ${accentColors[visualType]}40`;
                            }}
                        >
                            OK
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

/* ─── Provider ─── */
export const DialogProvider = ({ children }) => {
    const [dialogs, setDialogs] = useState([]);
    const resolverMap = useRef({});
    const idCounter = useRef(0);

    const showAlert = useCallback((message, options = {}) => {
        return new Promise((resolve) => {
            const id = ++idCounter.current;
            resolverMap.current[id] = resolve;
            setDialogs((prev) => [...prev, {
                id,
                type: 'alert',
                message: String(message),
                title: options.title,
                variant: options.variant,
            }]);
        });
    }, []);

    const showConfirm = useCallback((message, options = {}) => {
        return new Promise((resolve) => {
            const id = ++idCounter.current;
            resolverMap.current[id] = resolve;
            const opts = typeof options === 'string' ? { title: options } : (options || {});
            setDialogs((prev) => [...prev, {
                id,
                type: 'confirm',
                message: String(message),
                title: opts.title || undefined,
                variant: opts.variant || 'confirm',
                confirmLabel: opts.confirmLabel || undefined,
                cancelLabel: opts.cancelLabel || undefined,
            }]);
        });
    }, []);

    // Styled replacement for window.prompt(). Resolves to the entered string on
    // OK/Enter, or null on Cancel/Escape (matching window.prompt semantics).
    const showPrompt = useCallback((message, options = {}) => {
        return new Promise((resolve) => {
            const id = ++idCounter.current;
            resolverMap.current[id] = resolve;
            const opts = typeof options === 'string' ? { defaultValue: options } : (options || {});
            setDialogs((prev) => [...prev, {
                id,
                type: 'prompt',
                message: String(message),
                title: opts.title || undefined,
                variant: opts.variant || 'confirm',
                placeholder: opts.placeholder || '',
                defaultValue: opts.defaultValue || '',
                multiline: !!opts.multiline,
                confirmLabel: opts.confirmLabel || undefined,
                cancelLabel: opts.cancelLabel || undefined,
            }]);
        });
    }, []);

    const handleClose = useCallback((id, result) => {
        const resolver = resolverMap.current[id];
        if (resolver) {
            resolver(result);
            delete resolverMap.current[id];
        }
        setDialogs((prev) => prev.filter((d) => d.id !== id));
    }, []);

    return (
        <DialogContext.Provider value={{ alert: showAlert, confirm: showConfirm, prompt: showPrompt }}>
            {children}
            {dialogs.map((dialog) => (
                <DialogBox
                    key={dialog.id}
                    dialog={dialog}
                    onClose={(result) => handleClose(dialog.id, result)}
                />
            ))}
        </DialogContext.Provider>
    );
};

export default DialogProvider;
