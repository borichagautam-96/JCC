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

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            // Login with PS number (sent as email to backend for compatibility)
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
        <div style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            background: '#F5F5F5'
        }}>
            {/* Main content - centered login form */}
            <div className="flex items-center justify-center" style={{ flex: 1, padding: 'var(--spacing-lg)' }}>
                <div style={{ maxWidth: '450px', width: '100%', background: 'white', borderRadius: 'var(--radius-lg)', padding: 'var(--spacing-2xl)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                    <div className="text-center mb-xl">
                        <h1 style={{
                            color: '#0066CC',
                            marginBottom: 'var(--spacing-sm)',
                            fontSize: '2rem'
                        }}>
                            C2C
                        </h1>
                        <p style={{ color: '#666', fontSize: '0.95rem' }}>Login with your PS Number and Password</p>
                    </div>

                    {error && (
                        <div style={{
                            padding: '1rem',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid #EF4444',
                            borderRadius: 'var(--radius-md)',
                            marginBottom: 'var(--spacing-lg)',
                            color: '#EF4444'
                        }}>
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit}>
                        <div className="input-group">
                            <label style={{ display: 'block', marginBottom: 'var(--spacing-sm)', color: '#0066CC', fontWeight: 500, fontSize: '0.875rem' }}>
                                PS Number *
                            </label>
                            <input
                                type="text"
                                name="psNumber"
                                style={{
                                    width: '100%',
                                    padding: '0.75rem 1rem',
                                    background: 'white',
                                    border: '1px solid #CCCCCC',
                                    borderRadius: 'var(--radius-md)',
                                    color: '#333333',
                                    fontSize: '1rem'
                                }}
                                placeholder="Enter your PS Number"
                                value={formData.psNumber}
                                onChange={handleChange}
                                required
                            />
                        </div>

                        <div className="input-group">
                            <label style={{ display: 'block', marginBottom: 'var(--spacing-sm)', color: '#0066CC', fontWeight: 500, fontSize: '0.875rem' }}>
                                Password *
                            </label>
                            <div style={{ position: 'relative' }}>
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    name="password"
                                    style={{
                                        width: '100%',
                                        padding: '0.75rem 3rem 0.75rem 1rem',
                                        background: 'white',
                                        border: '1px solid #CCCCCC',
                                        borderRadius: 'var(--radius-md)',
                                        color: '#333333',
                                        fontSize: '1rem',
                                        boxSizing: 'border-box'
                                    }}
                                    placeholder="••••••••"
                                    value={formData.password}
                                    onChange={handleChange}
                                    required
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    style={{
                                        position: 'absolute',
                                        right: '0.75rem',
                                        top: '50%',
                                        transform: 'translateY(-50%)',
                                        background: 'none',
                                        border: 'none',
                                        cursor: 'pointer',
                                        color: '#888',
                                        padding: '0',
                                        display: 'flex',
                                        alignItems: 'center'
                                    }}
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

                        <button
                            type="submit"
                            style={{
                                width: '100%',
                                marginTop: 'var(--spacing-md)',
                                padding: '0.875rem',
                                background: '#0078D4',
                                color: 'white',
                                border: 'none',
                                borderRadius: 'var(--radius-md)',
                                fontSize: '1rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                transition: 'background 0.2s'
                            }}
                            disabled={loading}
                            onMouseOver={(e) => e.target.style.background = '#0066CC'}
                            onMouseOut={(e) => e.target.style.background = '#0078D4'}
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

            {/* Footer */}
            <footer style={{
                padding: '1rem 2rem',
                background: 'rgba(255,255,255,0.95)',
                borderTop: '1px solid #E0E0E0',
                textAlign: 'center'
            }}>
                <p style={{
                    margin: 0,
                    fontSize: '0.875rem',
                    color: '#64748b',
                    fontWeight: '500',
                    letterSpacing: '0.025em'
                }}>
                    <span style={{ color: '#94a3b8' }}>©</span>{' '}
                    <span style={{
                        color: '#0066CC',
                        fontWeight: '600'
                    }}>
                        Developed by Development Team
                    </span>
                </p>
            </footer>
        </div>
    );
};

export default LoginPage;
