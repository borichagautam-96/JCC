import React from 'react';
import { useTheme } from '../contexts/ThemeContext';

// Light/dark switch for the header. Both icons are stacked in a fixed 18px box
// and cross-rotate, so toggling never changes the button's size (no layout shift).
const ThemeToggle = () => {
    const { isDark, toggleTheme } = useTheme();

    return (
        <button
            type="button"
            onClick={toggleTheme}
            className={`theme-toggle${isDark ? ' is-dark' : ''}`}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDark ? 'Light mode' : 'Dark mode'}
            aria-pressed={isDark}
        >
            <span className="theme-toggle-icons" aria-hidden="true">
                <svg className="theme-icon theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="4.2" />
                    <path d="M12 2.4v2.3M12 19.3v2.3M4.7 12H2.4M21.6 12h-2.3M6.1 6.1l1.6 1.6M16.3 16.3l1.6 1.6M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6" />
                </svg>
                <svg className="theme-icon theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.5 13.9A8.5 8.5 0 1 1 10.1 3.5a6.7 6.7 0 0 0 10.4 10.4z" />
                </svg>
            </span>
        </button>
    );
};

export default ThemeToggle;
