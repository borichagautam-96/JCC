import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// Premium logout choreography. The auth logic is untouched — this only wraps
// the existing logout() call with feedback:
//   idle -> working (progress) -> success (drawn check) -> page fade -> /login
//
// The idle face stays mounted and fades out while the state overlay is absolutely
// positioned on top, so the button's box never changes size (no layout shift).

const PROGRESS_MS = 900;
const SUCCESS_MS = 900;
const FADE_MS = 320;

const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

const LogoutButton = ({ className = '', label = 'Logout', iconSize = 16, style }) => {
    const { logout } = useAuth();
    const navigate = useNavigate();
    const [phase, setPhase] = useState('idle'); // idle | working | success

    const barRef = useRef(null);
    const rafRef = useRef(null);
    const timers = useRef([]);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            timers.current.forEach(clearTimeout);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            document.documentElement.classList.remove('is-logging-out');
        };
    }, []);

    const later = (fn, ms) => { timers.current.push(setTimeout(fn, ms)); };

    // Progress is written straight to the DOM — no re-render per frame.
    const runProgress = () => {
        const start = performance.now();
        const tick = (now) => {
            if (!alive.current) return;
            const t = Math.min(1, (now - start) / PROGRESS_MS);
            if (barRef.current) barRef.current.style.transform = `scaleX(${easeInOutQuad(t)})`;
            if (t < 1) rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
    };

    const handleClick = useCallback(() => {
        if (phase !== 'idle') return;
        setPhase('working');
        requestAnimationFrame(runProgress);

        // NOTE: logout() clears the auth state, which trips the route guard and
        // unmounts this button immediately. So it is called at the END of the
        // sequence, not the start — otherwise the animation is cut off.
        later(() => {
            if (!alive.current) return;
            setPhase('success');

            later(async () => {
                if (!alive.current) return;

                const root = document.documentElement;
                root.classList.add('is-logging-out');
                // Safety net: this fires regardless of unmount/errors, so the
                // fade can never strand the app at opacity 0.
                setTimeout(() => root.classList.remove('is-logging-out'), 1500);

                try {
                    await logout();
                } catch (err) {
                    console.error('Logout error:', err);
                } finally {
                    navigate('/login', { replace: true });
                    requestAnimationFrame(() => root.classList.remove('is-logging-out'));
                }
            }, SUCCESS_MS);
        }, PROGRESS_MS);
    }, [phase, logout, navigate]);

    const busy = phase !== 'idle';

    return (
        <button
            type="button"
            onClick={handleClick}
            disabled={busy}
            aria-busy={busy}
            style={style}
            className={`logout-btn ${className}${busy ? ' is-busy' : ''}${phase === 'success' ? ' is-success' : ''}`}
        >
            <span className={`logout-face${busy ? ' is-hidden' : ''}`}>
                <LogOut size={iconSize} className="logout-icon" />
                <span>{label}</span>
            </span>

            {phase === 'working' && (
                <span className="logout-state">🚪 Logging Out…</span>
            )}

            {phase === 'success' && (
                <span className="logout-state">
                    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                        <path
                            className="logout-check"
                            d="M4 12.5l5 5L20 6.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                    Logged Out Successfully
                </span>
            )}

            {phase === 'working' && (
                <span className="logout-progress" aria-hidden="true">
                    <span className="logout-progress-fill" ref={barRef} />
                </span>
            )}
        </button>
    );
};

export default LogoutButton;
