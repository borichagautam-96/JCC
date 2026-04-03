import React, { useEffect, useRef } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth, getDeviceId } from './contexts/AuthContext';
import { DialogProvider } from './components/DialogProvider';
import LoginPage from './pages/LoginPage';
import VendorUploadPage from './pages/VendorUploadPage';
import CoordinatorPage from './pages/CoordinatorPage';
import DashboardPage from './pages/DashboardPage';
import VoucherRequestPage from './pages/VoucherRequestPage';
import VoucherHistoryPage from './pages/VoucherHistoryPage';
import UserManagementPage from './pages/UserManagementPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import CustomerManagementPage from './pages/CustomerManagementPage';
import AssignedInvoicesPage from './pages/AssignedInvoicesPage';
import ProjectManagementPage from './pages/ProjectManagementPage';
import IncomingLettersPage from './pages/IncomingLettersPage';
import LetterDetailPage from './pages/LetterDetailPage';

import LetterTemplatesPage from './pages/LetterTemplatesPage';
import PurchaseOrderPage from './pages/PurchaseOrderPage';
import VendorManagementPage from './pages/VendorManagementPage';
import AssetTrackerPage from './pages/AssetTrackerPage';
import ReturnTrackerPage from './pages/ReturnTrackerPage';
import MonthlyVoucherTrackingPage from './pages/MonthlyVoucherTrackingPage';
import ReminderHistoryPage from './pages/ReminderHistoryPage';
import AdminLogsPage from './pages/AdminLogsPage';

import AppShell from './components/AppShell';

const SHOW_ADMIN_LOGS = import.meta.env.VITE_SHOW_ADMIN_LOGS === 'true';

const ProtectedRoute = ({ children, allowedRoles }) => {
    const { user, loading } = useAuth();
    const location = useLocation();

    if (loading) {
        return (
            <div className="flex items-center justify-center" style={{ minHeight: '100vh' }}>
                <div className="spinner"></div>
            </div>
        );
    }

    if (!user) {
        return <Navigate to="/login" />;
    }

    // Check if user must change password
    const mustChangePassword = localStorage.getItem('must_change_password') === 'true';
    const isChangePasswordPage = location.pathname === '/change-password';

    // If user must change password and is not already on change-password page, redirect
    if (mustChangePassword && !isChangePasswordPage) {
        return <Navigate to="/change-password" replace />;
    }

    // If user is on change-password page and must change password, allow access regardless of role
    if (isChangePasswordPage && mustChangePassword) {
        return children;
    }

    if (allowedRoles && !allowedRoles.includes(user.role)) {
        return <Navigate to="/" />;
    }

    return children;
};

