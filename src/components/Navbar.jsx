import React from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import LogoutButton from './LogoutButton';
import { LayoutDashboard, Upload, FileText, PlusSquare, History, Laptop, RefreshCcw, BellRing, CheckSquare, Users, ReceiptText, Building2, MessageSquareText, Activity, LogOut, BookOpen, Printer, Home, BarChart3, MapPin, Receipt } from 'lucide-react';

const SHOW_ADMIN_LOGS = import.meta.env.VITE_SHOW_ADMIN_LOGS === 'true';
const ENABLE_ASSET_MODULE = import.meta.env.VITE_ENABLE_ASSET_MODULE === 'true';
const ENABLE_FEEDBACK_MODULE = import.meta.env.VITE_ENABLE_FEEDBACK === 'true';

const Navbar = ({ isOpen, onOpenTeam }) => {
    const { user } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const isActive = (path) => location.pathname === path;

    // Which module are we in? Printing paths get the printing sidebar; everything
    // else gets the JCC sidebar. This keeps the two sections visually separate.
    const isPrinting = location.pathname.startsWith('/job-') || location.pathname.startsWith('/print-');
    // Printing capability comes from the module flags only. A JCC role — admin
    // included — does not imply it; an admin who needs these screens grants
    // themselves the flag in User Management.
    const isOperator = Number(user?.is_printer_operator) === 1;
    const isPrintCoordinator = Number(user?.is_printer_coordinator) === 1;
    // Rates and cost annexures are finance-adjacent rather than an operational queue,
    // and the API (canViewRates) already answers an admin. Mirror that here so the
    // link isn't hidden from someone the server would serve. Deliberately narrower
    // than the coordinator queues, which stay on the module flag alone.
    // Operators reach it as well: they correct cost annexures against the card.
    const canViewRates = isPrintCoordinator || isOperator || user?.role === 'admin';
    const canRequestPrint = ['initiator', 'user', 'admin'].includes(user?.role);

    const navClass = (active) =>
        `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${active
            ? 'bg-blue-50 text-blue-700'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`;

    return (
        <aside
            className={`app-sidebar ${isOpen ? 'is-open' : ''} fixed left-0 top-0 z-40 flex h-screen w-72 flex-col border-r border-slate-200 bg-white`}
        >

            <div className="flex-column items-center justify-between border-b border-slate-200 px-5 pt-4">
                <div className='flex items-center justify-between'>
                    <div className="flex items-center gap-3">
                        <img src="/infloai-mark.svg" alt="InFloAI logo" className="h-9 w-9 rounded-xl" />
                        <h2 className="m-0 text-xl font-semibold tracking-tight text-slate-900">InFloAI</h2>
                    </div>
                </div>
                {onOpenTeam ? (
                    <button
                        type="button"
                        className="mt-3 text-xs font-semibold tracking-tight text-blue-600 transition hover:text-blue-700"
                        onClick={onOpenTeam}
                    >
                        Developed by Development Team (D&T)
                    </button>
                ) : (
                    <h2 className="mt-3 text-xs font-semibold tracking-tight text-blue-600">Developed by Development Team (D&T)</h2>
                )}
            </div>

            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
                <Link to="/hub" className={navClass(isActive('/hub'))}>
                    <Home size={18} />
                    <span>Home / Switch Module</span>
                </Link>

                {isPrinting ? (
                    <>
                        <div className="mt-3 border-t border-slate-200 pt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                            Printing
                        </div>
                        {canRequestPrint && (
                            <>
                                <Link to="/job-history" className={navClass(isActive('/job-history'))}>
                                    <Printer size={18} />
                                    <span>My Printing Jobs</span>
                                </Link>
                                <Link to="/job-creation" className={navClass(isActive('/job-creation'))}>
                                    <PlusSquare size={18} />
                                    <span>New Printing Job</span>
                                </Link>
                            </>
                        )}
                        {/* Sits directly under New Printing Job as requested, but gated on the
                            coordinator flag: rate cards and cross-department spend are not for
                            every requestor. */}
                        {canViewRates && (
                            <Link to="/print-cost" className={navClass(isActive('/print-cost'))}>
                                <Receipt size={18} />
                                <span>Printing Cost</span>
                            </Link>
                        )}
                        {isPrintCoordinator && (
                            <Link to="/print-coordinator" className={navClass(isActive('/print-coordinator'))}>
                                <CheckSquare size={18} />
                                <span>Coordinator</span>
                            </Link>
                        )}
                        {isPrintCoordinator && (
                            <Link to="/print-reports" className={navClass(isActive('/print-reports'))}>
                                <BarChart3 size={18} />
                                <span>Reports</span>
                            </Link>
                        )}
                        {isPrintCoordinator && (
                            <Link to="/print-logs" className={navClass(isActive('/print-logs'))}>
                                <Activity size={18} />
                                <span>Activity Log</span>
                            </Link>
                        )}
                        {isOperator && (
                            <Link to="/print-operator" className={navClass(isActive('/print-operator'))}>
                                <Printer size={18} />
                                <span>Operator</span>
                            </Link>
                        )}
                    </>
                ) : (
                <>
                <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                    JCC
                </div>
                <Link to="/" className={navClass(isActive('/'))}>
                    <LayoutDashboard size={18} />
                    <span>Dashboard</span>
                </Link>

                {(user?.role === 'vendor' || user?.role === 'admin' || user?.role === 'initiator' || user?.role === 'user') && (
                    <Link to="/upload" className={navClass(isActive('/upload'))}>
                        <Upload size={18} />
                        <span>Upload Invoice</span>
                    </Link>
                )}

                {(['initiator', 'user', 'admin'].includes(user?.role)) && (
                    <Link to="/assigned-invoices" className={navClass(isActive('/assigned-invoices'))}>
                        <FileText size={18} />
                        <span>Assigned Invoices</span>
                    </Link>
                )}

                {(user?.role === 'initiator' || user?.role === 'user' || user?.role === 'admin') && (
                    <Link to="/create-voucher" className={navClass(isActive('/create-voucher'))}>
                        <PlusSquare size={18} />
                        <span>Create Request</span>
                    </Link>
                )}

                <Link to="/voucher-history" className={navClass(isActive('/voucher-history'))}>
                    <History size={18} />
                    <span>Claim History</span>
                </Link>

                <Link to="/track-claims" className={navClass(isActive('/track-claims'))}>
                    <Activity size={18} />
                    <span>Track Claims</span>
                </Link>

                {(user?.role === 'admin') && (
                    <>
                        {ENABLE_ASSET_MODULE && (
                            <>
                                <Link to="/assets" className={navClass(isActive('/assets'))}>
                                    <Laptop size={18} />
                                    <span>Asset Tracker</span>
                                </Link>
                                <Link to="/return-tracker" className={navClass(isActive('/return-tracker'))}>
                                    <RefreshCcw size={18} />
                                    <span>Asset Management</span>
                                </Link>
                            </>
                        )}
                    </>
                )}

                {(['admin', 'manager', 'coordinator', 'final_approver', 'initiator', 'user'].includes(user?.role)) && (
                    <Link to="/monthly-vouchers" className={navClass(isActive('/monthly-vouchers'))}>
                        <ReceiptText size={18} />
                        <span>Monthly Claims</span>
                    </Link>
                )}

                {(user?.role === 'manager' || user?.role === 'final_approver') && (
                    <Link to="/coordinator" className={navClass(isActive('/coordinator'))}>
                        <CheckSquare size={18} />
                        <span>Pending Approvals</span>
                    </Link>
                )}

                {user?.role === 'admin' && (
                    <>
                        <div className="mt-5 border-t border-slate-200 pt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                            Admin Section
                        </div>

                        <Link to="/purchase-orders" className={navClass(isActive('/purchase-orders'))}>
                            <ReceiptText size={18} />
                            <span>PO Management</span>
                        </Link>

                        <Link to="/vendors" className={navClass(isActive('/vendors'))}>
                            <Building2 size={18} />
                            <span>Vendor Management</span>
                        </Link>

                        <Link to="/locations" className={navClass(isActive('/locations'))}>
                            <MapPin size={18} />
                            <span>Location Management</span>
                        </Link>

                        <Link to="/user-management" className={navClass(isActive('/user-management'))}>
                            <Users size={18} />
                            <span>User Management</span>
                        </Link>

                        {ENABLE_FEEDBACK_MODULE && (
                            <Link to="/admin-feedback" className={navClass(isActive('/admin-feedback'))}>
                                <MessageSquareText size={18} />
                                <span>Feedback Inbox</span>
                            </Link>
                        )}

                        {SHOW_ADMIN_LOGS && (
                            <Link to="/admin-logs" className={navClass(isActive('/admin-logs'))}>
                                <Activity size={18} />
                                <span>Admin Logs</span>
                            </Link>
                        )}
                    </>
                )}
                </>
                )}
            </nav>

            {/* SOP / Help link is hidden for now.
                It pointed at a single /sop page regardless of module, so opening it
                from Printing dropped the user into the JCC sidebar. To restore it,
                re-add this block with module-aware targets — e.g. /sop for JCC and
                /printing-sop for Printing — using the same `isPrinting` check the
                nav above uses. The route and SOPPage component are left intact.
            <div className="px-3 pb-2">
                <Link to="/sop" className={navClass(isActive('/sop'))}>
                    <BookOpen size={18} />
                    <span>Help &amp; SOP</span>
                </Link>
            </div>
            */}

            <div className="border-t border-slate-200 p-4">
                <div className="mb-3 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
                        {user?.name?.charAt(0)?.toUpperCase() || 'A'}
                    </div>
                    <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{user?.name || 'Admin'}</p>
                        <p className="text-xs capitalize text-slate-500">{user?.role || 'Admin'}</p>
                    </div>
                </div>

                <LogoutButton className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-semibold text-white" />
            </div>
        </aside>
    );
};

export default Navbar;


