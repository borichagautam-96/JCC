import React from 'react';

// Reusable Liquid Glass surface.
//
// The material itself lives in CSS (.lg-mat and its ::before/::after layers) so
// it can also be applied to existing markup without rewriting it. This component
// is the ergonomic entry point for new UI.
//
//   <LiquidGlass variant="panel">…</LiquidGlass>
//   <LiquidGlass as="button" variant="circle" onClick={…}>…</LiquidGlass>
//
// The cursor-tracked reflection (Layer 6) is wired globally by
// utils/liquidGlass — any element carrying .lg-mat participates automatically.

const VARIANTS = {
    panel: '',                 // 20px radius floating panel
    card: 'lg-v-card',         // 16px radius
    capsule: 'lg-v-capsule',   // pill / search field
    circle: 'lg-v-circle',     // icon button
    bar: 'lg-v-bar',           // full-width toolbar, bottom edge lit only
};

const LiquidGlass = React.forwardRef(function LiquidGlass(
    { as: Tag = 'div', variant = 'panel', className = '', refract = false, children, ...rest },
    ref,
) {
    const cls = [
        'lg-mat',
        VARIANTS[variant] || '',
        refract ? 'lg-refract' : '',
        className,
    ].filter(Boolean).join(' ');

    return (
        <Tag ref={ref} className={cls} {...rest}>
            {children}
        </Tag>
    );
});

export default LiquidGlass;
