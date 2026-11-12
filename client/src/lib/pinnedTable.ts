import { useEffect, useRef } from 'react';

/**
 * The Sites tabs on a big enough screen (`pinned:` in index.css): heading,
 * filters and alerts stay in place, and the table card is the one thing that
 * scrolls - both ways, so the sideways scrollbar sits at the bottom of the
 * window instead of after the last row. It keeps a usable height even when
 * the top is tall; past that the page scrolls as a whole.
 */
export const TABLE_BOX_PINNED = 'pinned:min-h-72 pinned:flex-1 pinned:overflow-auto';

/**
 * The column headings (and the Sites filter row) stay at the top of the card while it scrolls.
 * The cells carry the row's background themselves, so nothing scrolls through behind them.
 */
export const STICKY_HEAD = 'sticky top-0 z-10 shadow-[0_1px_0_var(--color-line)]';

/**
 * Separate borders, drawn on the cells. With collapsed borders (and lines on
 * the rows) Chrome let the rows scrolling underneath show through a strip of
 * the sticky header.
 */
export const TABLE_LINES =
  'border-separate border-spacing-0 [&_td]:border-line [&_th]:border-line [&_tbody_tr:not(:last-child)>td]:border-b [&_thead_tr+tr>th]:border-t';

/** Where each table was scrolled to, for as long as the tab is open. */
const positions = new Map<string, number>();

/**
 * Opening a domain and coming back used to put the window back where it was;
 * now the scrolling happens inside the card, so the card has to remember.
 * `ready` is when the rows are there - before that there is nothing to scroll.
 */
export function useKeptScroll<T extends HTMLElement>(key: string, ready: boolean) {
  const box = useRef<T>(null);
  useEffect(() => {
    const element = box.current;
    if (!ready || !element) return;
    element.scrollTop = positions.get(key) ?? 0;
    const remember = () => positions.set(key, element.scrollTop);
    element.addEventListener('scroll', remember, { passive: true });
    return () => element.removeEventListener('scroll', remember);
  }, [key, ready]);
  return box;
}
