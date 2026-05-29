import React, { useEffect } from 'react';
import { Users, X, UserRound } from 'lucide-react';

const DEFAULT_TEAM = [
    {
        id: 'team-slot-gautam',
        name: 'Gautam Boricha',
        email: 'gautam.boricha@larsentoubro',
        image: '/Gemini_Generated_Image_3em1k03em1k03em1 (1).png',
    },
    {
        id: 'team-slot-priti',
        name: 'Priti Gusaine',
        email: 'priti.gusaine@larsentoubro.com',
        image: '/IMG-20260202-WA0020.jpg',
    },
];

const getInitials = (name) =>
    String(name || '')
        .split(' ')
        .filter(Boolean)
        .map((part) => part[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();

const TeamModal = ({ isOpen, onClose, team = DEFAULT_TEAM }) => {
    useEffect(() => {
        if (!isOpen) return undefined;

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div
            className="team-modal-overlay"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <section
                className="team-modal-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby="team-modal-title"
                onClick={(event) => event.stopPropagation()}
            >
                <header className="team-modal-header">
                    <div className="team-modal-title">
                        <span className="team-modal-icon" aria-hidden="true">
                            <Users size={18} />
                        </span>
                        <div>
                            <h3 id="team-modal-title">D&T Team</h3>
                            <p className="team-modal-subtitle">Built by the TLS Digital Team</p>
                        </div>
                    </div>
                    <div className="team-modal-actions">
                        <span className="team-release-badge">v2.4 - May 2026</span>
                        <button
                            type="button"
                            className="team-modal-close"
                            onClick={onClose}
                            aria-label="Close"
                        >
                            <X size={18} />
                        </button>
                    </div>
                </header>

                <div className="team-modal-body">
                    <aside className="team-blueprint-panel">
                        <p className="team-blueprint-kicker">Development Team (D&T)</p>
                        <h4 className="team-blueprint-title">InFloAI Delivery Unit</h4>

                        <div className="team-info-cards">
                            <div className="team-info-card">
                                <span className="team-info-card-icon">⚡</span>
                                <div>
                                    <div className="team-info-card-label">Platform</div>
                                    <div className="team-info-card-value">InFlowAI</div>
                                </div>
                            </div>
                            <div className="team-info-card">
                                <span className="team-info-card-icon">🏢</span>
                                <div>
                                    <div className="team-info-card-label">Organisation</div>
                                    <div className="team-info-card-value">TLS Digital</div>
                                </div>
                            </div>
                            <div className="team-info-card">
                                <span className="team-info-card-icon">📦</span>
                                <div>
                                    <div className="team-info-card-label">Release</div>
                                    <div className="team-info-card-value">v2.4 — May 2026</div>
                                </div>
                            </div>
                            <div className="team-info-card">
                                <span className="team-info-card-icon">🛡️</span>
                                <div>
                                    <div className="team-info-card-label">Status</div>
                                    <div className="team-info-card-value team-info-card-live">● Live</div>
                                </div>
                            </div>
                        </div>
                    </aside>

                    <div className="team-modal-grid">
                        {team.map((member, index) => (
                            <article
                                key={member.id || member.name || `team-slot-${index}`}
                                className="team-member-card"
                                style={{ animationDelay: `${160 + index * 90}ms` }}
                                aria-label="Team member placeholder"
                            >
                                <div className="team-avatar">
                                    <div className="team-avatar-inner">
                                        {member.image ? (
                                            <img
                                                src={member.image}
                                                alt={member.name || 'Team member'}
                                                className="team-avatar-image"
                                            />
                                        ) : member.initials || member.name ? (
                                            <span>{member.initials || getInitials(member.name)}</span>
                                        ) : (
                                            <UserRound size={26} />
                                        )}
                                    </div>
                                </div>
                                {member.name ? <div className="team-name">{member.name}</div> : null}
                                {member.role ? <div className="team-role">{member.role}</div> : null}
                                {member.email ? <div className="team-email">{member.email}</div> : null}
                                {!member.name && !member.role ? (
                                    <div className="team-card-placeholder" aria-hidden="true">
                                        <span />
                                        <span />
                                    </div>
                                ) : null}
                            </article>
                        ))}
                    </div>
                </div>

                <footer className="team-modal-footer">
                    <span>InFloAI - JCC Automation System</span>
                    <span>TLS Digital</span>
                </footer>
            </section>
        </div>
    );
};

export default TeamModal;
