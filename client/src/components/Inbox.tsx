import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import type { Inbox as InboxData } from '../lib/types';
import { Badge } from './ui';

const POLL_MS = 60_000;

/**
 * "Is it my turn?" in the header.
 *
 * Every handoff in this tool crosses a company boundary - the partner raises,
 * a dev fixes, the partner re-checks - and until this existed each side had to
 * guess that it was their turn. That guessing is what kept the mail thread
 * alive next to the tracker.
 *
 * It polls rather than pushes: at this size a minute of latency costs nothing,
 * and it needs no connection to hold open, no worker, and no state to sync.
 */
export default function Inbox() {
  const [data, setData] = useState<InboxData | null>(null);
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      api
        .get<InboxData>('/inbox')
        .then((next) => live && setData(next))
        .catch(() => {
          /* a failed poll is not worth an error banner */
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!data) return null;

  const waiting = data.total;

  return (
    <div ref={wrapper} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={waiting ? `${waiting} thing(s) waiting on you` : 'Nothing waiting on you'}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium transition ${
          waiting ? 'bg-tone-red-bg text-tone-red hover:brightness-95' : 'text-ink-soft hover:bg-raised hover:text-ink'
        }`}
      >
        <span aria-hidden>{waiting ? '●' : '○'}</span>
        {/* On a phone the count alone, so the header stays on one line. */}
        {waiting ? (
          <>
            {waiting}
            <span className="max-sm:sr-only"> waiting on you</span>
          </>
        ) : (
          <>
            <span className="max-sm:sr-only">Nothing waiting</span>
            <span aria-hidden className="sm:hidden">0</span>
          </>
        )}
      </button>

      {open && (
        // A phone has no room for a 288px panel hanging off a button in the middle of the header, so there it spans the width.
        <div className="absolute right-0 z-40 mt-1 w-72 rounded-xl border border-line bg-surface p-2 shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:w-auto">
          {data.items.length === 0 ? (
            <p className="px-2 py-3 text-sm text-ink-soft">
              Nothing is waiting on you. {data.open > 0 ? `${data.open} issue(s) open across the network.` : 'Nothing open at all.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {data.items.map((item) => (
                <li key={item.key}>
                  <Link
                    to={item.to}
                    onClick={() => {
                      setOpen(false);
                      // Opening the discussion counts as having seen it.
                      if (item.key === 'messages') {
                        api.post('/inbox/seen').then(() => setData((current) => (current ? { ...current, items: current.items.filter((i) => i.key !== 'messages'), total: current.total - item.n } : current))).catch(() => {});
                      }
                    }}
                    className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition ${
                      item.alert ? 'bg-tone-red-bg font-medium text-tone-red hover:brightness-95' : 'hover:bg-raised'
                    }`}
                  >
                    <span className="min-w-0 flex-1">{item.alert && <span aria-hidden>⚠ </span>}{item.label}</span>
                    <Badge tone={item.key === 'unassigned' ? 'amber' : 'red'}>{item.n}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {data.blocked > 0 && (
            <Link
              to="/issues?status=blocked"
              onClick={() => setOpen(false)}
              className="mt-1 flex items-center gap-2 rounded-lg border-t border-line px-2 py-2 text-sm text-ink-soft transition hover:bg-raised"
            >
              <span className="min-w-0 flex-1">Blocked on someone else</span>
              <Badge tone="purple">{data.blocked}</Badge>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
