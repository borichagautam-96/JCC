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
import JobCreationPage from './pages/JobCreationPage';
import JobHistoryPage from './pages/JobHistoryPage';
import PrintCoordinatorPage from './pages/PrintCoordinatorPage';
import PrintOperatorPage from './pages/PrintOperatorPage';
import PrintReportsPage from './pages/PrintReportsPage';
import PrintLogsPage from './pages/PrintLogsPage';
import LocationManagementPage from './pages/LocationManagementPage';
import HubPage from './pages/HubPage';
import TrackClaimsPage from './pages/TrackClaimsPage';
import UserManagementPage from './pages/UserManagementPage';
import CompleteProfilePage from './pages/CompleteProfilePage';
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
import AdminLogsPage from './pages/AdminLogsPage';
import FeedbackPage from './pages/FeedbackPage';
import AdminFeedbackPage from './pages/AdminFeedbackPage';
import SOPPage from './pages/SOPPage';
import ApprovalLinkPage from './pages/ApprovalLinkPage';
import PrintingCostPage from './pages/PrintingCostPage';

import AppShell from './components/AppShell';

const SHOW_ADMIN_LOGS = import.meta.env.VITE_SHOW_ADMIN_LOGS === 'true';
const ENABLE_ASSET_MODULE = import.meta.env.VITE_ENABLE_ASSET_MODULE === 'true';
const ENABLE_FEEDBACK_MODULE = import.meta.env.VITE_ENABLE_FEEDBACK === 'true';

const ProtectedRoute = ({ children, allowedRoles, requireFlag, requireAnyFlag, allowAdmin = false }) => {
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

    const isCompleteProfilePage = location.pathname === '/complete-profile';
    const isProfileCompleted = Number(user?.profile_completed ?? 0) === 1;

    if (!isProfileCompleted && !isCompleteProfilePage) {
        return <Navigate to="/complete-profile" replace />;
    }

    if (isCompleteProfilePage && isProfileCompleted) {
        return <Navigate to="/hub" replace />;
    }

    if (allowedRoles && !allowedRoles.includes(user.role)) {
        return <Navigate to="/" />;
    }

    // Printing-module screens are gated on the module flag, not the JCC role.
    // Hiding a sidebar link is not access control — without this, any signed-in
    // user could reach /print-coordinator by typing the URL.
    // `allowAdmin` is for screens the API already serves to an admin — the rate master
    // and cost annexures. Without it the flag check locks an admin out of a page the
    // server would happily return, which is a dead end rather than a policy.
    // Operational queues (Coordinator, Operator) deliberately do NOT set it: those
    // belong to whoever holds the module flag, admin or not.
    // requireAnyFlag: the screen belongs to more than one printing role — costing is
    // read and corrected by coordinators and operators alike.
    const anyFlagOk = !requireAnyFlag || requireAnyFlag.some((f) => Number(user?.[f]) === 1);
    const flagOk = ((!requireFlag || Number(user?.[requireFlag]) === 1) && anyFlagOk)
        || (allowAdmin && user.role === 'admin');
    if (!flagOk) {
        return <Navigate to="/hub" replace />;
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
        if (Number(user?.profile_completed ?? 1) !== 1) return;

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
        if (Number(user?.profile_completed ?? 1) !== 1) return undefined;
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
                        <Route
                            path="/login"
                            element={user ? <Navigate to={Number(user?.profile_completed ?? 0) === 1 ? "/hub" : "/complete-profile"} replace /> : <LoginPage />}
                        />

                        {/* One-click approval from an email. Public on purpose: the signed
                            token in the URL is the credential, and the approver is usually
                            coming straight from their mail client with no portal session. */}
                        <Route path="/approve/:token" element={<ApprovalLinkPage />} />

                        <Route
                            path="/complete-profile"
                            element={
                                <ProtectedRoute>
                                    <CompleteProfilePage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/hub"
                            element={
                                <ProtectedRoute>
                                    <HubPage />
                                </ProtectedRoute>
                            }
                        />

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
                                <ProtectedRoute allowedRoles={['initiator', 'user', 'admin']}>
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
                            path="/job-creation"
                            element={
                                <ProtectedRoute allowedRoles={['initiator', 'user', 'admin']}>
                                    <JobCreationPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/job-history"
                            element={
                                <ProtectedRoute allowedRoles={['initiator', 'user', 'admin']}>
                                    <JobHistoryPage />
                                </ProtectedRoute>
                            }
                        />

                        {/* Printing screens are gated on the module flags (is_printer_coordinator /
                            is_printer_operator), not the JCC role. The guard is here as well as on
                            the server: hiding a sidebar link never stopped anyone typing the URL. */}
                        <Route
                            path="/print-coordinator"
                            element={
                                <ProtectedRoute requireFlag="is_printer_coordinator">
                                    <PrintCoordinatorPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/print-operator"
                            element={
                                <ProtectedRoute requireFlag="is_printer_operator">
                                    <PrintOperatorPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/print-cost"
                            element={
                                <ProtectedRoute requireAnyFlag={['is_printer_coordinator', 'is_printer_operator']} allowAdmin>
                                    <PrintingCostPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/print-reports"
                            element={
                                <ProtectedRoute requireFlag="is_printer_coordinator">
                                    <PrintReportsPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/print-logs"
                            element={
                                <ProtectedRoute requireFlag="is_printer_coordinator">
                                    <PrintLogsPage />
                                </ProtectedRoute>
                            }
                        />

                        <Route
                            path="/track-claims"
                            element={
                                <ProtectedRoute>
                                    <TrackClaimsPage />
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

                        <Route path="/locations" element={
                            <ProtectedRoute allowedRoles={['admin']}>
                                <LocationManagementPage />
                            </ProtectedRoute>
                        } />

                        <Route path="/assets" element={
                            ENABLE_ASSET_MODULE ? (
                                <ProtectedRoute allowedRoles={['admin']}>
                                    <AssetTrackerPage />
                                </ProtectedRoute>
                            ) : (
                                <Navigate to="/" replace />
                            )
                        } />

                        <Route path="/return-tracker" element={
                            ENABLE_ASSET_MODULE ? (
                                <ProtectedRoute allowedRoles={['admin']}>
                                    <ReturnTrackerPage />
                                </ProtectedRoute>
                            ) : (
                                <Navigate to="/" replace />
                            )
                        } />

                        <Route path="/feedback" element={
                            ENABLE_FEEDBACK_MODULE ? (
                                <ProtectedRoute>
                                    <FeedbackPage />
                                </ProtectedRoute>
                            ) : (
                                <Navigate to="/" replace />
                            )
                        } />

                        <Route path="/admin-feedback" element={
                            ENABLE_FEEDBACK_MODULE ? (
                                <ProtectedRoute allowedRoles={['admin']}>
                                    <AdminFeedbackPage />
                                </ProtectedRoute>
                            ) : (
                                <Navigate to="/" replace />
                            )
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

                        <Route path="/sop" element={
                            <ProtectedRoute>
                                <SOPPage />
                            </ProtectedRoute>
                        } />
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
