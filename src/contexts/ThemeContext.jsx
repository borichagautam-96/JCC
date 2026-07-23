import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

// Theme state for the app. The actual attribute (`data-theme` on <html>) is set
// pre-paint by the boot script in index.html; this provider keeps it in sync,
// persists explicit choices, and follows the OS until the user picks one.

const STORAGE_KEY = 'infloai-theme';
const SWITCH_CLASS = 'theme-switching';
const SWITCH_MS = 320;

const ThemeContext = createContext({
    theme: 'light',
    isDark: false,
    setTheme: () => { },
    toggleTheme: () => { },
});

const readStored = () => {
    try {
        const s = localStorage.getItem(STORAGE_KEY);
        return s === 'dark' || s === 'light' ? s : null;
    } catch {
        return null;
    }
};

const readInitialTheme = () => {
    if (typeof document === 'undefined') return 'light';
    // The boot script already resolved this — trust it so we never disagree with the paint.
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    return readStored()
        || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
};

export const ThemeProvider = ({ children }) => {
    const [theme, setThemeState] = useState(readInitialTheme);
    const [isExplicit, setIsExplicit] = useState(() => readStored() !== null);
    const switchTimer = useRef(null);
    const firstRun = useRef(true);

    // Apply to <html>, and enable the 300ms colour transition only while switching
    // (a permanent global transition would fight every other animation in the app).
    useEffect(() => {
        const root = document.documentElement;
        root.setAttribute('data-theme', theme);
        root.style.colorScheme = theme;

        if (firstRun.current) { firstRun.current = false; return; }

        root.classList.add(SWITCH_CLASS);
        if (switchTimer.current) clearTimeout(switchTimer.current);
        switchTimer.current = setTimeout(() => root.classList.remove(SWITCH_CLASS), SWITCH_MS);
    }, [theme]);

    useEffect(() => () => { if (switchTimer.current) clearTimeout(switchTimer.current); }, []);

    const setTheme = useCallback((next) => {
        setThemeState(next === 'dark' ? 'dark' : 'light');
        setIsExplicit(true);
        try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
    }, []);

    const toggleTheme = useCallback(() => {
        setTheme(theme === 'dark' ? 'light' : 'dark');
    }, [theme, setTheme]);

    // Track the OS only until the user makes an explicit choice.
    useEffect(() => {
        if (isExplicit || !window.matchMedia) return undefined;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (e) => setThemeState(e.matches ? 'dark' : 'light');
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, [isExplicit]);

    const value = useMemo(
        () => ({ theme, isDark: theme === 'dark', setTheme, toggleTheme }),
        [theme, setTheme, toggleTheme],
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);

export default ThemeContext;
