import React, { useCallback, useEffect, useRef, useState } from 'react';

// Premium animated download button.
//
// The button itself is never redesigned — it renders whatever children/className
// the caller passes and keeps its exact box. The whole animation (arrow launch,
// parachute descent, progress meter, success check) is drawn in a fixed-position
// overlay anchored to the button's rect, so it escapes `overflow:hidden` ancestors
// (e.g. table shells) and can never reflow the page.
//
// Timeline: launch → parachute descent (synced to 0→100%) → landing bounce → ✓.

const LAUNCH_MS = 340;    // anticipation dip + upward launch
const DESCENT_MS = 2000;  // parachute descent, locked to the progress readout
const LAND_MS = 280;      // bounce + parachute fold
const SUCCESS_MS = 1500;  // hold the ✓ state
const RISE_PX = 80;

// Gentle accel→decel. Gives a parachute's terminal-velocity feel and makes the
// readout ramp the way the reference does (5 → 12 → 24 → … → 91 → 100).
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

const DownloadButton = ({
    onDownload,
    className = '',
    children = 'Download PDF',
    successLabel = 'Download Complete',
    title,
    disabled = false,
}) => {
    const [phase, setPhase] = useState('idle'); // idle | launch | descend | land | success
    const [anchor, setAnchor] = useState(null);

    const btnRef = useRef(null);
    const flyerRef = useRef(null);
    const fillRef = useRef(null);
    const pctRef = useRef(null);
    const rafRef = useRef(null);
    const timersRef = useRef([]);
    const aliveRef = useRef(true);

    // NOTE: must re-arm on mount. StrictMode (dev) runs mount → cleanup → mount,
    // so setting this only in the cleanup would leave it false forever and every
    // queued phase callback would bail out mid-animation.
    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
            timersRef.current.forEach(clearTimeout);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    const later = (fn, ms) => { timersRef.current.push(setTimeout(fn, ms)); };

    const reset = useCallback(() => {
        setPhase('idle');
        setAnchor(null);
    }, []);

    // Descent + progress are driven from one clock, so the arrow lands exactly at 100%.
    // Writes straight to the DOM — no React re-render per frame.
    const runDescent = useCallback(() => {
        const start = performance.now();
        const tick = (now) => {
            if (!aliveRef.current) return;
            const t = Math.min(1, (now - start) / DESCENT_MS);
            const e = easeInOutSine(t);
            if (flyerRef.current) {
                flyerRef.current.style.transform = `translateY(${(-RISE_PX * (1 - e)).toFixed(2)}px)`;
            }
            if (fillRef.current) fillRef.current.style.width = `${(e * 100).toFixed(2)}%`;
            if (pctRef.current) pctRef.current.textContent = `${Math.round(e * 100)}%`;
            if (t < 1) rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
    }, []);

    const handleClick = useCallback(() => {
        if (phase !== 'idle' || disabled) return;

        timersRef.current = []; // previous run has fully drained; start clean
        const r = btnRef.current?.getBoundingClientRect();
        if (r) setAnchor({ cx: r.left + r.width / 2, top: r.top, height: r.height });
        setPhase('launch');

        // Kick the real download off immediately so network time overlaps the
        // animation instead of stacking after it.
        const work = Promise.resolve()
            .then(() => onDownload?.())
            .catch((err) => {
                console.error('Download failed:', err);
                return false;
            });

        later(() => {
            if (!aliveRef.current) return;
            setPhase('descend');
            runDescent();
        }, LAUNCH_MS);

        later(() => {
            if (aliveRef.current) setPhase('land');
        }, LAUNCH_MS + DESCENT_MS);

        later(async () => {
            if (!aliveRef.current) return;
            const ok = await work; // only claim success once the file is actually ready
            if (!aliveRef.current) return;
            if (ok === false) { reset(); return; } // caller surfaces its own error dialog
            setPhase('success');
            later(() => { if (aliveRef.current) reset(); }, SUCCESS_MS);
        }, LAUNCH_MS + DESCENT_MS + LAND_MS);
    }, [phase, disabled, onDownload, runDescent, reset]);

    const busy = phase !== 'idle';

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                onClick={handleClick}
                disabled={disabled || busy}
                title={title}
                aria-busy={busy}
                className={`dl-btn ${className}${busy ? ' is-busy' : ''}`}
            >
                {children}
            </button>

            {anchor && busy && (
                <div
                    className={`dl-stage dl-${phase}`}
                    style={{ left: `${anchor.cx}px`, top: `${anchor.top}px`, '--dl-h': `${anchor.height}px` }}
                    aria-hidden="true"
                >
                    <div className="dl-flyer" ref={flyerRef}>
                        <div className="dl-sway">
                            <svg className="dl-chute" viewBox="0 0 40 27" width="38" height="26">
                                <path d="M2 19 A18 18 0 0 1 38 19" fill="#DBEAFE" stroke="#3B82F6" strokeWidth="2" strokeLinejoin="round" />
                                <path d="M2 19 L20 26 M20 19 L20 26 M38 19 L20 26" stroke="#3B82F6" strokeWidth="1.3" fill="none" strokeLinecap="round" />
                            </svg>
                            <svg className="dl-arrow" viewBox="0 0 24 24" width="18" height="18">
                                <path d="M12 4v11" stroke="#2563EB" strokeWidth="2.4" strokeLinecap="round" />
                                <path d="M6.5 11.5L12 17l5.5-5.5" stroke="#2563EB" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                            </svg>
                        </div>
                    </div>

                    <div className="dl-meter">
                        <div className="dl-track"><div className="dl-fill" ref={fillRef} /></div>
                        <span className="dl-pct" ref={pctRef}>0%</span>
                    </div>

                    {phase === 'success' && (
                        <div className="dl-done">
                            <svg viewBox="0 0 24 24" width="15" height="15">
                                <path className="dl-check" d="M4 12.5l5 5L20 6.5" fill="none" stroke="#16A34A" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span>{successLabel}</span>
                        </div>
                    )}
                </div>
            )}
        </>
    );
};

export default DownloadButton;
