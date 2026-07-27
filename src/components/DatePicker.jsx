import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    addDays, addMonths, subMonths, endOfMonth, endOfWeek, format, isSameDay,
    isSameMonth, isToday, parseISO, startOfMonth, startOfWeek,
} from 'date-fns';

// Premium date picker — a drop-in replacement for <input type="date">.
//
// Emits the same event shape a native date input does:
//   onChange({ target: { name, value: 'yyyy-MM-dd' } })
// and reads a 'yyyy-MM-dd' string value, so existing handleChange handlers,
// formData, and validation stay completely untouched.
//
// The native calendar popup can't be styled or animated; this renders its own,
// which is the only way to get the sliding months / animated cells / hover
// states the design calls for.

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const ISO = 'yyyy-MM-dd';

const toDate = (v) => {
    if (!v) return null;
    try { const d = parseISO(v); return Number.isNaN(d.getTime()) ? null : d; } catch { return null; }
};

const DatePicker = ({
    name,
    value,
    onChange,
    min,
    max,
    disabled = false,
    required = false,
    id,
    className = '',
    placeholder = 'Select date',
}) => {
    const selected = useMemo(() => toDate(value), [value]);
    const minDate = useMemo(() => toDate(min), [min]);
    const maxDate = useMemo(() => toDate(max), [max]);

    const [open, setOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const [viewMonth, setViewMonth] = useState(() => startOfMonth(selected || new Date()));
    const [focusDate, setFocusDate] = useState(() => selected || new Date());
    const [slideDir, setSlideDir] = useState(null); // 'left' | 'right'

    const rootRef = useRef(null);
    const btnRef = useRef(null);
    const popRef = useRef(null);
    const gridRef = useRef(null);
    const closeTimer = useRef(null);
    const [coords, setCoords] = useState({ top: 0, left: 0, openUp: false });

    useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

    // Position the (portaled, fixed) popup relative to the trigger, flipping up
    // or right-aligning when it would overflow the viewport. Fixed positioning
    // means no ancestor's overflow can ever clip it.
    const POP_W = 268;
    const POP_H = 320;
    const reposition = useCallback(() => {
        const r = btnRef.current?.getBoundingClientRect();
        if (!r) return;
        const vw = window.innerWidth, vh = window.innerHeight;
        const openUp = r.bottom + 8 + POP_H > vh && r.top - 8 - POP_H > 0;
        let left = r.left;
        if (left + POP_W > vw - 8) left = Math.max(8, r.right - POP_W);
        const top = openUp ? r.top - 8 - POP_H : r.bottom + 8;
        setCoords({ top, left, openUp });
    }, []);

    // Keep the visible month in sync when the value changes from outside.
    useEffect(() => {
        if (selected) { setViewMonth(startOfMonth(selected)); setFocusDate(selected); }
    }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

    const isDisabled = useCallback((d) => {
        if (minDate && d < startOfDayLocal(minDate)) return true;
        if (maxDate && d > d23(maxDate)) return true;
        return false;
    }, [minDate, maxDate]);

    const closePopup = useCallback(() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        setClosing(true);
        closeTimer.current = setTimeout(() => { setOpen(false); setClosing(false); }, 160);
    }, []);

    const openPopup = useCallback(() => {
        if (disabled) return;
        setViewMonth(startOfMonth(selected || new Date()));
        setFocusDate(selected || new Date());
        setSlideDir(null);
        reposition();
        setOpen(true);
    }, [disabled, selected, reposition]);

    // Close on outside click (checks both the trigger root and the portaled popup).
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (rootRef.current?.contains(e.target)) return;
            if (popRef.current?.contains(e.target)) return;
            closePopup();
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open, closePopup]);

    // Keep it anchored while the page scrolls or resizes.
    useEffect(() => {
        if (!open) return undefined;
        const onMove = () => reposition();
        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        return () => {
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
        };
    }, [open, reposition]);

    // Move focus to the grid once it opens (keyboard nav).
    useEffect(() => {
        if (open && !closing && gridRef.current) {
            const el = gridRef.current.querySelector('[data-focused="true"]');
            if (el) el.focus();
        }
    }, [open, closing, focusDate]);

    const commit = useCallback((d) => {
        onChange?.({ target: { name, value: format(d, ISO) } });
        closePopup();
    }, [onChange, name, closePopup]);

    const goMonth = useCallback((dir) => {
        setSlideDir(dir === 'next' ? 'left' : 'right');
        setViewMonth((m) => (dir === 'next' ? addMonths(m, 1) : subMonths(m, 1)));
    }, []);

    // 6 full weeks so the grid height never changes between months.
    const days = useMemo(() => {
        const start = startOfWeek(startOfMonth(viewMonth), { weekStartsOn: 0 });
        return Array.from({ length: 42 }, (_, i) => addDays(start, i));
    }, [viewMonth]);

    const onGridKeyDown = (e) => {
        let next = focusDate;
        switch (e.key) {
            case 'ArrowLeft':  next = addDays(focusDate, -1); break;
            case 'ArrowRight': next = addDays(focusDate, 1); break;
            case 'ArrowUp':    next = addDays(focusDate, -7); break;
            case 'ArrowDown':  next = addDays(focusDate, 7); break;
            case 'PageUp':     next = subMonths(focusDate, 1); break;
            case 'PageDown':   next = addMonths(focusDate, 1); break;
            case 'Home':       next = startOfWeek(focusDate, { weekStartsOn: 0 }); break;
            case 'End':        next = endOfWeek(focusDate, { weekStartsOn: 0 }); break;
            case 'Enter':
            case ' ':          e.preventDefault(); if (!isDisabled(focusDate)) commit(focusDate); return;
            case 'Escape':     e.preventDefault(); closePopup(); return;
            default: return;
        }
        e.preventDefault();
        if (!isSameMonth(next, viewMonth)) setSlideDir(next > focusDate ? 'left' : 'right');
        setFocusDate(next);
        setViewMonth(startOfMonth(next));
    };

    const displayText = selected ? format(selected, 'dd MMM yyyy') : '';

    return (
        <div className={`dp-root ${className}`} ref={rootRef}>
            <button
                type="button"
                id={id}
                ref={btnRef}
                className={`dp-input${open ? ' is-open' : ''}${!displayText ? ' is-empty' : ''}`}
                onClick={() => (open ? closePopup() : openPopup())}
                disabled={disabled}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={displayText ? `Selected date ${displayText}. Change date` : placeholder}
            >
                <span className="dp-input-text">{displayText || placeholder}</span>
                <svg className="dp-cal-icon" viewBox="0 0 24 24" width="18" height="18" fill="none"
                     stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4.5" width="18" height="17" rx="2.5" />
                    <path d="M3 9h18M8 2.5v4M16 2.5v4" />
                </svg>
            </button>
            {/* keep a hidden required mirror so native form validation still works */}
            {required && (
                <input
                    tabIndex={-1}
                    aria-hidden="true"
                    className="dp-required-mirror"
                    required
                    value={value || ''}
                    onChange={() => {}}
                />
            )}

            {open && createPortal((
                <div
                    ref={popRef}
                    className={`dp-pop${closing ? ' is-closing' : ''}${coords.openUp ? ' dp-up' : ''}`}
                    role="dialog"
                    aria-modal="false"
                    aria-label="Choose date"
                    style={{ position: 'fixed', top: `${coords.top}px`, left: `${coords.left}px` }}
                >
                    <div className="dp-head">
                        <button type="button" className="dp-nav" onClick={() => goMonth('prev')} aria-label="Previous month">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                        </button>
                        <div className="dp-title" aria-live="polite">{format(viewMonth, 'MMMM yyyy')}</div>
                        <button type="button" className="dp-nav" onClick={() => goMonth('next')} aria-label="Next month">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                        </button>
                    </div>

                    <div className="dp-weekdays" aria-hidden="true">
                        {WEEKDAYS.map((w) => <span key={w} className="dp-weekday">{w}</span>)}
                    </div>

                    <div
                        className={`dp-grid${slideDir ? ` dp-slide-${slideDir}` : ''}`}
                        role="grid"
                        ref={gridRef}
                        onKeyDown={onGridKeyDown}
                        key={format(viewMonth, 'yyyy-MM')}
                    >
                        {days.map((d) => {
                            const out = !isSameMonth(d, viewMonth);
                            const dis = isDisabled(d);
                            const sel = selected && isSameDay(d, selected);
                            const today = isToday(d);
                            const foc = isSameDay(d, focusDate);
                            return (
                                <button
                                    key={d.toISOString()}
                                    type="button"
                                    role="gridcell"
                                    tabIndex={foc ? 0 : -1}
                                    data-focused={foc ? 'true' : undefined}
                                    aria-selected={sel ? 'true' : 'false'}
                                    aria-disabled={dis ? 'true' : undefined}
                                    aria-label={format(d, 'EEEE, d MMMM yyyy')}
                                    disabled={dis}
                                    className={[
                                        'dp-day',
                                        out ? 'is-out' : '',
                                        dis ? 'is-disabled' : '',
                                        sel ? 'is-selected' : '',
                                        today ? 'is-today' : '',
                                    ].filter(Boolean).join(' ')}
                                    onClick={() => !dis && commit(d)}
                                    onMouseEnter={() => setFocusDate(d)}
                                >
                                    <span className="dp-day-num">{format(d, 'd')}</span>
                                </button>
                            );
                        })}
                    </div>

                    <div className="dp-foot">
                        <button
                            type="button"
                            className="dp-foot-btn"
                            onClick={() => { const t = new Date(); if (!isDisabled(t)) commit(t); }}
                        >
                            Today
                        </button>
                        <button
                            type="button"
                            className="dp-foot-btn dp-foot-clear"
                            onClick={() => { onChange?.({ target: { name, value: '' } }); closePopup(); }}
                        >
                            Clear
                        </button>
                    </div>
                </div>
            ), document.body)}
        </div>
    );
};

// min/max are date-only; compare against the day's boundaries.
function startOfDayLocal(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function d23(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

export default DatePicker;
