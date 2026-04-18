import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const LoginPage = () => {
    const [formData, setFormData] = useState({
        psNumber: '',
        password: '',
    });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

    const { login } = useAuth();
    const navigate = useNavigate();
    const loginThemeRaw = String(import.meta.env.VITE_LOGIN_THEME || 'corporate').toLowerCase();
    const loginTheme = ['corporate', 'dark', 'colorful'].includes(loginThemeRaw) ? loginThemeRaw : 'corporate';

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const user = await login(formData.psNumber, formData.password);

            // Check if password change is required
            if (user.requiresPasswordChange) {
                navigate('/change-password');
                return;
            }

            navigate('/');
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleChange = (e) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    return (
        <div className={`jcc-login-shell jcc-login-theme-${loginTheme}`}>
            <div className="jcc-login-ambient jcc-login-ambient-one" aria-hidden="true"></div>
            <div className="jcc-login-ambient jcc-login-ambient-two" aria-hidden="true"></div>
            <div className="jcc-login-grid" aria-hidden="true"></div>

            <div className="jcc-login-main">
                <div className="jcc-login-card">
                    <div className="text-center mb-xl">
                        <div className="jcc-login-mark">
                            <img src="/infloai-mark.svg" alt="InFloAI logo" className="jcc-login-logo-img" />
                        </div>
                        <h1 className="jcc-login-title">
                            InFloAI
                        </h1>
                        <p className="jcc-login-subtitle">Sign in with username or PS Number</p>
                    </div>

                    {error && (
                        <div className="jcc-login-error">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit}>
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
                                    required
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="jcc-login-eye-btn"
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
                        </div>

                        <div className="jcc-login-helper-row">
                            <span>Secure enterprise login</span>
                        </div>

                        <button
                            type="submit"
                            className="jcc-login-submit"
                            disabled={loading}
                        >
                            {loading ? (
                                <div className="flex items-center justify-center gap-sm">
                                    <div className="spinner" style={{ width: '20px', height: '20px', borderWidth: '2px', borderColor: 'white', borderTopColor: 'transparent' }}></div>
                                    <span>Authenticating...</span>
                                </div>
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
