import React from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
    LayoutDashboard,
    Upload,
    FileText,
    PlusSquare,
    History,
    Laptop,
    RefreshCcw,
    BellRing,
    CheckSquare,
    Users,
    ReceiptText,
    Building2,
    KeyRound,
    Activity,
    LogOut,
} from 'lucide-react';

const SHOW_ADMIN_LOGS = import.meta.env.VITE_SHOW_ADMIN_LOGS === 'true';

const Navbar = ({ isOpen }) => {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    const isActive = (path) => location.pathname === path;

    const navClass = (active) =>
        `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${active
            ? 'bg-blue-50 text-blue-700'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`;

    return (
        <aside
            className={`fixed left-0 top-0 z-40 flex h-screen w-72 flex-col border-r border-slate-200 bg-white transition-transform duration-300 ${isOpen ? 'translate-x-0' : '-translate-x-full'
                }`}
        >

            <div className="flex-column items-center justify-between border-b border-slate-200 px-5 pt-4">
                <div className='flex items-center justify-between'>
                    <div className="flex items-center gap-3">
                        <img src="/infloai-mark.svg" alt="InFloAI logo" className="h-9 w-9 rounded-xl" />
                        <h2 className="m-0 text-xl font-semibold tracking-tight text-slate-900">InFloAI</h2>
                    </div>
                </div>
                <h2 className="mt-3 text-xs font-semibold tracking-tight text-blue-600">Developed by Development Team(D&T)</h2>
            </div>

            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
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
                        <span>Create Voucher</span>
                    </Link>
                )}

                <Link to="/voucher-history" className={navClass(isActive('/voucher-history'))}>
                    <History size={18} />
                    <span>Voucher History</span>
                </Link>

                {(user?.role === 'admin') && (
                    <>
                        <Link to="/assets" className={navClass(isActive('/assets'))}>
                            <Laptop size={18} />
                            <span>Asset Tracker</span>
                        </Link>
                        <Link to="/return-tracker" className={navClass(isActive('/return-tracker'))}>
                            <RefreshCcw size={18} />
                            <span>Asset Management</span>
                        </Link>
                        <Link to="/reminder-history" className={navClass(isActive('/reminder-history'))}>
                            <BellRing size={18} />
                            <span>Reminder History</span>
                        </Link>
                    </>
                )}

                {(['admin', 'manager', 'coordinator', 'final_approver', 'initiator', 'user'].includes(user?.role)) && (
                    <Link to="/monthly-vouchers" className={navClass(isActive('/monthly-vouchers'))}>
                        <ReceiptText size={18} />
                        <span>Monthly Vouchers</span>
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

                        <Link to="/change-password" className={navClass(isActive('/change-password'))}>
                            <KeyRound size={18} />
                            <span>Change Password</span>
                        </Link>

                        <Link to="/user-management" className={navClass(isActive('/user-management'))}>
                            <Users size={18} />
                            <span>User Management</span>
                        </Link>

                        {SHOW_ADMIN_LOGS && (
                            <Link to="/admin-logs" className={navClass(isActive('/admin-logs'))}>
                                <Activity size={18} />
                                <span>Admin Logs</span>
                            </Link>
                        )}
                    </>
                )}
            </nav>

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

                <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-600"
                >
                    <LogOut size={16} />
                    <span>Logout</span>
                </button>
            </div>
        </aside>
    );
};

export default Navbar;


