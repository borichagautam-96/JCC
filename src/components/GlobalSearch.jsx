import React, { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth, getDeviceId } from '../contexts/AuthContext';

// Global search: type a JCC number, vendor, or invoice number and jump to it.
// Lives in the app header so it is available on every authenticated page.
const statusLabel = (s) => {
    const map = {
        pending_approval_1: 'Pending L1',
        pending_approval_2: 'Pending L2',
        approved: 'Approved',
        rejected: 'Rejected',
        processed: 'Processed',
    };
    return map[s] || s || '';
};

const GlobalSearch = () => {
    const { getToken } = useAuth();
    const navigate = useNavigate();
    const [q, setQ] = useState('');
    const [results, setResults] = useState([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [hover, setHover] = useState(false);
    const [focused, setFocused] = useState(false);
    const debounceRef = useRef(null);
    const boxRef = useRef(null);

    // Expanded whenever the field is hovered, focused, or holds a query.
    const hasText = q.length > 0;
    const boxClass = `global-search-box${focused ? ' is-focus' : hover ? ' is-hover' : hasText ? ' has-text' : ''}`;
    const placeholder = (hover || focused)
        ? 'Search invoices, PO, Vendor, Claims…'
        : 'Search';

    useEffect(() => {
        const onClickOutside = (e) => {
            if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, []);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const term = q.trim();
        if (term.length < 2) {
            setResults([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        debounceRef.current = setTimeout(async () => {
            try {
                const res = await fetch(`/api/jcc/search?q=${encodeURIComponent(term)}`, {
                    headers: { Authorization: `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() },
                });
                if (res.ok) {
                    const data = await res.json();
                    setResults(Array.isArray(data.results) ? data.results : []);
                    setOpen(true);
                }
            } catch (err) {
                console.warn('Global search failed:', err);
            } finally {
                setLoading(false);
            }
        }, 300);
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [q]);

    const goTo = (r) => {
        setOpen(false);
        setQ('');
        setResults([]);
        navigate(`/voucher-history?q=${encodeURIComponent(r.jccNumber || r.invoiceNumber || '')}`);
    };

    return (
        <div
            ref={boxRef}
            className="global-search"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
        >
            <div className={boxClass}>
                <Search size={15} className="global-search-icon" color={hover || focused ? '#3b82f6' : '#94A3B8'} />
                <input
                    className="global-search-input"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onFocus={() => { setFocused(true); if (results.length) setOpen(true); }}
                    onBlur={() => setFocused(false)}
                    placeholder={placeholder}
                />
            </div>

            {open && (q.trim().length >= 2) && (
                <div style={{ position: 'absolute', top: '42px', right: 0, width: '340px', maxHeight: '360px', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', boxShadow: '0 10px 30px rgba(0,0,0,0.12)', zIndex: 50 }}>
                    {loading && <div style={{ padding: '12px', fontSize: '0.85rem', color: 'var(--text-faint)' }}>Searching…</div>}
                    {!loading && results.length === 0 && (
                        <div style={{ padding: '12px', fontSize: '0.85rem', color: 'var(--text-faint)' }}>No matches found.</div>
                    )}
                    {!loading && results.map((r) => (
                        <button
                            key={r.id}
                            onClick={() => goTo(r)}
                            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--surface-3)', background: 'var(--surface)', cursor: 'pointer' }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                                <strong style={{ color: '#0066CC', fontSize: '0.85rem' }}>{r.jccNumber}</strong>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{statusLabel(r.status)}</span>
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-body)' }}>{r.supplier || '—'}</div>
                            <div style={{ fontSize: '0.74rem', color: 'var(--text-faint)' }}>
                                Inv: {r.invoiceNumber || '—'} · ₹{Number.parseFloat(r.basicAmount || 0).toLocaleString()}
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

export default GlobalSearch;
