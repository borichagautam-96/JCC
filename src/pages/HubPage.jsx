import React from 'react';
import { useNavigate } from 'react-router-dom';
import LogoutButton from '../components/LogoutButton';
import { useAuth } from '../contexts/AuthContext';
import { FileText, Printer } from 'lucide-react';

// Post-login landing. The two modules (JCC and Printing) are kept visually and
// navigationally separate — pick one here and the sidebar scopes to that module.
const HubPage = () => {
    const navigate = useNavigate();
    const { user } = useAuth();

    // Printing access is decided by module flags (independent of the JCC role).
    const isCoord = Number(user?.is_printer_coordinator) === 1;
    const isOp = Number(user?.is_printer_operator) === 1;
    const canRequest = ['initiator', 'user', 'admin'].includes(user?.role);
    const canPrint = canRequest || isCoord || isOp;
    // Land each person on their natural printing home.
    const printingLanding =
        canRequest ? '/job-history'
            : isCoord ? '/print-coordinator'
                : isOp ? '/print-operator'
                    : '/job-history';


    const Card = ({ onClick, icon, title, subtitle, accent }) => (
        <button
            onClick={onClick}
            className="lg-module-card"
            style={{
                // Per-card accent drives the glass tint + halo (see .lg-module-card)
                '--card-glow': accent.glow,
                cursor: 'pointer',
                textAlign: 'left',
                border: `1px solid ${accent.border}`,
                background: accent.bg,
                borderRadius: '20px',
                padding: '2.25rem 2rem',
                width: '100%',
                maxWidth: '360px',
                minHeight: '260px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '1.25rem',
                transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                boxShadow: '0 10px 30px rgba(15,23,42,0.06)',
            }}
            onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-4px)';
                e.currentTarget.style.boxShadow = '0 18px 40px rgba(15,23,42,0.12)';
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 10px 30px rgba(15,23,42,0.06)';
            }}
        >
            <div
                style={{
                    width: '68px',
                    height: '68px',
                    borderRadius: '18px',
                    background: accent.iconBg,
                    color: accent.iconColor,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                {icon}
            </div>
            <div>
                <h2 style={{ margin: '0 0 0.4rem', fontSize: '1.5rem', fontWeight: 700, color: accent.title }}>{title}</h2>
                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.95rem', lineHeight: 1.5 }}>{subtitle}</p>
            </div>
            <span style={{ color: accent.title, fontWeight: 600, fontSize: '0.95rem' }}>Open {title} →</span>
        </button>
    );

    return (
        <div
            style={{
                minHeight: '100vh',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--hub-bg)',
            }}
        >
            {/* Minimal top bar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <img src="/infloai-mark.svg" alt="InFloAI" style={{ height: '34px', width: '34px', borderRadius: '10px' }} />
                    <span style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-strong)' }}>InFloAI</span>
                </div>
                <LogoutButton style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#EF4444', color: '#fff', border: 'none', borderRadius: '10px', padding: '0.5rem 0.9rem', fontWeight: 600, cursor: 'pointer' }} />
            </div>

            {/* Centered chooser */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '1.5rem' }}>
                <h1 style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-strong)', margin: '0 0 0.35rem', textAlign: 'center' }}>
                    Welcome{user?.name ? `, ${user.name}` : ''}
                </h1>
                <p style={{ color: 'var(--text-muted)', margin: '0 0 2.25rem', fontSize: '1.05rem', textAlign: 'center' }}>
                    What would you like to do today?
                </p>

                <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                    {canPrint && (
                        <Card
                            onClick={() => navigate(printingLanding)}
                            icon={<Printer size={34} />}
                            title="Printing Request"
                            subtitle="Create and track printing jobs — documents, specs, and coordinator verification."
                            accent={{
                                border: 'var(--hub-purple-border)',
                                bg: 'var(--surface)',
                                iconBg: 'var(--hub-purple-icon-bg)',
                                iconColor: 'var(--hub-purple-icon)',
                                title: 'var(--hub-purple-title)',
                                glow: 'var(--hub-purple-glow)',
                            }}
                        />
                    )}
                    <Card
                        onClick={() => navigate('/')}
                        icon={<FileText size={34} />}
                        title="JCC"
                        subtitle="Raise and track completion claims / vouchers, approvals, and payments."
                        accent={{
                            border: 'var(--hub-blue-border)',
                            bg: 'var(--surface)',
                            iconBg: 'var(--hub-blue-icon-bg)',
                            iconColor: 'var(--hub-blue-icon)',
                            title: 'var(--hub-blue-title)',
                            glow: 'var(--hub-blue-glow)',
                        }}
                    />
                </div>
            </div>
        </div>
    );
};

export default HubPage;
