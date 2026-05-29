import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Mail, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import './CompleteProfilePage.css';

const parseResponseSafely = async (response) => {
    const raw = await response.text();
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

const CompleteProfilePage = () => {
    const navigate = useNavigate();
    const { user, getToken, getDeviceId, updateUser } = useAuth();
    const [name, setName] = useState(String(user?.name || '').trim());
    const [email, setEmail] = useState(String(user?.email || '').trim().toLowerCase());
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const canSubmit = useMemo(() => {
        return name.trim().length > 0 && email.trim().length > 0;
    }, [name, email]);

    const handleSubmit = async (event) => {
        event.preventDefault();
        if (!canSubmit || submitting) {
            return;
        }

        setSubmitting(true);
        setError('');

        try {
            const token = getToken();
            if (!token) {
                navigate('/login', { replace: true });
                return;
            }

            const response = await fetch('/api/users/complete-profile', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify({
                    name: name.trim(),
                    email: email.trim().toLowerCase(),
                }),
            });

            const data = await parseResponseSafely(response);

            if (!response.ok) {
                throw new Error(data?.error || 'Unable to save profile.');
            }

            const updated = data?.user;
            if (!updated) {
                throw new Error('Invalid profile response from server.');
            }

            updateUser({
                ...user,
                ...updated,
                profile_completed: Number(updated.profile_completed || 0),
            });
            navigate('/', { replace: true });
        } catch (submitError) {
            setError(submitError.message || 'Unable to save profile.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="complete-profile-shell">
            <div className="complete-profile-aurora complete-profile-aurora-one" aria-hidden="true"></div>
            <div className="complete-profile-aurora complete-profile-aurora-two" aria-hidden="true"></div>
            <div className="complete-profile-grid" aria-hidden="true"></div>

            <div className="complete-profile-layout">
                <section className="complete-profile-brand-panel">
                    <p className="complete-profile-pill">
                        <Sparkles size={14} />
                        First Login Setup
                    </p>

                    <h1>Welcome to InFloAI</h1>
                    <p>
                        Set your profile once and continue with secure PS Number based access.
                    </p>

                    <div className="complete-profile-info-list">
                        <div className="complete-profile-info-item">
                            <ShieldCheck size={18} />
                            <span>Authentication is managed by your domain (LDAP).</span>
                        </div>

                        {user?.ps_number && (
                            <div className="complete-profile-info-item">
                                <UserRound size={18} />
                                <span>
                                    Your PS Number: <strong>{user.ps_number}</strong>
                                </span>
                            </div>
                        )}
                    </div>
                </section>

                <section className="complete-profile-form-panel">
                    <h2>Complete Your Profile</h2>
                    <p className="complete-profile-form-subtitle">Please confirm your name and email to continue.</p>

                    {error && <div className="complete-profile-error">{error}</div>}

                    <form className="complete-profile-form" onSubmit={handleSubmit}>
                        <label htmlFor="complete-name">Full Name</label>
                        <div className="complete-profile-input-wrap">
                            <UserRound size={18} className="complete-profile-input-icon" />
                            <input
                                id="complete-name"
                                type="text"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="Enter your full name"
                                required
                            />
                        </div>

                        <label htmlFor="complete-email">Email Address</label>
                        <div className="complete-profile-input-wrap">
                            <Mail size={18} className="complete-profile-input-icon" />
                            <input
                                id="complete-email"
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                placeholder="name@company.com"
                                required
                            />
                        </div>

                        <button type="submit" disabled={!canSubmit || submitting} className="complete-profile-submit">
                            {submitting ? 'Saving...' : 'Save and Continue'}
                        </button>
                    </form>
                </section>
            </div>
        </div>
    );
};

export default CompleteProfilePage;
