import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';

const LoginPage = () => {
    const [formData, setFormData] = useState({
        psNumber: '',
        password: '',
    });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [shakeKey, setShakeKey] = useState(0); // remount error box to replay shake
    const [capsLockOn, setCapsLockOn] = useState(false);
    const [verified, setVerified] = useState(false); // brief "✓ Verified" state before navigating
    const [leaving, setLeaving] = useState(false);    // card fade-out on success

    // Detect Caps Lock from keyboard events on the password field
    const handleCapsLock = (e) => {
        if (typeof e.getModifierState === 'function') {
            setCapsLockOn(e.getModifierState('CapsLock'));
        }
    };

    // ── 3D tilt: the card leans toward the cursor with real perspective ──
    const cardRef = useRef(null);
    const shellRef = useRef(null);
    const [tilt, setTilt] = useState({ rx: 0, ry: 0, gx: 50, gy: 0, active: false });

    // Background parallax: ambient orbs / aurora drift with the cursor (set CSS
    // vars imperatively to avoid re-rendering on every mouse move).
    const handleShellMove = (e) => {
        const el = shellRef.current;
        if (!el) return;
        el.style.setProperty('--mx', (e.clientX / window.innerWidth - 0.5).toFixed(3));
        el.style.setProperty('--my', (e.clientY / window.innerHeight - 0.5).toFixed(3));
    };

    const handleTiltMove = (e) => {
        const el = cardRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width;   // 0..1
        const py = (e.clientY - rect.top) / rect.height;   // 0..1
        const MAX = 9; // degrees
        setTilt({
            ry: (px - 0.5) * 2 * MAX,       // rotateY: left/right
            rx: -(py - 0.5) * 2 * MAX,      // rotateX: up/down
            gx: px * 100,                   // glare X %
            gy: py * 100,                   // glare Y %
            active: true,
        });
    };
    const handleTiltLeave = () => setTilt({ rx: 0, ry: 0, gx: 50, gy: 0, active: false });

    // Authentication progress messaging while the request is in flight.
    const AUTH_STEPS = ['Authenticating', 'Checking Credentials', 'Preparing Workspace', 'Loading Dashboard'];
    const [authStep, setAuthStep] = useState(0);
    const [shaking, setShaking] = useState(false);

    useEffect(() => {
        if (!loading) { setAuthStep(0); return undefined; }
        const id = setInterval(
            () => setAuthStep((s) => Math.min(s + 1, AUTH_STEPS.length - 1)),
            620,
        );
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading]);

    const { login } = useAuth();
    const navigate = useNavigate();
    const { isDark } = useTheme();
    const loginThemeRaw = String(import.meta.env.VITE_LOGIN_THEME || 'corporate').toLowerCase();
    const configuredTheme = ['corporate', 'dark', 'colorful'].includes(loginThemeRaw) ? loginThemeRaw : 'corporate';
    // In dark mode use the login page's own dark treatment; otherwise honour
    // whatever VITE_LOGIN_THEME is configured to.
    const loginTheme = isDark ? 'dark' : configuredTheme;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const user = await login(formData.psNumber, formData.password);
            const dest = user.requiresProfileCompletion ? '/complete-profile' : '/hub';

            // Success choreography: spinner → ✓ Verified → card fades out → navigate.
            setLoading(false);
            setVerified(true);
            setTimeout(() => setLeaving(true), 450);
            setTimeout(() => navigate(dest), 700);
        } catch (err) {
            setError(err.message);
            setShakeKey((k) => k + 1); // replay the shake animation
            setLoading(false);
            setShaking(true);
            setTimeout(() => setShaking(false), 520);
        }
    };

    const handleChange = (e) => {
        // Clear the error as soon as the user starts correcting their input.
        if (error) setError('');
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    return (
        <div className={`jcc-login-shell jcc-login-theme-${loginTheme}${leaving ? ' is-leaving' : ''}`} ref={shellRef} onMouseMove={handleShellMove}>
            <div className="jcc-login-animated-bg" aria-hidden="true"></div>
            <div className="jcc-login-aurora" aria-hidden="true"></div>
            <div className="jcc-login-ambient jcc-login-ambient-one" aria-hidden="true"></div>
            <div className="jcc-login-ambient jcc-login-ambient-two" aria-hidden="true"></div>
            <div className="jcc-login-grid" aria-hidden="true"></div>

            <div className={`jcc-login-main jcc-login-3d-stage${shaking ? ' is-shaking' : ''}`}>
                <div
                    ref={cardRef}
                    className={`jcc-login-card jcc-login-card-3d${tilt.active ? ' is-tilting' : ''}${leaving ? ' is-leaving' : ''}${error ? ' has-error' : ''}`}
                    onMouseMove={handleTiltMove}
                    onMouseLeave={handleTiltLeave}
                    style={{ '--rx': `${tilt.rx}deg`, '--ry': `${tilt.ry}deg`, '--gx': `${tilt.gx}%`, '--gy': `${tilt.gy}%` }}
                >
                    <div className="jcc-login-glare" aria-hidden="true"></div>
                    <div className="text-center mb-xl jcc-login-layer jcc-login-layer-front">
                        <div className="jcc-login-mark">
                            <img src="/infloai-mark.svg" alt="InFloAI logo" className="jcc-login-logo-img" />
                        </div>
                        <h1 className="jcc-login-title">
                            InFloAI
                        </h1>
                        <p className="jcc-login-subtitle">Sign in with username or PS Number</p>
                    </div>

                    {error && (
                        <div className="jcc-login-error" key={shakeKey}>
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="jcc-login-layer jcc-login-layer-mid">
                        <div className="input-group">
                            <label className="jcc-login-label" htmlFor="jcc-ps-number">
                                Username / PS Number *
                            </label>
                            <div className="jcc-login-input-wrap">
                                <input
                                    id="jcc-ps-number"
                                    type="text"
                                    name="psNumber"
                                    className="input-field jcc-login-input"
                                    placeholder="Enter username or PS Number"
                                    value={formData.psNumber}
                                    onChange={handleChange}
                                    disabled={loading || verified}
                                    required
                                />
                            </div>
                        </div>

                        <div className="input-group">
                            <label className="jcc-login-label" htmlFor="jcc-password">
                                Password *
                            </label>
                            <div className="jcc-login-input-wrap" style={{ position: 'relative' }}>
                                <input
                                    id="jcc-password"
                                    type={showPassword ? 'text' : 'password'}
                                    name="password"
                                    className="input-field jcc-login-input"
                                    style={{ paddingRight: '3rem' }}
                                    placeholder="••••••••"
                                    value={formData.password}
                                    onChange={handleChange}
                                    onKeyDown={handleCapsLock}
                                    onKeyUp={handleCapsLock}
                                    onBlur={() => setCapsLockOn(false)}
                                    disabled={loading || verified}
                                    required
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className={`jcc-login-eye-btn${showPassword ? ' is-on' : ''}`}
                                    tabIndex={-1}
                                    title={showPassword ? 'Hide password' : 'Show password'}
                                >
                                    {showPassword ? (
                                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                                            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                                            <line x1="1" y1="1" x2="23" y2="23"/>
                                        </svg>
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                            <circle cx="12" cy="12" r="3"/>
                                        </svg>
                                    )}
                                </button>
                            </div>
                            {capsLockOn && (
                                <div className="jcc-login-caps-warning" role="alert">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                                        <line x1="12" y1="9" x2="12" y2="13"/>
                                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                                    </svg>
                                    Caps Lock is on
                                </div>
                            )}
                        </div>

                        <div className="jcc-login-helper-row">
                            <span>Secure enterprise login</span>
                        </div>

                        <button
                            type="submit"
                            className={`jcc-login-submit${verified ? ' is-verified' : ''}`}
                            disabled={loading || verified}
                        >
                            {verified ? (
                                <span className="jcc-login-success">
                                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                                        <path
                                            className="jcc-login-check"
                                            d="M4 12.5l5 5L20 6.5"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2.8"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                    Verified
                                </span>
                            ) : loading ? (
                                <span className="jcc-login-auth">
                                    <span key={authStep} className="jcc-login-auth-label">
                                        {AUTH_STEPS[authStep]}…
                                    </span>
                                    <span className="jcc-login-auth-bar" aria-hidden="true">
                                        <span className="jcc-login-auth-fill" />
                                    </span>
                                </span>
                            ) : (
                                'Sign In'
                            )}
                        </button>
                    </form>
                </div>
            </div>

        </div>
    );
};

export default LoginPage;
