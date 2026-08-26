import { useEffect, useRef, type ReactNode } from 'react';

export type Tone = 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'slate' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  green: 'text-tone-green bg-tone-green-bg',
  blue: 'text-tone-blue bg-tone-blue-bg',
  amber: 'text-tone-amber bg-tone-amber-bg',
  red: 'text-tone-red bg-tone-red-bg',
  purple: 'text-tone-purple bg-tone-purple-bg',
  slate: 'text-tone-slate bg-tone-slate-bg',
  muted: 'text-tone-muted bg-tone-muted-bg',
};

/** Static maps: Tailwind scans source text, so tone classes cannot be interpolated. */
export const TONE_BG: Record<Tone, string> = {
  green: 'bg-tone-green', blue: 'bg-tone-blue', amber: 'bg-tone-amber',
  red: 'bg-tone-red', purple: 'bg-tone-purple', slate: 'bg-tone-slate', muted: 'bg-tone-muted',
};

export const TONE_TEXT: Record<Tone, string> = {
  green: 'text-tone-green', blue: 'text-tone-blue', amber: 'text-tone-amber',
  red: 'text-tone-red', purple: 'text-tone-purple', slate: 'text-tone-slate', muted: 'text-tone-muted',
};

export function Badge({ tone = 'slate', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASS[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function Dot({ tone = 'slate' }: { tone?: Tone }) {
  return <span className={`inline-block size-1.5 rounded-full ${TONE_BG[tone]}`} />;
}

/**
 * A table cell that reads as a status pill but is a real `<select>`, so every
 * column stays keyboard-navigable and screen-reader friendly while still being
 * one click away from an edit.
 */
export function InlineSelect<T extends string>({
  value,
  options,
  tone = 'slate',
  disabled = false,
  onChange,
  title,
  compact = false,
}: {
  value: T;
  options: { value: T; label: string; short?: string }[];
  tone?: Tone;
  disabled?: boolean;
  onChange: (next: T) => void;
  title?: string;
  /** Render the short forms - for table cells that have to stay inside a column. */
  compact?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <div className={`relative ${compact ? 'block' : 'inline-block'}`}>
      <select
        value={value}
        disabled={disabled}
        title={title ?? current?.label}
        onChange={(event) => onChange(event.target.value as T)}
        className={`w-full max-w-full appearance-none truncate rounded-full py-0.5 text-xs font-medium outline-none transition
          ${compact ? 'pl-1.5' : 'pl-2'} ${TONE_CLASS[tone]}
          ${disabled ? 'cursor-default pr-2' : `cursor-pointer ${compact ? 'pr-4' : 'pr-5'} hover:brightness-95 focus:ring-2 focus:ring-brand/40`}`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-surface text-ink">
            {compact ? (option.short ?? option.label) : option.label}
          </option>
        ))}
      </select>
      {!disabled && (
        <svg viewBox="0 0 12 12" aria-hidden className="pointer-events-none absolute top-1/2 right-1.5 size-2.5 -translate-y-1/2 opacity-60">
          <path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

/** Click-to-edit text cell: shows plain text until focused, commits on blur or Enter. */
export function InlineText({
  value,
  onCommit,
  disabled = false,
  placeholder = '-',
  type = 'text',
  className = '',
}: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  type?: 'text' | 'number' | 'url';
  className?: string;
}) {
  if (disabled) {
    return <span className={`text-sm ${value ? '' : 'text-ink-faint'} ${className}`}>{value || placeholder}</span>;
  }
  return (
    <input
      type={type}
      defaultValue={value}
      key={value}
      placeholder={placeholder}
      onBlur={(event) => {
        if (event.target.value !== value) onCommit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.currentTarget.value = value;
          event.currentTarget.blur();
        }
      }}
      className={`w-full rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm outline-none
        hover:border-line focus:border-brand focus:bg-surface ${className}`}
    />
  );
}

/**
 * Two-state currency switch. A dropdown for two options costs the width of a
 * chevron plus a label; in a table column that has to fit on screen, a button
 * showing the symbol is both smaller and quicker to hit.
 */
export function CurrencyToggle({
  value,
  disabled = false,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const next = value === 'EUR' ? 'USD' : 'EUR';
  const symbol = value === 'USD' ? '$' : '\u20ac';

  if (disabled) return <span className="px-1 text-xs text-ink-faint">{symbol}</span>;

  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      title={`${value} - click to switch to ${next}`}
      aria-label={`Currency ${value}, switch to ${next}`}
      className="shrink-0 rounded border border-line px-1 py-0.5 text-xs font-medium text-ink-soft transition hover:border-brand hover:text-brand"
    >
      {symbol}
    </button>
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  const variants = {
    primary: 'bg-brand text-white hover:brightness-110',
    secondary: 'border border-line-strong bg-surface hover:bg-raised',
    ghost: 'hover:bg-raised',
    danger: 'border border-tone-red/30 text-tone-red hover:bg-tone-red-bg',
  };
  const sizes = { sm: 'px-2.5 py-1 text-xs', md: 'px-3 py-1.5 text-sm' };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition
        disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        className={`card my-auto w-full shadow-xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-ink-faint">{children}</div>;
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-16 text-sm text-ink-faint">
      <span className="mr-2 inline-block size-4 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
      Loading…
    </div>
  );
}

/** SQLite stores naive UTC strings; every timestamp is parsed as UTC before display. */
export function parseTimestamp(iso: string) {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
}

/** Absolute date + time - the audit trail needs to be unambiguous, not just "2 days ago". */
export function formatDateTime(iso: string) {
  return parseTimestamp(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function Timestamp({ iso, className = '' }: { iso: string; className?: string }) {
  return (
    <time dateTime={parseTimestamp(iso).toISOString()} title={formatDateTime(iso)} className={className}>
      {formatDateTime(iso)}
    </time>
  );
}

export function relativeTime(iso: string) {
  const then = parseTimestamp(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'], [3600, 'minute'], [86400, 'hour'], [604800, 'day'], [2629800, 'week'], [31557600, 'month'],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let previous = 1;
  for (const [limit, unit] of steps) {
    if (seconds < limit) return formatter.format(-Math.round(seconds / previous), unit);
    previous = limit;
  }
  return formatter.format(-Math.round(seconds / 31557600), 'year');
}
