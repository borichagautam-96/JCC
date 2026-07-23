// Layer 6 of the Liquid Glass material: a slow, eased light that follows the
// cursor across a glass surface. Deliberately lagged (not locked to the pointer)
// so it reads as light moving through thick crystal rather than a hover sprite.
//
// One delegated listener for the whole document, one rAF loop, and the loop only
// runs while a surface is actually hovered — no idle cost, no React re-renders.

const SURFACES = [
    '.lg-mat',
    '.jcc-login-card',
    '.lg-glass-bar',
    '.team-modal-card',
    '.lg-module-card',
    '.global-search-box',
    '.theme-toggle',
    '.dl-meter',
    '.metric-card',
    '.th-dropzone',
].join(',');

const EASE = 0.1;      // lower = slower, more viscous
const PARKED_Y = -40;  // reflection resting place, just off the top edge

let active = null;
let targetX = 50, targetY = PARKED_Y;
let currentX = 50, currentY = PARKED_Y;
let rafId = null;

const write = (el, x, y) => {
    el.style.setProperty('--lg-mx', `${x.toFixed(2)}%`);
    el.style.setProperty('--lg-my', `${y.toFixed(2)}%`);
};

const tick = () => {
    currentX += (targetX - currentX) * EASE;
    currentY += (targetY - currentY) * EASE;

    if (active) write(active, currentX, currentY);

    const settled = Math.abs(targetX - currentX) < 0.15 && Math.abs(targetY - currentY) < 0.15;
    if (settled && !active) {
        rafId = null;   // parked and unhovered — stop burning frames
        return;
    }
    rafId = requestAnimationFrame(tick);
};

const start = () => { if (rafId === null) rafId = requestAnimationFrame(tick); };

const release = (el) => {
    if (!el) return;
    el.style.removeProperty('--lg-mx');
    el.style.removeProperty('--lg-my');
};

const onPointerMove = (e) => {
    const el = e.target.closest?.(SURFACES);

    if (el !== active) {
        release(active);
        active = el || null;
        if (active) {
            // enter from the nearest edge rather than snapping to the cursor
            currentY = PARKED_Y;
        }
    }
    if (!active) { targetY = PARKED_Y; start(); return; }

    const r = active.getBoundingClientRect();
    if (!r.width || !r.height) return;
    targetX = ((e.clientX - r.left) / r.width) * 100;
    targetY = ((e.clientY - r.top) / r.height) * 100;
    start();
};

const onPointerLeave = () => {
    targetY = PARKED_Y;
    const leaving = active;
    active = null;
    // let it drift off before clearing the vars
    setTimeout(() => release(leaving), 400);
    start();
};

export function initLiquidGlass() {
    if (typeof document === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerleave', onPointerLeave, { passive: true });
    window.addEventListener('blur', onPointerLeave, { passive: true });
}

export default initLiquidGlass;
