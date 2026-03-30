import React from 'react';
import { useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import Navbar from './Navbar';
import NotificationBell from './NotificationBell';

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
  '/change-password': 'Change Password',
  '/user-management': 'User Management',
  '/admin-logs': 'Admin Logs',
  '/customers': 'Customers',
  '/projects': 'Projects',
  '/letters/incoming': 'Incoming Letters',
  '/letters/templates': 'Letter Templates',
};

const resolvePageTitle = (pathname) => {
  if (pageTitleMap[pathname]) return pageTitleMap[pathname];
  if (pathname.startsWith('/letters/incoming/')) return 'Letter Detail';
  return 'C2C';
};

const AppShell = ({ user, children }) => {
  const location = useLocation();
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(true);

  if (!user) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Navbar isOpen={isSidebarOpen} toggleSidebar={() => setIsSidebarOpen((prev) => !prev)} />

      <div className={`transition-all duration-300 ${isSidebarOpen ? 'md:ml-72' : 'md:ml-0'}`}>
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
          <NotificationBell />
        </header>

        <main className="min-h-[calc(100vh-4rem)]">{children}</main>
      </div>
    </div>
  );
};

export default AppShell;
