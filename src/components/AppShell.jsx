import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, MessageSquarePlus } from 'lucide-react';
import Navbar from './Navbar';
import NotificationBell from './NotificationBell';

const SHOW_ADMIN_LOGS = import.meta.env.VITE_SHOW_ADMIN_LOGS === 'true';
const ENABLE_FEEDBACK_MODULE = import.meta.env.VITE_ENABLE_FEEDBACK === 'true';

const pageTitleMap = {
  '/': 'Dashboard',
  '/upload': 'Upload Invoice',
  '/assigned-invoices': 'Assigned Invoices',
  '/create-voucher': 'Create Voucher',
  '/voucher-history': 'Voucher History',
  '/assets': 'Asset Tracker',
  '/return-tracker': 'Asset Management',
  '/coordinator': 'Pending Approvals',
  '/purchase-orders': 'PO Management',
  '/vendors': 'Vendor Management',
  '/feedback': 'Feedback',
  '/admin-feedback': 'Feedback Inbox',
  '/change-password': 'Change Password',
  '/user-management': 'User Management',
  '/admin-logs': 'Admin Logs',
  '/customers': 'Customers',
  '/projects': 'Projects',
  '/letters/incoming': 'Incoming Letters',
  '/letters/templates': 'Letter Templates',
};

const resolvePageTitle = (pathname) => {
  if (!SHOW_ADMIN_LOGS && pathname === '/admin-logs') return 'Dashboard';
  if (!ENABLE_FEEDBACK_MODULE && (pathname === '/feedback' || pathname === '/admin-feedback')) return 'Dashboard';
  if (pageTitleMap[pathname]) return pageTitleMap[pathname];
  if (pathname.startsWith('/letters/incoming/')) return 'Letter Detail';
  return 'InFloAI';
};

const AppShell = ({ user, children }) => {
  const location = useLocation();
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(true);

  const globalFooter = (
    <footer className="">
      
    </footer>
  );

  if (!user) {
    return (
      <div className="app-global-layout">
        <div className="app-global-content">{children}</div>
        {globalFooter}
      </div>
    );
  }

  return (
    <div className="app-global-layout min-h-screen bg-slate-50 text-slate-900">
      <Navbar isOpen={isSidebarOpen} />

      <div className={`app-global-content transition-all duration-300 ${isSidebarOpen ? 'md:ml-72' : 'md:ml-0'}`}>
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 md:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsSidebarOpen((prev) => !prev)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100"
              aria-label="Toggle sidebar"
            >
              <Menu size={18} />
            </button>
            <div>
              <h1 className="m-0 text-base font-semibold text-slate-900 md:text-lg">
                {resolvePageTitle(location.pathname)}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {ENABLE_FEEDBACK_MODULE && (
              <Link
                to="/feedback"
                state={{ sourcePath: location.pathname }}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                <MessageSquarePlus size={16} />
                <span className="hidden md:inline">Feedback</span>
              </Link>
            )}
            <NotificationBell />
          </div>
        </header>

        <main className="min-h-[calc(100vh-4rem)]">{children}</main>
      </div>

      {globalFooter}
    </div>
  );
};

export default AppShell;
