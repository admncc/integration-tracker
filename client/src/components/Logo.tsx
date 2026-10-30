import { useId } from 'react';

/** The company the tracker belongs to; shown under the product name. */
export const COMPANY = 'Digital Marketing Corp';

/**
 * The Digital Marketing Corp mark: a "D" with rising bars, the tallest in the
 * accent colour. Same drawing as client/public/logo.svg, inline so it needs no
 * request and scales with the text. The ids are per instance - two marks on
 * one page would otherwise share one gradient and one mask.
 */
export function LogoMark({ className = 'size-8', label }: { className?: string; label?: string }) {
  const id = useId();
  const bg = `${id}-bg`;
  const cut = `${id}-cut`;
  return (
    // Without a label it is decoration next to text that already says the name.
    <svg
      viewBox="0 0 64 64"
      className={`shrink-0 ${className}`}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <mask id={cut}>
          <path d="M16 14h14a18 18 0 0 1 0 36H16z" fill="#fff" />
          <rect x="20.5" y="35" width="5" height="9" rx="1.5" fill="#000" />
          <rect x="28" y="28.5" width="5" height="15.5" rx="1.5" fill="#000" />
        </mask>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${bg})`} />
      <rect width="64" height="64" fill="#fff" mask={`url(#${cut})`} />
      <rect x="35.5" y="22" width="5" height="22" rx="1.5" fill="#f59e0b" />
    </svg>
  );
}

/**
 * Mark, product name and company: the header and the sign-in page. Spans
 * throughout, so it can sit inside a heading or a link.
 */
export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const large = size === 'lg';
  return (
    <span className={`flex items-center ${large ? 'gap-3' : 'gap-2.5'}`}>
      <LogoMark className={large ? 'size-11' : 'size-8'} />
      <span className="block leading-tight">
        <span className={`block font-semibold tracking-tight text-ink ${large ? 'text-lg' : 'text-sm'}`}>Integration Tracker</span>
        <span className={`block font-semibold uppercase tracking-[0.14em] text-ink-faint ${large ? 'text-[11px]' : 'text-[9.5px]'}`}>
          {COMPANY}
        </span>
      </span>
    </span>
  );
}
