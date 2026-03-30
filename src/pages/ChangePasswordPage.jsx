import React, { useState } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';

const ChangePasswordPage = () => {
    const { getToken, user } = useAuth();
    const isAdmin = user?.role === 'admin';

    const [formData, setFormData] = useState({
        psNumber: '',  // For admin mode
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
    });
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [loading, setLoading] = useState(false);
    const [showCurrentPw, setShowCurrentPw] = useState(false);
    const [showNewPw, setShowNewPw] = useState(false);
    const [showConfirmPw, setShowConfirmPw] = useState(false);

    const EyeIcon = ({ show, onToggle }) => (
        <button
            type="button"
            onClick={onToggle}
            tabIndex={-1}
            title={show ? 'Hide password' : 'Show password'}
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
        >
            {show ? (
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
    );

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        // Validation
        if (formData.newPassword !== formData.confirmPassword) {
            setError('New passwords do not match');
            return;
        }

        if (formData.newPassword.length < 6) {
            setError('New password must be at least 6 characters');
            return;
        }

        // Admin mode requires PS number
        if (isAdmin && !formData.psNumber) {
            setError('Please enter the user\'s PS number');
            return;
        }

        // Non-admin mode requires current password
        if (!isAdmin && !formData.currentPassword) {
            setError('Current password is required');
            return;
        }

        setLoading(true);

        try {
            const endpoint = isAdmin ? '/api/users/admin-reset-password' : '/api/users/change-password';
            const payload = isAdmin
                ? {
                    psNumber: formData.psNumber,
                    newPassword: formData.newPassword
                }
                : {
                    currentPassword: formData.currentPassword,
                    newPassword: formData.newPassword
                };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to change password');
            }

            setSuccess(isAdmin
                ? `Password reset successfully for user ${formData.psNumber}!`
                : 'Password changed successfully!');
            setFormData({
                psNumber: '',
                currentPassword: '',
                newPassword: '',
                confirmPassword: ''
            });

            // For non-admin, clear the must_change_password flag and redirect
            if (!isAdmin) {
                // Clear the flag from localStorage
                localStorage.removeItem('must_change_password');

                // Show success message briefly, then redirect to home
                setTimeout(() => {
                    window.location.href = '/';
                }, 1500);
            }

        } catch (error) {
            setError(error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fade-in" style={{ padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{
                background: '#fff',
                color: 'white',
                padding: '1.5rem 2rem',
                borderRadius: '0.9rem',
                marginBottom: '2rem',
                border: '1px solid #e2e8f0',
                // display: 'flex',
                // justifyContent: 'space-between',
                // alignItems: 'center',
                // gap: '1rem',
                // marginBottom: '1.5rem',
                // padding: '1rem 1.25rem',
                // background: '#fff',
                // border: '1px solid #e2e8f0',
                // borderRadius: '0.9rem',
                // boxShadow: '0 1px 2px rgba(15, 23, 42, 0.05)'
            }}>
                <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'black' }}>Change Password</h1>
                <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, color: 'black' }}>
                    Update your account password
                </p>
            </div>

            {/* Messages */}
            {error && (
                <div style={{
                    padding: '1rem',
                    background: '#FEE2E2',
                    color: '#991B1B',
                    borderRadius: '6px',
                    marginBottom: '1rem',
                    border: '1px solid #FCA5A5'
                }}>
                    ⚠️ {error}
                </div>
            )}

            {success && (
                <div style={{
                    padding: '1rem',
                    background: '#D1FAE5',
                    color: '#065F46',
                    borderRadius: '6px',
                    marginBottom: '1rem',
                    border: '1px solid #6EE7B7'
                }}>
                    ✓ {success}
                </div>
            )}

            {/* Form */}
            <div style={{
                background: 'white',
                border: '1px solid #E0E0E0',
                borderRadius: '8px',
                padding: '2rem'
            }}>
                <form onSubmit={handleSubmit}>
                    {/* Admin Mode: PS Number Field */}
                    {isAdmin && (
                        <div className="input-group">
                            <label className="input-label">User PS Number *</label>
                            <input
                                type="text"
                                className="input-field"
                                value={formData.psNumber}
                                onChange={(e) => setFormData({ ...formData, psNumber: e.target.value })}
                                placeholder="Enter user's PS number"
                                required={isAdmin}
                                style={{
                                    backgroundColor: '#FFFFFF',
                                    color: '#1F2937',
                                    border: '1px solid #D1D5DB',
                                    padding: '0.75rem',
                                    borderRadius: '6px',
                                    fontSize: '1rem',
                                    width: '100%'
                                }}
                            />
                            <small style={{ color: '#666', fontSize: '0.875rem', marginTop: '0.25rem', display: 'block' }}>
                                Enter the PS number of the user whose password you want to reset
                            </small>
                        </div>
                    )}

                    {/* Non-Admin Mode: Current Password Field */}
                    {!isAdmin && (
                        <div className="input-group">
                            <label className="input-label">Current Password *</label>
                            <div style={{ position: 'relative' }}>
                                <input
                                    type={showCurrentPw ? 'text' : 'password'}
                                    className="input-field"
                                    value={formData.currentPassword}
                                    onChange={(e) => setFormData({ ...formData, currentPassword: e.target.value })}
                                    placeholder="Enter current password"
                                    required={!isAdmin}
                                    style={{
                                        backgroundColor: '#FFFFFF',
                                        color: '#1F2937',
                                        border: '1px solid #D1D5DB',
                                        padding: '0.75rem 3rem 0.75rem 0.75rem',
                                        borderRadius: '6px',
                                        fontSize: '1rem',
                                        width: '100%',
                                        boxSizing: 'border-box'
                                    }}
                                    disabled={loading}
                                />
                                <EyeIcon show={showCurrentPw} onToggle={() => setShowCurrentPw(!showCurrentPw)} />
                            </div>
                        </div>
                    )}

                    <div className="input-group">
                        <label className="input-label">New Password *</label>
                        <div style={{ position: 'relative' }}>
                            <input
                                type={showNewPw ? 'text' : 'password'}
                                className="input-field"
                                value={formData.newPassword}
                                onChange={(e) => setFormData({ ...formData, newPassword: e.target.value })}
                                placeholder="Enter new password (min 6 characters)"
                                required
                                style={{
                                    backgroundColor: '#FFFFFF',
                                    color: '#1F2937',
                                    border: '1px solid #D1D5DB',
                                    padding: '0.75rem 3rem 0.75rem 0.75rem',
                                    borderRadius: '6px',
                                    fontSize: '1rem',
                                    width: '100%',
                                    boxSizing: 'border-box'
                                }}
                                minLength={6}
                                disabled={loading}
                            />
                            <EyeIcon show={showNewPw} onToggle={() => setShowNewPw(!showNewPw)} />
                        </div>
                    </div>

                    <div className="input-group">
                        <label className="input-label">Confirm New Password *</label>
                        <div style={{ position: 'relative' }}>
                            <input
                                type={showConfirmPw ? 'text' : 'password'}
                                className="input-field"
                                value={formData.confirmPassword}
                                onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                                placeholder="Re-enter new password"
                                required
                                style={{
                                    backgroundColor: '#FFFFFF',
                                    color: '#1F2937',
                                    border: '1px solid #D1D5DB',
                                    padding: '0.75rem 3rem 0.75rem 0.75rem',
                                    borderRadius: '6px',
                                    fontSize: '1rem',
                                    width: '100%',
                                    boxSizing: 'border-box'
                                }}
                                minLength={6}
                                disabled={loading}
                            />
                            <EyeIcon show={showConfirmPw} onToggle={() => setShowConfirmPw(!showConfirmPw)} />
                        </div>
                    </div>

                    <button
                        type="submit"
                        className="btn btn-primary"
                        style={{ width: '100%', marginTop: '1rem' }}
                        disabled={loading}
                    >
                        {loading ? 'Changing Password...' : 'Change Password'}
                    </button>
                </form>

                {/* Password Requirements */}
                <div style={{
                    marginTop: '1.5rem',
                    padding: '1rem',
                    background: '#F3F4F6',
                    borderRadius: '6px'
                }}>
                    <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', color: '#374151' }}>
                        Password Requirements:
                    </h3>
                    <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', color: '#6B7280' }}>
                        <li>At least 6 characters long</li>
                        <li>Must match in both new password fields</li>
                    </ul>
                </div>
            </div>
        </div>
    );
};

export default ChangePasswordPage;
