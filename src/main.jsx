import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import { initLiquidGlass } from './utils/liquidGlass';
import './index.css';

// Safety: clear any stranded logout fade class. That class sets #root to
// opacity 0, so if it ever survived a navigation the app would look blank.
document.documentElement.classList.remove('is-logging-out');

// Layer 6 — cursor-tracked reflection across glass surfaces.
initLiquidGlass();

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <ThemeProvider>
            <BrowserRouter>
                <App />
            </BrowserRouter>
        </ThemeProvider>
    </React.StrictMode>
);
