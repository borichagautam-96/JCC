import React, { useState, useMemo, useRef } from 'react';
import {
    BookOpen, Download, Search, LogIn, FileText, Receipt,
    CheckCircle, Calendar, Building2, Users, Printer,
    AlertTriangle, Info, ChevronRight, FileCheck, ShieldCheck,
    KeyRound, Upload, Eye, BarChart3, Bell,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import './SOPPage.css';

// ─── SOP DATA ──────────────────────────────────────────────────────────────
const ALL_ROLES = ['admin', 'manager', 'coordinator', 'final_approver', 'initiator', 'user', 'vendor'];

const SECTIONS = [
    {
        id: 'login',
        icon: LogIn,
        iconBg: '#EFF6FF',
        iconColor: '#2563EB',
        label: '🔑 Login & Setup',
        title: 'Login & First-Time Setup',
        subtitle: 'How to sign in and complete your profile on first login',
        roles: ALL_ROLES,
        steps: [
            {
                title: 'Open the Application',
                desc: 'Open your browser and navigate to the InFloAI application URL provided by your administrator.',
            },
            {
                title: 'Enter Your Credentials',
                desc: 'Enter your PS Number (e.g. 12345678) or username in the first field, and your temporary password in the second field.',
            },
            {
                title: 'First-Time Profile Setup',
                desc: 'If this is your first login, you will be redirected to the "Complete Your Profile" page automatically.',
                tip: { type: 'info', text: 'You must complete your profile before accessing any other section of the application.' },
            },
            {
                title: 'Enter Your Full Name & Email',
                desc: 'Provide your full name and your official email address (e.g. name@larsentoubro.com), then click "Save and Continue".',
            },
            {
                title: 'Change Your Password',
                desc: 'After profile setup, navigate to your profile/settings and change your temporary password to a secure one you remember.',
                tip: { type: 'warning', text: 'Your password must be at least 8 characters and include uppercase, lowercase, and a number.' },
            },
        ],
    },
    {
        id: 'invoice',
        icon: Upload,
        iconBg: '#F0FDF4',
        iconColor: '#16A34A',
        label: '📄 Upload Invoice',
        title: 'Upload Invoice',
        subtitle: 'How to upload and submit an invoice for processing',
        roles: ['admin', 'initiator', 'user', 'vendor'],
        steps: [
            {
                title: 'Navigate to Upload Invoice',
                desc: 'Click "Upload Invoice" in the left sidebar navigation menu.',
            },
            {
                title: 'Select the Invoice File',
                desc: 'Click the upload area or drag-and-drop your invoice file (PDF, JPG, or PNG formats accepted).',
            },
            {
                title: 'Fill in Invoice Details',
                desc: 'Enter the invoice number, invoice date, vendor name, and amount. All fields marked with (*) are required.',
            },
            {
                title: 'Select the Purchase Order',
                desc: 'Choose the related Purchase Order (PO) from the dropdown. If no PO exists, contact your admin.',
                tip: { type: 'info', text: 'You can only submit invoices against approved Purchase Orders.' },
            },
            {
                title: 'Submit the Invoice',
                desc: 'Review all details and click "Submit Invoice". You will receive a confirmation with an invoice reference number.',
            },
            {
                title: 'Track Your Invoice',
                desc: 'Go to "Assigned Invoices" in the sidebar to track the status of your submitted invoices.',
            },
        ],
    },
    {
        id: 'voucher',
        icon: Receipt,
        iconBg: '#FFF7ED',
        iconColor: '#EA580C',
        label: '🧾 Create Voucher',
        title: 'Create a Voucher Request',
        subtitle: 'Step-by-step guide to creating and submitting a payment voucher',
        roles: ['admin', 'initiator', 'user'],
        steps: [
            {
                title: 'Go to Create Voucher',
                desc: 'Click "Create Voucher" in the left navigation sidebar.',
            },
            {
                title: 'Select Vendor & Project',
                desc: 'Choose the vendor from the dropdown and select the associated project or cost center.',
            },
            {
                title: 'Enter Voucher Details',
                desc: 'Fill in the payment amount, description, payment mode (NEFT/RTGS/Cheque), and narration.',
            },
            {
                title: 'Attach Supporting Documents',
                desc: 'Attach the invoice or supporting document by clicking the attachment icon. PDF format is preferred.',
                tip: { type: 'warning', text: 'Vouchers without supporting documents may be rejected by the approver.' },
            },
            {
                title: 'Submit for Approval',
                desc: 'Click "Submit for Approval". The voucher will be sent to your manager/approver automatically.',
            },
            {
                title: 'Track in Voucher History',
                desc: 'Open "Voucher History" from the sidebar to see the status: Pending, Approved, or Rejected.',
            },
        ],
    },
    {
        id: 'approval',
        icon: CheckCircle,
        iconBg: '#F0FDF4',
        iconColor: '#15803D',
        label: '✅ Approve / Reject',
        title: 'Approving or Rejecting Vouchers',
        subtitle: 'Guide for managers and approvers on the approval workflow',
        roles: ['admin', 'manager', 'final_approver', 'coordinator'],
        steps: [
            {
                title: 'Open Pending Approvals',
                desc: 'Click "Pending Approvals" in the left sidebar. You will see a list of all vouchers waiting for your review.',
            },
            {
                title: 'Review the Voucher',
                desc: 'Click on any voucher to open the detail view. Review the vendor, amount, narration, and attached documents carefully.',
            },
            {
                title: 'Verify the Supporting Document',
                desc: 'Open the attached invoice or document by clicking the attachment thumbnail to verify it matches the voucher details.',
                tip: { type: 'warning', text: 'Always verify the invoice date, amount, and vendor name before approving.' },
            },
            {
                title: 'Approve the Voucher',
                desc: 'If everything is correct, click the green "Approve" button. Add an optional comment if needed.',
            },
            {
                title: 'Reject the Voucher',
                desc: 'If something is incorrect, click "Reject" and provide a clear reason. The initiator will be notified automatically.',
                tip: { type: 'info', text: 'A rejection reason is mandatory so the initiator knows what to correct and resubmit.' },
            },
            {
                title: 'Multi-Level Approval',
                desc: 'Some vouchers require multi-level approval (Manager → Final Approver). After your approval, it will move to the next level automatically.',
            },
        ],
    },
    {
        id: 'monthly',
        icon: Calendar,
        iconBg: '#F5F3FF',
        iconColor: '#7C3AED',
        label: '📋 Monthly Vouchers',
        title: 'Monthly Voucher Tracking',
        subtitle: 'How to view and filter the monthly voucher summary report',
        roles: ALL_ROLES,
        steps: [
            {
                title: 'Navigate to Monthly Vouchers',
                desc: 'Click "Monthly Vouchers" from the sidebar navigation.',
            },
            {
                title: 'Select the Month & Year',
                desc: 'Use the month and year filter dropdowns at the top to select the reporting period.',
            },
            {
                title: 'Filter by Status',
                desc: 'Use the Status filter to narrow down to Approved, Pending, or Rejected vouchers for the selected month.',
            },
            {
                title: 'View Summary Totals',
                desc: 'The summary cards at the top show total vouchers, total amount, approved amount, and pending amount for the period.',
            },
            {
                title: 'Export to Excel',
                desc: 'Click the "Export" button to download the filtered voucher list as an Excel file for offline reporting.',
            },
        ],
    },
    {
        id: 'vendor',
        icon: Building2,
        iconBg: '#FFF1F2',
        iconColor: '#BE123C',
        label: '🏢 Vendor Management',
        title: 'Vendor & Customer Management',
        subtitle: 'How to add, edit, and manage vendors and customers (Admin)',
        roles: ['admin'],
        steps: [
            {
                title: 'Open Vendor Management',
                desc: 'In the Admin Section of the sidebar, click "Vendor Management".',
            },
            {
                title: 'Add a New Vendor',
                desc: 'Click the "+ Add Vendor" button. Fill in the vendor name, GSTIN, bank details, and contact information.',
            },
            {
                title: 'Upload Vendor List via Excel',
                desc: 'To bulk-add vendors, click "Bulk Upload" and download the Excel template. Fill it in and re-upload.',
                tip: { type: 'info', text: 'The Excel template format must not be changed. Only fill in the data rows.' },
            },
            {
                title: 'Edit Vendor Details',
                desc: 'Find the vendor in the list and click the "Edit" icon. Update the required fields and save.',
            },
            {
                title: 'Manage Customers',
                desc: 'Similarly, open "Customers" from the Admin Section to add or update customer records for PO management.',
            },
        ],
    },
    {
        id: 'users',
        icon: Users,
        iconBg: '#EFF6FF',
        iconColor: '#1D4ED8',
        label: '👥 User Management',
        title: 'User Management',
        subtitle: 'How to add users, manage device bindings, and handle passwords (Admin)',
        roles: ['admin'],
        steps: [
            {
                title: 'Open User Management',
                desc: 'From the Admin Section in the sidebar, click "User Management".',
            },
            {
                title: 'Add a New User',
                desc: 'Click "+ Add New User". Enter the PS Number, full name, email, temporary password, and assign a role.',
                tip: { type: 'info', text: 'The user will be prompted to complete their profile and change their password on first login.' },
            },
            {
                title: 'Assign the Correct Role',
                desc: 'Choose the right role for the user: Initiator/User (submits vouchers), Manager (approves), Final Approver, Coordinator, or Admin.',
            },
            {
                title: 'Unbind a Device',
                desc: 'If a user changes their device or browser, click "Unbind" next to their name. They will be able to log in from a new device.',
                tip: { type: 'warning', text: 'Unbinding also terminates the user\'s current active session immediately.' },
            },
            {
                title: 'Reset User Password',
                desc: 'Open the Edit modal for a user and enter a new temporary password. The user will be required to change it on next login.',
            },
            {
                title: 'Delete a User',
                desc: 'Click "Delete" next to the user. This action is permanent. You cannot delete the last admin account.',
            },
        ],
    },
    {
        id: 'security',
        icon: ShieldCheck,
        iconBg: '#F0FDF4',
        iconColor: '#15803D',
        label: '🔒 Security Tips',
        title: 'Security Best Practices',
        subtitle: 'Important security guidelines for all users',
        roles: ALL_ROLES,
        steps: [
            {
                title: 'Never Share Your Password',
                desc: 'Your PS Number and password are personal. Never share them with colleagues, managers, or IT staff over phone or email.',
                tip: { type: 'warning', text: 'InFloAI administrators will NEVER ask for your password.' },
            },
            {
                title: 'Log Out When Not in Use',
                desc: 'Always click the "Logout" button at the bottom of the sidebar when leaving your workstation or finishing your session.',
            },
            {
                title: 'Device Binding',
                desc: 'Your account is bound to a specific browser/device on first login. Do not log in from unauthorized devices.',
            },
            {
                title: 'Session Expiry',
                desc: 'Sessions automatically expire after the configured timeout period (default: 8 hours). You will be redirected to login automatically.',
            },
            {
                title: 'Report Suspicious Activity',
                desc: 'If you notice unauthorized access, unknown vouchers, or unusual activity, contact your system administrator immediately.',
                tip: { type: 'warning', text: 'Report issues to your administrator without delay to prevent unauthorized transactions.' },
            },
        ],
    },
];

// ─── ROLE DISPLAY MAP ───────────────────────────────────────────────────────
const ROLE_COLORS = {
    admin: { bg: '#DBEAFE', color: '#1E40AF' },
    manager: { bg: '#FEF3C7', color: '#92400E' },
    final_approver: { bg: '#F3E8FF', color: '#6B21A8' },
    coordinator: { bg: '#E0F2FE', color: '#0369A1' },
    initiator: { bg: '#DCFCE7', color: '#15803D' },
    user: { bg: '#F3F4F6', color: 'var(--text-body)' },
    vendor: { bg: '#FFF1F2', color: '#BE123C' },
};

// ─── HELPERS ────────────────────────────────────────────────────────────────
const Tip = ({ type, text }) => (
    <div className={type === 'warning' ? 'sop-tip' : 'sop-info'}>
        {type === 'warning'
            ? <AlertTriangle size={15} color="#92400E" style={{ flexShrink: 0, marginTop: 1 }} />
            : <Info size={15} color="#1E40AF" style={{ flexShrink: 0, marginTop: 1 }} />
        }
        <p>{text}</p>
    </div>
);

const StepCard = ({ num, title, desc, tip }) => (
    <div className="sop-step">
        <div className="sop-step-num">{num}</div>
        <div className="sop-step-body">
            <h4>{title}</h4>
            <p>{desc}</p>
            {tip && <Tip type={tip.type} text={tip.text} />}
        </div>
    </div>
);

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
const SOPPage = () => {
    const { user } = useAuth();
    const [activeTab, setActiveTab] = useState('login');
    const [search, setSearch] = useState('');
    const [exporting, setExporting] = useState(false);
    const contentRef = useRef(null);

    // Filter sections by user's role
    const visibleSections = useMemo(() =>
        SECTIONS.filter(s => s.roles.includes(user?.role)),
        [user?.role]
    );

    // Active section for tab view
    const activeSection = visibleSections.find(s => s.id === activeTab) || visibleSections[0];

    // Search across all visible sections
    const searchResults = useMemo(() => {
        if (!search.trim()) return null;
        const q = search.toLowerCase();
        return visibleSections.map(section => ({
            ...section,
            steps: section.steps.filter(step =>
                step.title.toLowerCase().includes(q) ||
                step.desc.toLowerCase().includes(q) ||
                (step.tip?.text || '').toLowerCase().includes(q)
            ),
        })).filter(s => s.steps.length > 0);
    }, [search, visibleSections]);

    // ── PDF Export ──────────────────────────────────────────────────────────
    const handleExport = async () => {
        setExporting(true);
        try {
            const html2pdf = (await import('html2pdf.js')).default;

            const today = new Date().toLocaleDateString('en-IN', {
                day: '2-digit', month: 'long', year: 'numeric'
            });

            const sectionsToExport = search.trim() && searchResults
                ? searchResults
                : visibleSections;

            // Build PDF HTML
            const pdfHTML = `
                <div id="sop-pdf-root" style="font-family: Arial, sans-serif; color: #0F172A;">
                    <div class="sop-pdf-cover" style="background: linear-gradient(135deg, #1E3A5F, #0066CC); color: white; padding: 2.5rem 2rem; margin-bottom: 1rem;">
                        <div style="font-size:0.8rem; opacity:0.7; margin-bottom:0.5rem; text-transform:uppercase; letter-spacing:0.1em;">InFloAI</div>
                        <h1 style="font-size:1.8rem; font-weight:800; margin: 0 0 0.4rem 0;">Standard Operating Procedure</h1>
                        <p style="opacity:0.75; margin:0; font-size:0.9rem;">Generated on ${today} &nbsp;|&nbsp; Role: ${(user?.name || 'User')} (${user?.role || ''})</p>
                    </div>
                    ${sectionsToExport.map(section => `
                        <div class="sop-pdf-section" style="padding: 1.25rem 2rem; page-break-inside: avoid; border-bottom: 1px solid #E2E8F0;">
                            <h2 style="font-size: 1.05rem; color: #0066CC; margin: 0 0 0.75rem 0; padding-bottom: 0.4rem; border-bottom: 2px solid #BFDBFE;">${section.title}</h2>
                            <p style="font-size: 0.82rem; color: #64748B; margin: 0 0 0.9rem 0;">${section.subtitle}</p>
                            ${section.steps.map((step, i) => `
                                <div style="display:flex; gap:0.75rem; margin-bottom:0.65rem; align-items:flex-start;">
                                    <div style="width:22px; height:22px; border-radius:50%; background:#0066CC; color:white; font-size:0.72rem; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:2px;">${i + 1}</div>
                                    <div>
                                        <strong style="display:block; font-size:0.87rem; color:#1E293B; margin-bottom:0.12rem;">${step.title}</strong>
                                        <span style="font-size:0.81rem; color:#475569; line-height:1.5;">${step.desc}</span>
                                        ${step.tip ? `<div style="background:${step.tip.type === 'warning' ? '#FFFBEB' : '#EFF6FF'}; border-left:3px solid ${step.tip.type === 'warning' ? '#F59E0B' : '#3B82F6'}; padding:0.4rem 0.6rem; margin-top:0.4rem; border-radius:0 4px 4px 0; font-size:0.78rem; color:${step.tip.type === 'warning' ? '#92400E' : '#1E40AF'};">⚠ ${step.tip.text}</div>` : ''}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    `).join('')}
                    <div style="text-align:center; padding:1rem; font-size:0.75rem; color:#94A3B8; border-top: 1px solid #E2E8F0;">
                        InFloAI — Confidential Internal Document — ${today}
                    </div>
                </div>
            `;

            const container = document.createElement('div');
            container.innerHTML = pdfHTML;
            document.body.appendChild(container);

            await html2pdf()
                .set({
                    margin: [10, 10, 15, 10],
                    filename: `InFloAI_SOP_${new Date().toISOString().slice(0, 10)}.pdf`,
                    image: { type: 'jpeg', quality: 0.95 },
                    html2canvas: { scale: 2, useCORS: true },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                    pagebreak: { mode: 'avoid-all' },
                })
                .from(container)
                .save();

            document.body.removeChild(container);
        } catch (err) {
            console.error('PDF export failed:', err);
            alert('PDF export failed. Please try again.');
        } finally {
            setExporting(false);
        }
    };

    // ── Render ──────────────────────────────────────────────────────────────
    const renderSection = (section) => {
        const Icon = section.icon;
        return (
            <div className="sop-section" key={section.id}>
                <div className="sop-section-header">
                    <div className="sop-section-icon" style={{ background: section.iconBg }}>
                        <Icon size={19} color={section.iconColor} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <h2>{section.title}</h2>
                        <p>{section.subtitle}</p>
                    </div>
                    <span
                        className="sop-role-badge"
                        style={{
                            background: section.roles.length === ALL_ROLES.length ? '#F0FDF4' : '#EFF6FF',
                            color: section.roles.length === ALL_ROLES.length ? '#15803D' : '#1D4ED8',
                        }}
                    >
                        {section.roles.length === ALL_ROLES.length ? 'All Roles' : section.roles.map(r => r.replace('_', ' ')).join(', ')}
                    </span>
                </div>
                <div className="sop-steps">
                    {section.steps.map((step, i) => (
                        <StepCard
                            key={i}
                            num={i + 1}
                            title={step.title}
                            desc={step.desc}
                            tip={step.tip}
                        />
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className="sop-shell fade-in">
            {/* Header */}
            <div className="sop-header">
                <div className="sop-header-left">
                    <div className="sop-header-badge">
                        <BookOpen size={13} />
                        Standard Operating Procedure
                    </div>
                    <h1>InFloAI Help & SOP</h1>
                    <p>Step-by-step procedures for all application modules</p>
                </div>
                <button
                    className="sop-export-btn"
                    onClick={handleExport}
                    disabled={exporting}
                >
                    {exporting ? (
                        <>
                            <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2, borderColor: '#0066CC', borderTopColor: 'transparent' }} />
                            Exporting…
                        </>
                    ) : (
                        <>
                            <Download size={16} />
                            Export PDF
                        </>
                    )}
                </button>
            </div>

            {/* Search */}
            <div className="sop-search-bar">
                <div className="sop-search-wrap">
                    <Search size={16} />
                    <input
                        className="sop-search-input"
                        type="text"
                        placeholder="Search procedures, steps, or keywords…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                </div>
                {search && (
                    <button
                        onClick={() => setSearch('')}
                        style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}
                    >
                        Clear
                    </button>
                )}
            </div>

            {/* Main layout */}
            <div className="sop-layout">
                {/* Sidebar Tabs — hidden during search */}
                {!search && (
                    <div className="sop-tabs">
                        <div className="sop-tabs-title">Sections</div>
                        {visibleSections.map(section => {
                            const Icon = section.icon;
                            return (
                                <button
                                    key={section.id}
                                    className={`sop-tab-btn ${activeTab === section.id ? 'active' : ''}`}
                                    onClick={() => setActiveTab(section.id)}
                                >
                                    <Icon size={15} />
                                    {section.label}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Content */}
                <div className="sop-content" ref={contentRef} style={search ? { gridColumn: '1 / -1' } : {}}>
                    {search ? (
                        searchResults && searchResults.length > 0 ? (
                            searchResults.map(renderSection)
                        ) : (
                            <div className="sop-empty">
                                <Search size={48} />
                                <h3>No results found</h3>
                                <p>Try a different keyword or clear the search to browse all sections.</p>
                            </div>
                        )
                    ) : (
                        activeSection && renderSection(activeSection)
                    )}
                </div>
            </div>
        </div>
    );
};

export default SOPPage;