const AppContent = () => {
    const { user, getToken } = useAuth();
    const location = useLocation();
    const screenStartRef = useRef(Date.now());
    const prevPathRef = useRef(location.pathname);

    useEffect(() => {
        if (!user) return;

        const token = getToken();
        if (!token) return;

        const logActivity = async (payload) => {
            try {
                await fetch('/api/users/activity', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                        'X-Device-ID': getDeviceId(),
                    },
                    body: JSON.stringify(payload),
                });
            } catch (error) {
                console.warn('Failed to log user activity:', error);
            }
        };

        const now = Date.now();
        const prevPath = prevPathRef.current;
        const spentMs = Math.max(0, now - screenStartRef.current);

        if (prevPath && prevPath !== location.pathname) {
            logActivity({
                eventName: 'screen.exit',
                module: 'frontend',
                screen: prevPath,
                durationMs: spentMs,
                metadata: { nextScreen: location.pathname },
            });
        }

        logActivity({
            eventName: 'screen.view',
            module: 'frontend',
            screen: location.pathname,
            metadata: { fromScreen: prevPath },
        });

        prevPathRef.current = location.pathname;
        screenStartRef.current = now;
    }, [location.pathname, user, getToken]);

    useEffect(() => {
        if (!user) return undefined;
        const token = getToken();
        if (!token) return undefined;

        const handleBeforeUnload = () => {
            const spentMs = Math.max(0, Date.now() - screenStartRef.current);
            fetch('/api/users/activity', {
                method: 'POST',
                keepalive: true,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'X-Device-ID': getDeviceId(),
                },
                body: JSON.stringify({
                    eventName: 'screen.exit',
                    module: 'frontend',
                    screen: prevPathRef.current,
                    durationMs: spentMs,
                    metadata: { reason: 'beforeunload' },
                }),
            }).catch(() => {});
        };

        globalThis.addEventListener('beforeunload', handleBeforeUnload);
        return () => globalThis.removeEventListener('beforeunload', handleBeforeUnload);
    }, [user, getToken]);

    return (
        <AppShell user={user}>
                    <Routes>
                        <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage />} />

                        <Route
                            path="/"
                            element={
                                <ProtectedRoute>
                                    <DashboardPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/upload"
                            element={
                                <ProtectedRoute allowedRoles={['initiator', 'user', 'admin']}>
                                    <VendorUploadPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/coordinator"
                            element={
                                <ProtectedRoute allowedRoles={['manager', 'admin', 'final_approver']}>
                                    <CoordinatorPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/assigned-invoices"
                            element={
                                <ProtectedRoute allowedRoles={['initiator', 'user', 'admin']}>
                                    <AssignedInvoicesPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/voucher"
                            element={
                                <ProtectedRoute>
                                    <VoucherRequestPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/create-voucher"
                            element={
                                <ProtectedRoute allowedRoles={['initiator', 'user', 'admin']}>
                                    <VoucherRequestPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/voucher-history"
                            element={
                                <ProtectedRoute>
                                    <VoucherHistoryPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/user-management"
                            element={
                                <ProtectedRoute allowedRoles={['admin']}>
                                    <UserManagementPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/customers"
                            element={
                                <ProtectedRoute allowedRoles={['admin', 'coordinator', 'manager']}>
                                    <CustomerManagementPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/projects"
                            element={
                                <ProtectedRoute allowedRoles={['admin', 'coordinator', 'manager']}>
                                    <ProjectManagementPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/letters/incoming"
                            element={
                                <ProtectedRoute allowedRoles={['admin', 'coordinator', 'manager']}>
                                    <IncomingLettersPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/letters/incoming/:id"
                            element={
                                <ProtectedRoute allowedRoles={['admin', 'coordinator', 'manager']}>
                                    <LetterDetailPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/letters/templates"
                            element={
                                <ProtectedRoute allowedRoles={['admin', 'coordinator', 'manager']}>
                                    <LetterTemplatesPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route path="/purchase-orders" element={
                            <ProtectedRoute allowedRoles={['admin', 'manager', 'coordinator']}>
                                <PurchaseOrderPage />
                            </ProtectedRoute>
                        } />

                        <Route path="/vendors" element={
                            <ProtectedRoute allowedRoles={['admin']}>
                                <VendorManagementPage />
                            </ProtectedRoute>
                        } />

                        <Route path="/assets" element={
                            <ProtectedRoute allowedRoles={['admin']}>
                                <AssetTrackerPage />
                            </ProtectedRoute>
                        } />

                        <Route path="/return-tracker" element={
                            <ProtectedRoute allowedRoles={['admin']}>
                                <ReturnTrackerPage />
                            </ProtectedRoute>
                        } />

                        <Route path="/reminder-history" element={
                            <ProtectedRoute allowedRoles={['admin']}>
                                <ReminderHistoryPage />
                            </ProtectedRoute>
                        } />

                        {SHOW_ADMIN_LOGS && (
                            <Route path="/admin-logs" element={
                                <ProtectedRoute allowedRoles={['admin']}>
                                    <AdminLogsPage />
                                </ProtectedRoute>
                            } />
                        )}

                        <Route path="/monthly-vouchers" element={
                            <ProtectedRoute allowedRoles={['admin', 'manager', 'coordinator', 'final_approver', 'initiator', 'user']}>
                                <MonthlyVoucherTrackingPage />
                            </ProtectedRoute>
                        } />



                        <Route
                            path="/change-password"
                            element={
                                <ProtectedRoute allowedRoles={['admin']}>
                                    <ChangePasswordPage />
                                </ProtectedRoute>
                            }
                        />

                    </Routes>
        </AppShell>
    );
};

function App() {
    return (
        <DialogProvider>
            <AuthProvider>
                <AppContent />
            </AuthProvider>
        </DialogProvider>
    );
}

export default App;
