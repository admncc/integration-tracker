import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEMAND_BLOCK, formatWaiting } from '@shared/domain.js';
import { useSession } from '../lib/session';
import type { DemandBlock, Site } from '../lib/types';
import { Button } from './ui';

/**
 * "Mostly blocked by demand partners": the partner's alarm that a site's
 * traffic is mostly refused on the demand side, so the publisher can take it
 * offline. Three states:
 *
 *   none           - normal
 *   mostly_blocked - the alarm: red everywhere, first in the publisher's inbox
 *   offline        - the publisher took it down; the alarm is over, the record stays
 *
 * Only the publisher says a site is offline - that is what ends the alarm.
 */
interface Action {
  value: DemandBlock;
  label: string;
  hint: string;
  danger?: boolean;
}

function actionsFor(state: DemandBlock, publisher: boolean): Action[] {
  const flag: Action = {
    value: 'mostly_blocked',
    label: 'Mostly blocked by demand partners',
    hint: 'Turns the site red and alerts the publisher to take it offline.',
    danger: true,
  };
  const offline: Action = { value: 'offline', label: 'Taken offline', hint: 'Ends the alert. The flag stays on record.' };
  const clear: Action = { value: 'none', label: 'Not blocked any more', hint: 'Removes the flag.' };

  if (state === 'mostly_blocked') return publisher ? [offline, clear] : [clear];
  if (state === 'offline') return [{ ...clear, label: 'Back online - remove the flag' }, { ...flag, label: 'Mostly blocked again' }];
  return [flag];
}

/** Who raised the flag and since when, in words. */
export function flaggedBy(site: Pick<Site, 'demand_block_by_name' | 'demand_block_since'>) {
  const who = site.demand_block_by_name ? `by ${site.demand_block_by_name}` : '';
  return [who, formatWaiting(site.demand_block_since ?? null)].filter(Boolean).join(' ');
}

function FlagIcon({ filled, className = '' }: { filled: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={`size-4 ${className}`}>
      <path
        d="M4 18V3m0 1h9.5l-1.8 3.5L13.5 11H4"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The flag in the sites table. A menu rather than a toggle: raising an alarm
 * the publisher acts on should take a deliberate second click, and the
 * publisher has two different ways to answer it.
 *
 * The menu is rendered into <body> - the table cells clip their content.
 */
export function DemandFlagButton({ site, disabled, onSet }: { site: Site; disabled: boolean; onSet: (value: DemandBlock) => void }) {
  const { user } = useSession();
  const state = (site.demand_block ?? 'none') as DemandBlock;
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const close = (event: Event) => {
      if (event.type === 'mousedown' && (menu.current?.contains(event.target as Node) || button.current?.contains(event.target as Node))) return;
      setAt(null);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setAt(null);
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [at]);

  const label = state === 'none' ? 'Flag as mostly blocked by demand partners' : `${DEMAND_BLOCK[state].label} ${flaggedBy(site)}`.trim();

  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={() => {
          if (at) return setAt(null);
          const rect = button.current!.getBoundingClientRect();
          setAt({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)) });
        }}
        className={`shrink-0 rounded p-0.5 transition disabled:cursor-default ${
          state === 'mostly_blocked'
            ? 'text-tone-red'
            : state === 'offline'
              ? 'text-ink-soft'
              : 'text-ink-faint/50 hover:text-tone-red disabled:hover:text-ink-faint/50'
        }`}
      >
        <FlagIcon filled={state !== 'none'} />
      </button>

      {at &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            style={{ top: at.top, left: at.left }}
            className="fixed z-50 w-72 rounded-xl border border-line bg-surface p-1.5 text-sm shadow-lg"
          >
            <div className="px-2 pt-1 pb-1.5 text-xs text-ink-faint">
              <span className="font-medium text-ink">{site.domain}</span>
              {state !== 'none' && (
                <>
                  {' · '}
                  {DEMAND_BLOCK[state].short} {flaggedBy(site)}
                </>
              )}
            </div>
            {actionsFor(state, user?.role !== 'partner').map((action) => (
              <button
                key={action.value}
                role="menuitem"
                type="button"
                onClick={() => {
                  setAt(null);
                  onSet(action.value);
                }}
                className={`block w-full rounded-lg px-2 py-1.5 text-left transition ${
                  action.danger ? 'text-tone-red hover:bg-tone-red-bg' : 'hover:bg-raised'
                }`}
              >
                <span className="block font-medium">{action.label}</span>
                <span className="block text-xs text-ink-faint">{action.hint}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

/** The same choice on the domain's own page, as a panel that says where things stand. */
export function DemandBlockPanel({ site, disabled, busy = false, onSet }: { site: Site; disabled: boolean; busy?: boolean; onSet: (value: DemandBlock) => void }) {
  const { user } = useSession();
  const state = (site.demand_block ?? 'none') as DemandBlock;
  const actions = actionsFor(state, user?.role !== 'partner');

  if (state === 'none') {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line-strong px-4 py-3 text-sm">
        <span className="min-w-0 flex-1 text-ink-soft">
          Demand partners refusing most of this site's traffic? Flag it, and the publisher is alerted to take it offline.
        </span>
        {!disabled && (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => onSet('mostly_blocked')}>
            <FlagIcon filled={false} /> Mostly blocked by demand partners
          </Button>
        )}
      </div>
    );
  }

  const alarm = state === 'mostly_blocked';
  return (
    <div
      role={alarm ? 'alert' : undefined}
      className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm ${
        alarm ? 'border-tone-red/40 bg-tone-red-bg text-tone-red' : 'border-line bg-raised text-ink-soft'
      }`}
    >
      <FlagIcon filled className="size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{alarm ? 'Mostly blocked by demand partners' : 'Taken offline - was mostly blocked by demand partners'}</div>
        <div className="text-xs opacity-80">
          {flaggedBy(site) || 'Flagged'}
          {alarm && (user?.role === 'partner' ? ' · the publisher has been alerted' : ' · take the site offline, then say so here')}
        </div>
      </div>
      {!disabled &&
        actions.map((action) => (
          <Button
            key={action.value}
            size="sm"
            variant={action.value === 'offline' ? 'primary' : action.danger ? 'danger' : 'secondary'}
            disabled={busy}
            title={action.hint}
            onClick={() => onSet(action.value)}
          >
            {action.label}
          </Button>
        ))}
    </div>
  );
}
