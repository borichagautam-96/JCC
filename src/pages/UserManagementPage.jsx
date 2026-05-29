import React, { useState, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const REMINDER_ROLE_OPTIONS = [
    { value: 'admin', label: 'Admin' },
    { value: 'manager', label: 'Manager' },
    { value: 'coordinator', label: 'Coordinator' },
    { value: 'final_approver', label: 'Final Approver' },
    { value: 'initiator', label: 'Initiator' },
    { value: 'user', label: 'User' },
];

const SHOW_APP_SECURITY_SETTINGS = import.meta.env.VITE_SHOW_USER_SECURITY_SETTINGS === 'true';

const UserManagementPage = () => {
    const { getToken } = useAuth();
    const dialog = useDialog();
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [showEditModal, setShowEditModal] = useState(false);
    const [showDeviceModal, setShowDeviceModal] = useState(false);
    const [selectedDeviceUser, setSelectedDeviceUser] = useState(null);
    const [editingUser, setEditingUser] = useState(null);
    const [formData, setFormData] = useState({
        ps_number: '',
        name: '',
        email: '',
        password: '',
        role: 'initiator',
        manager_id: '',
        account_limit: 1
    });
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [managers, setManagers] = useState([]);
    const [activeTab, setActiveTab] = useState('users'); // 'users' or 'audit'
    const [auditLogs, setAuditLogs] = useState([]);
    const [auditLoading, setAuditLoading] = useState(false);
    const [showAddPw, setShowAddPw] = useState(false);
    const [showEditPw, setShowEditPw] = useState(false);
    const [appSettingsLoading, setAppSettingsLoading] = useState(false);
    const [appSettings, setAppSettings] = useState({
        session_timeout_hours: 8,
        return_maker_checker_enabled: false,
        return_reminder_advance_days: 2,
        reminder_email_roles: ['admin', 'manager', 'coordinator', 'final_approver'],
        reminder_notification_roles: ['admin', 'manager', 'coordinator', 'final_approver'],
    });

    const EyeBtn = ({ show, onToggle }) => (
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
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
            ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                </svg>
            )}
        </button>
    );

    const authHeaders = () => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
    });

    const parseJsonSafe = async (response) => {
        try {
            return await response.json();
        } catch {
            return null;
        }
    };

    useEffect(() => {
        fetchUsers();
        fetchManagers();
        if (SHOW_APP_SECURITY_SETTINGS) {
            fetchAppSettings();
        }
    }, []);

    const fetchAppSettings = async () => {
        setAppSettingsLoading(true);
        try {
            const response = await fetch('/api/users/settings/app', { headers: authHeaders() });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to load app settings');
            setAppSettings({
                session_timeout_hours: data.session_timeout_hours ?? 8,
                return_maker_checker_enabled: Boolean(data.return_maker_checker_enabled),
                return_reminder_advance_days: data.return_reminder_advance_days ?? 2,
                reminder_email_roles: Array.isArray(data.reminder_email_roles)
                    ? data.reminder_email_roles
                    : ['admin', 'manager', 'coordinator', 'final_approver'],
                reminder_notification_roles: Array.isArray(data.reminder_notification_roles)
                    ? data.reminder_notification_roles
                    : ['admin', 'manager', 'coordinator', 'final_approver'],
            });
        } catch (error) {
            console.error('Error loading app settings:', error);
        } finally {
            setAppSettingsLoading(false);
        }
    };

    const toggleReminderRole = (field, role) => {
        setAppSettings((prev) => {
            const roles = Array.isArray(prev[field]) ? prev[field] : [];
            const nextRoles = roles.includes(role)
                ? roles.filter((value) => value !== role)
                : [...roles, role];
            return { ...prev, [field]: nextRoles };
        });
    };

    const saveAppSettings = async () => {
        try {
            const response = await fetch('/api/users/settings/app', {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify(appSettings),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to save app settings');
            setSuccess('App settings updated successfully');
        } catch (error) {
            setError(error.message || 'Failed to save app settings');
        }
    };

    const fetchUsers = async () => {
        try {
            const response = await fetch('/api/users', {
                headers: authHeaders()
            });

            if (response.status === 401) {
                // Session invalidated
                globalThis.location.href = '/login';
                return;
            }

            const data = await parseJsonSafe(response);
            if (!response.ok) {
                throw new Error(data?.error || `Failed to load users (${response.status})`);
            }

            setUsers(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error('Error fetching users:', error);
            setError('Failed to load users');
        } finally {
            setLoading(false);
        }
    };

    const fetchManagers = async () => {
        try {
            const response = await fetch('/api/users', {
                headers: authHeaders()
            });

            if (response.status === 401) {
                globalThis.location.href = '/login';
                return;
            }

            const data = await parseJsonSafe(response);
            if (!response.ok) {
                throw new Error(data?.error || `Failed to load managers (${response.status})`);
            }

            const managerUsers = data.filter(u => u.role === 'manager' || u.role === 'admin');
            setManagers(managerUsers);
        } catch (error) {
            console.error('Error fetching managers:', error);
        }
    };

    const fetchAuditLogs = async () => {
        setAuditLoading(true);
        try {
            const response = await fetch('/api/users/device-audit-log', {
                headers: authHeaders()
            });

            if (response.status === 401) {
                globalThis.location.href = '/login';
                return;
            }

            const data = await parseJsonSafe(response);
            if (!response.ok) {
                throw new Error(data?.error || `Failed to fetch audit log (${response.status})`);
            }

            setAuditLogs(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error('Error fetching audit logs:', error);
        } finally {
            setAuditLoading(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        try {
            const response = await fetch('/api/users/add', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(formData)
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.details || data.error || 'Failed to create user');
            }

            setSuccess('User created successfully!');
            setFormData({
                ps_number: '',
                name: '',
                email: '',
                password: '',
                role: 'initiator',
                manager_id: '',
                account_limit: 1
            });
            setShowAddModal(false);
            fetchUsers();
        } catch (error) {
            setError(error.message);
        }
    };

    const handleEdit = (user) => {
        setEditingUser(user);
        setFormData({
            ps_number: user.ps_number || '',
            name: user.name,
            email: user.email || '',
            password: '',
            role: user.role,
            manager_id: '',
            account_limit: user.account_limit || 1
        });
        setShowEditModal(true);
    };

    const handleUpdateUser = async () => {
        setError('');
        setSuccess('');

        try {
            const updateData = {
                name: formData.name,
                email: formData.email,
                role: formData.role,
                manager_id: formData.manager_id || null,
                account_limit: parseInt(formData.account_limit) || 1
            };

            if (formData.password && formData.password.trim()) {
                updateData.password = formData.password;
            }

            const response = await fetch(`/api/users/${editingUser.id}`, {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify(updateData)
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to update user');
            }

            setSuccess('User updated successfully!');
            setShowEditModal(false);
            setEditingUser(null);
            setFormData({
                ps_number: '',
                name: '',
                email: '',
                password: '',
                role: 'initiator',
                manager_id: '',
                account_limit: 1
            });
            fetchUsers();
        } catch (error) {
            setError(error.message);
        }
    };

    const handleDelete = async (id) => {
        const confirmed = await dialog.confirm('Are you sure you want to delete this user? This will also clear their device binding and sessions.');
        if (!confirmed) {
            return;
        }

        try {
            const response = await fetch(`/api/users/${id}`, {
                method: 'DELETE',
                headers: authHeaders()
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to delete user');
            }

            setSuccess('User deleted successfully');
            fetchUsers();
        } catch (error) {
            setError(error.message);
        }
    };

    // ===== DEVICE MANAGEMENT FUNCTIONS =====

    const handleUnbindDevice = async (userId) => {
        const confirmed = await dialog.confirm('Unbind this user\'s device? They will need to log in again from a new device.');
        if (!confirmed) return;
        try {
            const response = await fetch(`/api/users/${userId}/unbind-device`, {
                method: 'POST',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            setSuccess(data.message);
            fetchUsers();
            if (selectedDeviceUser?.id === userId) {
                setShowDeviceModal(false);
                setSelectedDeviceUser(null);
            }
        } catch (error) {
            setError(error.message);
        }
    };

    const handleEndSession = async (userId) => {
        const confirmed = await dialog.confirm('End this user\'s active session? They will be logged out immediately.');
        if (!confirmed) return;
        try {
            const response = await fetch(`/api/users/${userId}/end-session`, {
                method: 'POST',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            setSuccess(data.message);
            fetchUsers();
        } catch (error) {
            setError(error.message);
        }
    };

    const handleClearDeviceData = async (userId) => {
        const confirmed = await dialog.confirm('Clear ALL device data for this user? This includes binding, sessions, and audit history. This cannot be undone.', { variant: 'warning' });
        if (!confirmed) return;
        try {
            const response = await fetch(`/api/users/${userId}/clear-device-data`, {
                method: 'POST',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            setSuccess(data.message);
            fetchUsers();
            if (selectedDeviceUser?.id === userId) {
                setShowDeviceModal(false);
                setSelectedDeviceUser(null);
            }
        } catch (error) {
            setError(error.message);
        }
    };

    const handleSetAccountLimit = async (userId, limit) => {
        try {
            const response = await fetch(`/api/users/${userId}/account-limit`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ account_limit: limit })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            setSuccess(data.message);
            fetchUsers();
        } catch (error) {
            setError(error.message);
        }
    };

    const openDeviceModal = (user) => {
        setSelectedDeviceUser(user);
        setShowDeviceModal(true);
    };

    // Helper: device status badge
    const getDeviceStatusBadge = (user) => {
        if (user.registered_device_id) {
            return { label: 'Bound', bg: '#DBEAFE', color: '#1E40AF' };
        }
        return { label: 'Unbound', bg: '#FEF3C7', color: '#92400E' };
    };

    const getSessionStatusBadge = (user) => {
        if (user.active_session) {
            const expires = new Date(user.active_session.expires_at);
            if (expires > new Date()) {
                return { label: 'Active', bg: '#D1FAE5', color: '#065F46' };
            }
            return { label: 'Expired', bg: '#FEE2E2', color: '#991B1B' };
        }
        return { label: 'No Session', bg: '#F3F4F6', color: '#6B7280' };
    };

    return (
        <div className="fade-in" style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{
                background: '#fff',
                color: 'white',
                padding: '1.75rem 2rem',
                borderRadius: '10px',
                marginBottom: '2rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                boxShadow: '0 2px 8px rgba(0, 102, 204, 0.15)'
            }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'black' }}>User Management</h1>
                    <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, color: 'black' }}>
                        Manage users, device bindings, and session security
                    </p>
                </div>
                <button
                    onClick={() => setShowAddModal(true)}
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: '#10B981',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        fontSize: '1rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        boxShadow: '0 2px 4px rgba(16, 185, 129, 0.3)',
                        transition: 'all 0.2s ease'
                    }}
                    onMouseEnter={e => e.target.style.background = '#059669'}
                    onMouseLeave={e => e.target.style.background = '#10B981'}
                >
                    + Add New User
                </button>
            </div>

            {/* Tab Navigation */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
                <button
                    onClick={() => setActiveTab('users')}
                    style={{
                        padding: '0.7rem 1.5rem',
                        background: activeTab === 'users' ? '#0066CC' : '#E5E7EB',
                        color: activeTab === 'users' ? 'white' : '#374151',
                        border: 'none',
                        borderRadius: '6px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontSize: '0.95rem'
                    }}
                >
                    Users & Devices
                </button>
                <button
                    onClick={() => { setActiveTab('audit'); fetchAuditLogs(); }}
                    style={{
                        padding: '0.7rem 1.5rem',
                        background: activeTab === 'audit' ? '#0066CC' : '#E5E7EB',
                        color: activeTab === 'audit' ? 'white' : '#374151',
                        border: 'none',
                        borderRadius: '6px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontSize: '0.95rem'
                    }}
                >
                    Device Audit Log
                </button>
            </div>

            {/* Messages */}
            {error && (
                <div style={{
                    padding: '1rem 1.25rem',
                    background: '#FEE2E2',
                    color: '#991B1B',
                    borderRadius: '6px',
                    marginBottom: '1rem',
                    fontSize: '0.95rem'
                }}>
                    {error}
                    <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', color: '#991B1B', cursor: 'pointer', fontWeight: 700 }}>x</button>
                </div>
            )}

            {success && (
                <div style={{
                    padding: '1rem 1.25rem',
                    background: '#D1FAE5',
                    color: '#065F46',
                    borderRadius: '6px',
                    marginBottom: '1rem',
                    fontSize: '0.95rem'
                }}>
                    {success}
                    <button onClick={() => setSuccess('')} style={{ float: 'right', background: 'none', border: 'none', color: '#065F46', cursor: 'pointer', fontWeight: 700 }}>x</button>
                </div>
            )}

            {SHOW_APP_SECURITY_SETTINGS && (
                <div style={{
                    background: 'white',
                    border: '1px solid #E2E8F0',
                    borderRadius: '10px',
                    padding: '1rem',
                    marginBottom: '1.25rem'
                }}>
                    <h3 style={{ margin: '0 0 0.75rem 0', color: '#0F172A' }}>App Security & Return Workflow Settings</h3>
                    {appSettingsLoading ? (
                        <p style={{ margin: 0, color: '#64748B' }}>Loading settings...</p>
                    ) : (
                        <div style={{ display: 'grid', gap: '0.9rem' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '0.75rem', alignItems: 'end' }}>
                            <div className="input-group" style={{ marginBottom: 0 }}>
                                <label className="input-label">Session Timeout (hours)</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="72"
                                    className="input-field"
                                    value={appSettings.session_timeout_hours}
                                    onChange={(e) => setAppSettings((prev) => ({ ...prev, session_timeout_hours: Number(e.target.value || 8) }))}
                                />
                            </div>

                            <div className="input-group" style={{ marginBottom: 0 }}>
                                <label className="input-label">Return Reminder (days before due)</label>
                                <input
                                    type="number"
                                    min="0"
                                    max="30"
                                    className="input-field"
                                    value={appSettings.return_reminder_advance_days}
                                    onChange={(e) => setAppSettings((prev) => ({ ...prev, return_reminder_advance_days: Number(e.target.value || 0) }))}
                                />
                            </div>

                            <div className="input-group" style={{ marginBottom: 0 }}>
                                <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <input
                                        type="checkbox"
                                        checked={appSettings.return_maker_checker_enabled}
                                        onChange={(e) => setAppSettings((prev) => ({ ...prev, return_maker_checker_enabled: e.target.checked }))}
                                    />
                                    Enable Maker-Checker for Returns
                                </label>
                            </div>

                            <button className="btn btn-primary" onClick={saveAppSettings}>Save Settings</button>
                            </div>

                            <div style={{ borderTop: '1px solid #E2E8F0', paddingTop: '0.9rem' }}>
                                <h4 style={{ margin: '0 0 0.6rem 0', color: '#1E293B', fontSize: '0.95rem' }}>Notification Settings Panel</h4>
                                <p style={{ margin: '0 0 0.75rem 0', color: '#64748B', fontSize: '0.86rem' }}>
                                    Enable or disable which roles receive reminder notifications and reminder emails.
                                </p>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.9rem' }}>
                                    <div style={{ border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.8rem' }}>
                                        <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: '#0F172A' }}>In-app reminder notifications</div>
                                        <div style={{ display: 'grid', gap: '0.4rem' }}>
                                            {REMINDER_ROLE_OPTIONS.map((role) => (
                                                <label key={`notify-${role.value}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.88rem', color: '#334155' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={appSettings.reminder_notification_roles.includes(role.value)}
                                                        onChange={() => toggleReminderRole('reminder_notification_roles', role.value)}
                                                    />
                                                    {role.label}
                                                </label>
                                            ))}
                                        </div>
                                    </div>

                                    <div style={{ border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.8rem' }}>
                                        <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: '#0F172A' }}>Reminder emails by role</div>
                                        <div style={{ display: 'grid', gap: '0.4rem' }}>
                                            {REMINDER_ROLE_OPTIONS.map((role) => (
                                                <label key={`email-${role.value}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.88rem', color: '#334155' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={appSettings.reminder_email_roles.includes(role.value)}
                                                        onChange={() => toggleReminderRole('reminder_email_roles', role.value)}
                                                    />
                                                    {role.label}
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ===== USERS TAB ===== */}
            {activeTab === 'users' && (
                <div style={{
                    background: 'white',
                    border: '1px solid #E0E0E0',
                    borderRadius: '10px',
                    overflow: 'auto',
                    boxShadow: '0 1px 6px rgba(0, 0, 0, 0.06)'
                }}>
                    <table className="table" style={{ minWidth: '1100px' }}>
                        <thead>
                            <tr>
                                <th>PS Number</th>
                                <th>Name</th>
                                <th>Email</th>
                                <th>Role</th>
                                <th>Device Status</th>
                                <th>Session</th>
                                <th>Account Limit</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr>
                                    <td colSpan="8" style={{ textAlign: 'center', padding: '2rem' }}>
                                        Loading users...
                                    </td>
                                </tr>
                            ) : users.length === 0 ? (
                                <tr>
                                    <td colSpan="8" style={{ textAlign: 'center', padding: '2rem', color: '#999' }}>
                                        No users found
                                    </td>
                                </tr>
                            ) : (
                                users.map(user => {
                                    const deviceBadge = getDeviceStatusBadge(user);
                                    const sessionBadge = getSessionStatusBadge(user);
                                    return (
                                        <tr key={user.id}>
                                            <td style={{ fontWeight: 600, color: '#0066CC', fontSize: '0.95rem' }}>
                                                {user.ps_number || '-'}
                                            </td>
                                            <td style={{ fontSize: '0.95rem' }}>{user.name}</td>
                                            <td style={{ fontSize: '0.9rem', color: '#555' }}>{user.email}</td>
                                            <td>
                                                <span style={{
                                                    padding: '5px 12px',
                                                    borderRadius: '12px',
                                                    fontSize: '0.82rem',
                                                    fontWeight: 600,
                                                    letterSpacing: '0.02em',
                                                    background: user.role === 'admin' ? '#DBEAFE' : user.role === 'manager' ? '#FEF3C7' : user.role === 'final_approver' ? '#F3E8FF' : user.role === 'coordinator' ? '#E0F2FE' : '#F3F4F6',
                                                    color: user.role === 'admin' ? '#1E40AF' : user.role === 'manager' ? '#92400E' : user.role === 'final_approver' ? '#6B21A8' : user.role === 'coordinator' ? '#0369A1' : '#374151'
                                                }}>
                                                    {user.role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                                </span>
                                            </td>
                                            <td>
                                                <span
                                                    onClick={() => openDeviceModal(user)}
                                                    style={{
                                                        padding: '5px 12px',
                                                        borderRadius: '12px',
                                                        fontSize: '0.82rem',
                                                        fontWeight: 600,
                                                        background: deviceBadge.bg,
                                                        color: deviceBadge.color,
                                                        cursor: 'pointer',
                                                        textDecoration: 'none',
                                                        transition: 'opacity 0.2s ease'
                                                    }}
                                                    title="Click for device details"
                                                >
                                                    {deviceBadge.label}
                                                </span>
                                            </td>
                                            <td>
                                                <span style={{
                                                    padding: '5px 12px',
                                                    borderRadius: '12px',
                                                    fontSize: '0.82rem',
                                                    fontWeight: 600,
                                                    background: sessionBadge.bg,
                                                    color: sessionBadge.color
                                                }}>
                                                    {sessionBadge.label}
                                                </span>
                                            </td>
                                            <td style={{ textAlign: 'center' }}>
                                                <select
                                                    value={user.account_limit || 1}
                                                    onChange={(e) => handleSetAccountLimit(user.id, parseInt(e.target.value))}
                                                    style={{
                                                        padding: '5px 8px',
                                                        borderRadius: '6px',
                                                        border: '1px solid #D1D5DB',
                                                        fontSize: '0.9rem',
                                                        fontWeight: 600,
                                                        width: '60px',
                                                        cursor: 'pointer',
                                                        background: '#FAFAFA'
                                                    }}
                                                >
                                                    <option value={1}>1</option>
                                                    <option value={2}>2</option>
                                                    <option value={3}>3</option>
                                                    <option value={4}>4</option>
                                                    <option value={5}>5</option>
                                                </select>
                                            </td>
                                            <td>
                                                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                    <button
                                                        onClick={() => handleEdit(user)}
                                                        style={{
                                                            padding: '0.28rem 0.7rem',
                                                            background: '#3B82F6',
                                                            color: 'white',
                                                            border: 'none',
                                                            borderRadius: '6px',
                                                            fontSize: '0.79rem',
                                                            fontWeight: 600,
                                                            cursor: 'pointer',
                                                            transition: 'all 0.2s ease',
                                                            boxShadow: '0 1px 3px rgba(59, 130, 246, 0.25)'
                                                        }}
                                                        onMouseEnter={e => e.target.style.opacity = '0.85'}
                                                        onMouseLeave={e => e.target.style.opacity = '1'}
                                                    >
                                                        Edit
                                                    </button>
                                                    {user.registered_device_id && (
                                                        <button
                                                            onClick={() => handleUnbindDevice(user.id)}
                                                            style={{
                                                                padding: '0.28rem 0.7rem',
                                                                background: '#F59E0B',
                                                                color: 'white',
                                                                border: 'none',
                                                                borderRadius: '6px',
                                                                fontSize: '0.79rem',
                                                                fontWeight: 600,
                                                                cursor: 'pointer',
                                                                transition: 'all 0.2s ease',
                                                                boxShadow: '0 1px 3px rgba(245, 158, 11, 0.25)'
                                                            }}
                                                            onMouseEnter={e => e.target.style.opacity = '0.85'}
                                                            onMouseLeave={e => e.target.style.opacity = '1'}
                                                            title="Unbind device"
                                                        >
                                                            Unbind
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => handleDelete(user.id)}
                                                        style={{
                                                            padding: '0.28rem 0.7rem',
                                                            background: '#EF4444',
                                                            color: 'white',
                                                            border: 'none',
                                                            borderRadius: '6px',
                                                            cursor: 'pointer',
                                                            fontSize: '0.79rem',
                                                            fontWeight: 600,
                                                            transition: 'all 0.2s ease',
                                                            boxShadow: '0 1px 3px rgba(239, 68, 68, 0.25)'
                                                        }}
                                                        onMouseEnter={e => e.target.style.opacity = '0.85'}
                                                        onMouseLeave={e => e.target.style.opacity = '1'}
                                                    >
                                                        Delete
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* ===== AUDIT LOG TAB ===== */}
            {activeTab === 'audit' && (
                <div style={{
                    background: 'white',
                    border: '1px solid #E0E0E0',
                    borderRadius: '8px',
                    overflow: 'auto'
                }}>
                    <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid #E0E0E0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Device Binding Audit Log</h3>
                        <button onClick={fetchAuditLogs} style={{ padding: '0.4rem 0.85rem', background: '#E5E7EB', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
                            Refresh
                        </button>
                    </div>
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th>User</th>
                                <th>Action</th>
                                <th>Device ID</th>
                                <th>Performed By</th>
                                <th>Details</th>
                            </tr>
                        </thead>
                        <tbody>
                            {auditLoading ? (
                                <tr><td colSpan="6" style={{ textAlign: 'center', padding: '2rem' }}>Loading...</td></tr>
                            ) : auditLogs.length === 0 ? (
                                <tr><td colSpan="6" style={{ textAlign: 'center', padding: '2rem', color: '#999' }}>No audit logs found</td></tr>
                            ) : (
                                auditLogs.map(log => {
                                    const actionColors = {
                                        'BOUND': { bg: '#D1FAE5', color: '#065F46' },
                                        'ADMIN_UNBOUND': { bg: '#FEF3C7', color: '#92400E' },
                                        'REJECTED_DEVICE_TAKEN': { bg: '#FEE2E2', color: '#991B1B' },
                                        'REJECTED_DEVICE_MISMATCH': { bg: '#FEE2E2', color: '#991B1B' },
                                        'ACCOUNT_LIMIT_CHANGED': { bg: '#DBEAFE', color: '#1E40AF' },
                                        'DATA_CLEARED': { bg: '#F3E8FF', color: '#6B21A8' }
                                    };
                                    const actionStyle = actionColors[log.action] || { bg: '#F3F4F6', color: '#374151' };
                                    return (
                                        <tr key={log.id}>
                                            <td style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>{new Date(log.created_at).toLocaleString()}</td>
                                            <td style={{ fontWeight: 600, fontSize: '0.9rem' }}>{log.user_name || '-'} {log.user_ps_number ? `(${log.user_ps_number})` : ''}</td>
                                            <td>
                                                <span style={{
                                                    padding: '4px 8px',
                                                    borderRadius: '4px',
                                                    fontSize: '0.8rem',
                                                    fontWeight: 700,
                                                    background: actionStyle.bg,
                                                    color: actionStyle.color
                                                }}>
                                                    {log.action}
                                                </span>
                                            </td>
                                            <td style={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>
                                                {log.device_id ? log.device_id.substring(0, 12) + '...' : '-'}
                                            </td>
                                            <td>{log.performed_by_name || 'System'}</td>
                                            <td style={{ fontSize: '0.85rem', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={log.details}>
                                                {log.details || '-'}
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* ===== DEVICE DETAILS MODAL ===== */}
            {showDeviceModal && selectedDeviceUser && (
                <div className="app-modal-backdrop">
                    <div className="app-modal app-modal-md" style={{ maxWidth: '600px', maxHeight: '85vh' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                            <h2 style={{ margin: 0 }}>Device Info — {selectedDeviceUser.name}</h2>
                            <button onClick={() => { setShowDeviceModal(false); setSelectedDeviceUser(null); }}
                                style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#6B7280' }}>x</button>
                        </div>

                        {/* Device Binding Info */}
                        <div style={{ background: '#F9FAFB', borderRadius: '8px', padding: '1.25rem', marginBottom: '1rem' }}>
                            <h4 style={{ margin: '0 0 0.75rem 0', color: '#374151', fontSize: '1rem' }}>Device Binding</h4>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.9rem' }}>
                                <div><strong>Status:</strong></div>
                                <div>
                                    <span style={{
                                        padding: '2px 8px', borderRadius: '4px', fontWeight: 600,
                                        background: selectedDeviceUser.registered_device_id ? '#D1FAE5' : '#FEF3C7',
                                        color: selectedDeviceUser.registered_device_id ? '#065F46' : '#92400E'
                                    }}>
                                        {selectedDeviceUser.registered_device_id ? 'Bound' : 'Unbound'}
                                    </span>
                                </div>

                                <div><strong>Device ID:</strong></div>
                                <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all' }}>
                                    {selectedDeviceUser.registered_device_id || 'None'}
                                </div>

                                <div><strong>Bound At:</strong></div>
                                <div>{selectedDeviceUser.device_bound_at ? new Date(selectedDeviceUser.device_bound_at).toLocaleString() : '-'}</div>

                                <div><strong>Browser (UA):</strong></div>
                                <div style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>{selectedDeviceUser.device_user_agent || '-'}</div>

                                <div><strong>Bound IP:</strong></div>
                                <div>{selectedDeviceUser.device_bound_ip || '-'}</div>

                                <div><strong>Account Limit:</strong></div>
                                <div style={{ fontWeight: 700 }}>{selectedDeviceUser.account_limit || 1} account(s) per device</div>

                                {selectedDeviceUser.device_unbound_at && (
                                    <>
                                        <div><strong>Last Unbound:</strong></div>
                                        <div>{new Date(selectedDeviceUser.device_unbound_at).toLocaleString()}</div>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Active Session Info */}
                        <div style={{ background: '#F9FAFB', borderRadius: '8px', padding: '1.25rem', marginBottom: '1.5rem' }}>
                            <h4 style={{ margin: '0 0 0.75rem 0', color: '#374151', fontSize: '1rem' }}>Active Session</h4>
                            {selectedDeviceUser.active_session ? (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.9rem' }}>
                                    <div><strong>Session Started:</strong></div>
                                    <div>{new Date(selectedDeviceUser.active_session.created_at).toLocaleString()}</div>

                                    <div><strong>Last Active:</strong></div>
                                    <div>{new Date(selectedDeviceUser.active_session.last_seen).toLocaleString()}</div>

                                    <div><strong>Expires At:</strong></div>
                                    <div>{new Date(selectedDeviceUser.active_session.expires_at).toLocaleString()}</div>

                                    <div><strong>Session IP:</strong></div>
                                    <div>{selectedDeviceUser.active_session.ip_address || '-'}</div>
                                </div>
                            ) : (
                                <p style={{ color: '#6B7280', margin: 0 }}>No active session</p>
                            )}
                        </div>

                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {selectedDeviceUser.registered_device_id && (
                                <button
                                    onClick={() => handleUnbindDevice(selectedDeviceUser.id)}
                                    style={{
                                        padding: '0.5rem 1rem', background: '#F59E0B', color: 'white',
                                        border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer'
                                    }}
                                >
                                    Unbind Device
                                </button>
                            )}
                            {selectedDeviceUser.active_session && (
                                <button
                                    onClick={() => handleEndSession(selectedDeviceUser.id)}
                                    style={{
                                        padding: '0.5rem 1rem', background: '#8B5CF6', color: 'white',
                                        border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer'
                                    }}
                                >
                                    End Session
                                </button>
                            )}
                            <button
                                onClick={() => handleClearDeviceData(selectedDeviceUser.id)}
                                style={{
                                    padding: '0.5rem 1rem', background: '#EF4444', color: 'white',
                                    border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer'
                                }}
                            >
                                Clear All Device Data
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Add User Modal */}
            {showAddModal && (
                <div className="app-modal-backdrop">
                    <div className="app-modal app-modal-sm" style={{ maxWidth: '500px' }}>
                        <h2 className="app-modal-title">Add New User</h2>

                        <form onSubmit={handleSubmit}>
                            <div className="input-group">
                                <label className="input-label">PS Number *</label>
                                <input
                                    type="text"
                                    className="input-field"
                                    value={formData.ps_number}
                                    onChange={(e) => setFormData({ ...formData, ps_number: e.target.value })}
                                    placeholder="e.g., PS2037582"
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Name *</label>
                                <input
                                    type="text"
                                    className="input-field"
                                    value={formData.name}
                                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                    placeholder="Full Name"
                                    required
                                />
                            </div>

                            <div className="input-group">
                                <label className="input-label">Email *</label>
                                <div style={{ display: 'flex', alignItems: 'stretch' }}>
                                    <input
                                        type="text"
                                        className="input-field"
                                        value={formData.email.replace('@larsentoubro.com', '')}
                                        onChange={(e) => {
                                            const username = e.target.value.replace(/@.*/, '').toLowerCase();
                                            setFormData({ ...formData, email: username ? `${username}@larsentoubro.com` : '' });
                                        }}
                                        placeholder="gautam.boricha"
                                        required
                                        style={{ borderRadius: '6px 0 0 6px', flex: 1 }}
                                    />
                                    <span style={{
                                        padding: '0 12px',
                                        background: '#E5E7EB',
                                        border: '1px solid #D1D5DB',
                                        borderLeft: 'none',
                                        borderRadius: '0 6px 6px 0',
                                        color: '#374151',
                                        fontWeight: 500,
                                        fontSize: '0.88rem',
                                        display: 'flex',
                                        alignItems: 'center',
                                        whiteSpace: 'nowrap'
                                    }}>
                                        @larsentoubro.com
                                    </span>
                                </div>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Temporary Password *</label>
                                <div style={{ position: 'relative' }}>
                                    <input
                                        type={showAddPw ? 'text' : 'password'}
                                        className="input-field"
                                        value={formData.password}
                                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                        placeholder="User will be asked to change this"
                                        required
                                        minLength={6}
                                        style={{ paddingRight: '2.5rem', boxSizing: 'border-box', width: '100%' }}
                                    />
                                    <EyeBtn show={showAddPw} onToggle={() => setShowAddPw(!showAddPw)} />
                                </div>
                                <small style={{ color: '#666', fontSize: '0.85rem' }}>
                                    User must change this password on first login
                                </small>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Role *</label>
                                <select
                                    className="input-field"
                                    value={formData.role}
                                    onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                                    required
                                >
                                    <option value="initiator">Initiator / User</option>
                                    <option value="coordinator">Coordinator</option>
                                    <option value="manager">Manager</option>
                                    <option value="final_approver">Final Approver</option>
                                    <option value="admin">Admin</option>
                                </select>
                            </div>

                            <div className="input-group">
                                <label className="input-label">Account Limit per Device</label>
                                <select
                                    className="input-field"
                                    value={formData.account_limit}
                                    onChange={(e) => setFormData({ ...formData, account_limit: parseInt(e.target.value) })}
                                >
                                    <option value={1}>1 (Strict — default)</option>
                                    <option value={2}>2</option>
                                    <option value={3}>3</option>
                                    <option value={4}>4</option>
                                    <option value={5}>5</option>
                                </select>
                                <small style={{ color: '#666', fontSize: '0.85rem' }}>
                                    How many accounts can share one browser/device. Default is 1 (strict one-to-one).
                                </small>
                            </div>

                            <div className="app-modal-actions">
                                <button
                                    type="submit"
                                    className="btn btn-primary"
                                    style={{ flex: 1, fontSize: '0.95rem' }}
                                >
                                    Create User
                                </button>
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() => {
                                        setShowAddModal(false);
                                        setFormData({
                                            ps_number: '',
                                            name: '',
                                            email: '',
                                            password: '',
                                            role: 'initiator',
                                            account_limit: 1
                                        });
                                    }}
                                    style={{
                                        flex: 1,
                                        background: '#E5E7EB',
                                        color: '#374151'
                                    }}
                                >
                                    Cancel
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Edit User Modal */}
            {showEditModal && (
                <div className="app-modal-backdrop">
                    <div className="app-modal app-modal-sm" style={{ maxWidth: '500px' }}>
                        <h2 className="app-modal-title">Edit User - {editingUser?.name}</h2>

                        <div className="input-group">
                            <label className="input-label">PS Number (Read-only)</label>
                            <input
                                type="text"
                                className="input-field"
                                value={formData.ps_number}
                                disabled
                                style={{ background: '#F3F4F6', cursor: 'not-allowed' }}
                            />
                        </div>

                        <div className="input-group">
                            <label className="input-label">Name *</label>
                            <input
                                type="text"
                                className="input-field"
                                value={formData.name}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                required
                            />
                        </div>

                        <div className="input-group">
                            <label className="input-label">Email *</label>
                            <div style={{ display: 'flex', alignItems: 'stretch' }}>
                                <input
                                    type="text"
                                    className="input-field"
                                    value={formData.email.replace('@larsentoubro.com', '')}
                                    onChange={(e) => {
                                        const username = e.target.value.replace(/@.*/, '').toLowerCase();
                                        setFormData({ ...formData, email: username ? `${username}@larsentoubro.com` : '' });
                                    }}
                                    placeholder="gautam.boricha"
                                    required
                                    style={{ borderRadius: '6px 0 0 6px', flex: 1 }}
                                />
                                <span style={{
                                    padding: '0 12px',
                                    background: '#E5E7EB',
                                    border: '1px solid #D1D5DB',
                                    borderLeft: 'none',
                                    borderRadius: '0 6px 6px 0',
                                    color: '#374151',
                                    fontWeight: 500,
                                    fontSize: '0.88rem',
                                    display: 'flex',
                                    alignItems: 'center',
                                    whiteSpace: 'nowrap'
                                }}>
                                    @larsentoubro.com
                                </span>
                            </div>
                        </div>

                        <div className="input-group">
                            <label className="input-label">New Password (leave blank to keep current)</label>
                            <div style={{ position: 'relative' }}>
                                <input
                                    type={showEditPw ? 'text' : 'password'}
                                    className="input-field"
                                    value={formData.password}
                                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                    placeholder="Enter new password or leave blank"
                                    style={{ paddingRight: '2.5rem', boxSizing: 'border-box', width: '100%' }}
                                />
                                <EyeBtn show={showEditPw} onToggle={() => setShowEditPw(!showEditPw)} />
                            </div>
                        </div>

                        <div className="input-group">
                            <label className="input-label">Role *</label>
                            <select
                                className="input-field"
                                value={formData.role}
                                onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                                required
                            >
                                <option value="initiator">Initiator / User</option>
                                <option value="coordinator">Coordinator</option>
                                <option value="manager">Manager</option>
                                <option value="final_approver">Final Approver</option>
                                <option value="admin">Admin</option>
                            </select>
                        </div>

                        <div className="input-group">
                            <label className="input-label">Account Limit per Device</label>
                            <select
                                className="input-field"
                                value={formData.account_limit}
                                onChange={(e) => setFormData({ ...formData, account_limit: parseInt(e.target.value) })}
                            >
                                <option value={1}>1 (Strict — default)</option>
                                <option value={2}>2</option>
                                <option value={3}>3</option>
                                <option value={4}>4</option>
                                <option value={5}>5</option>
                            </select>
                            <small style={{ color: '#666', fontSize: '0.85rem' }}>
                                How many accounts can share one browser/device.
                            </small>
                        </div>

                        <div className="app-modal-actions">
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={handleUpdateUser}
                                style={{ flex: 1, fontSize: '0.95rem' }}
                            >
                                Update User
                            </button>
                            <button
                                type="button"
                                className="btn"
                                onClick={() => {
                                    setShowEditModal(false);
                                    setEditingUser(null);
                                    setFormData({
                                        ps_number: '',
                                        name: '',
                                        email: '',
                                        password: '',
                                        role: 'initiator',
                                        manager_id: '',
                                        account_limit: 1
                                    });
                                }}
                                style={{
                                    flex: 1,
                                    background: '#E5E7EB',
                                    color: '#374151'
                                }}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default UserManagementPage;



