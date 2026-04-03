import React, { createContext, useState, useContext, useEffect } from 'react';
import { useDialog } from '../components/DialogProvider';

const AuthContext = createContext(null);

const parseResponseSafely = async (response) => {
    const raw = await response.text();
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

// Session duration: 8 hours in milliseconds
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const getSessionDurationMs = (sessionTimeoutHours) => {
    const hours = Number.parseInt(String(sessionTimeoutHours || ''), 10);
    if (!Number.isFinite(hours) || hours < 1) return SESSION_DURATION_MS;
    return hours * 60 * 60 * 1000;
};

// ===== DEVICE BINDING: Persistent Device ID =====
const DEVICE_ID_KEY = 'c2c_device_id';

// Fallback UUID generator for non-secure contexts (HTTP without localhost)
const generateUUID = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback: manual UUID v4 using crypto.getRandomValues or Math.random
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
        const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
    // Last resort: Math.random based
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
};

const getOrCreateDeviceId = () => {
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    // Guard against corrupted values (e.g. "undefined", "null", empty string)
    if (!deviceId || deviceId === 'undefined' || deviceId === 'null' || deviceId.length < 10) {
        deviceId = generateUUID();
        localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
};

export const getDeviceId = () => {
    return localStorage.getItem(DEVICE_ID_KEY) || getOrCreateDeviceId();
};

// Helper: build headers with Device-ID for any authenticated request
export const buildAuthHeaders = (token, extra = {}) => {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Device-ID': getDeviceId(),
        ...extra,
    };
};

// Helper: build headers for multipart (no Content-Type)
export const buildAuthHeadersMultipart = (token) => {
    return {
        'Authorization': `Bearer ${token}`,
        'X-Device-ID': getDeviceId(),
    };
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within AuthProvider');
    }
    return context;
};

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    // Ensure Device ID exists on app load
    useEffect(() => {
        getOrCreateDeviceId();
    }, []);

    useEffect(() => {
        // Check if user is logged in on mount
        const token = localStorage.getItem('token');
        const userData = localStorage.getItem('user');
        const sessionExpiry = localStorage.getItem('sessionExpiry');
        const now = Date.now();

        // Check if session has expired
        if (sessionExpiry && now > parseInt(sessionExpiry, 10)) {
            // Session expired - clear auth data (but KEEP device_id!)
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            localStorage.removeItem('sessionExpiry');
            localStorage.removeItem('must_change_password');
            setUser(null);
        } else if (token && userData) {
            // Session still valid - restore user
            setUser(JSON.parse(userData));
        }

        setLoading(false);
    }, []);

    const login = async (identifier, password) => {
        try {
            const deviceId = getOrCreateDeviceId();

            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Device-ID': deviceId,
                },
                body: JSON.stringify({
                    identifier,
                    psNumber: identifier,
                    password,
                }),
            });

            const data = await parseResponseSafely(response);

            if (!response.ok) {
                const fallbackMessage = response.status >= 500
                    ? 'Server error while logging in. Please try again in a moment.'
                    : 'Login failed';
                // Surface specific device-binding error codes
                if (data?.code === 'DEVICE_MISMATCH' || data?.code === 'DEVICE_TAKEN') {
                    throw new Error(data?.error || 'Device binding error');
                }
                throw new Error(data?.error || fallbackMessage);
            }

            if (!data || !data.token || !data.user) {
                throw new Error('Invalid login response from server. Please contact administrator.');
            }

            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            // Set session expiry based on backend configuration
            localStorage.setItem('sessionExpiry', String(Date.now() + getSessionDurationMs(data.sessionTimeoutHours)));
            setUser(data.user);

            // Check if user must change password (stored as 1 or 0 from SQLite)
            if (data.user.must_change_password === 1 || data.user.must_change_password === true) {
                localStorage.setItem('must_change_password', 'true');
                return { ...data.user, requiresPasswordChange: true };
            } else {
                // Clear the flag if not required
                localStorage.removeItem('must_change_password');
            }

            return data.user;
        } catch (error) {
            throw error;
        }
    };

    const register = async (userData) => {
        try {
            const response = await fetch('/api/auth/register', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify(userData),
            });

            const data = await parseResponseSafely(response);

            if (!response.ok) {
                throw new Error(data?.error || 'Registration failed');
            }

            if (!data || !data.token || !data.user) {
                throw new Error('Invalid registration response from server. Please contact administrator.');
            }

            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            // Set session expiry based on backend configuration
            localStorage.setItem('sessionExpiry', String(Date.now() + getSessionDurationMs(data.sessionTimeoutHours)));
            setUser(data.user);

            return data.user;
        } catch (error) {
            throw error;
        }
    };

    const logout = async () => {
        // Notify backend to clear server-side session
        try {
            const token = localStorage.getItem('token');
            if (token) {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'X-Device-ID': getDeviceId(),
                    },
                });
            }
        } catch (e) {
            // Ignore errors — clear local storage regardless
            console.error('Logout API error (non-critical):', e);
        }
        // Clear auth data but KEEP device_id — it is permanent
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem('sessionExpiry');
        localStorage.removeItem('must_change_password');
        setUser(null);
    };

    const getToken = () => localStorage.getItem('token');
    const dialog = useDialog();

    // ===== Global Fetch Interceptor for session invalidation =====
    useEffect(() => {
        const originalFetch = window.fetch;

        window.fetch = async (...args) => {
            const response = await originalFetch(...args);

            // Only intercept 401/403 for authenticated routes (skip login/register)
            if ((response.status === 401 || response.status === 403) && user) {
                try {
                    const cloned = response.clone();
                    const body = await parseResponseSafely(cloned);
                    const sessionErrors = [
                        'SESSION_INVALIDATED',
                        'SESSION_EXPIRED',
                        'DEVICE_SESSION_MISMATCH',
                        'TOKEN_EXPIRED',
                        'INVALID_TOKEN',
                    ];
                    const isSessionFailure = body?.code && sessionErrors.includes(body.code);
                    const isGenericInvalidToken = response.status === 403 && String(body?.error || '').toLowerCase().includes('invalid token');

                    if (isSessionFailure || isGenericInvalidToken) {
                        console.warn(`[DeviceBind] Session terminated: ${body.code}`);
                        // Auto-logout without calling backend (session already dead)
                        localStorage.removeItem('token');
                        localStorage.removeItem('user');
                        localStorage.removeItem('sessionExpiry');
                        localStorage.removeItem('must_change_password');
                        setUser(null);
                        // Show message to user
                        dialog.alert(body?.error || 'Your session has been terminated. Please log in again.');
                        window.location.href = '/login';
                    }
                } catch (e) {
                    // Ignore JSON parse errors — some 401s may not have JSON body
                }
            }

            return response;
        };

        return () => {
            window.fetch = originalFetch;
        };
    }, [user]);

    return (
        <AuthContext.Provider value={{ user, login, register, logout, loading, getToken, getDeviceId: getDeviceId }}>
            {children}
        </AuthContext.Provider>
    );
};
