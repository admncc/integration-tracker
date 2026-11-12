import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/** Where a menu opens: the button it belongs to, as it sat on the screen when clicked. */
export interface Anchor {
  top: number;
  bottom: number;
  left: number;
}

export function anchorOf(element: HTMLElement, menuWidth: number): Anchor {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)) };
}

const GAP = 4;
const MARGIN = 8;

/**
 * A row menu (star, demand flag) opens below its button - unless that would
 * run off the bottom of the window, as it did on the last rows of a table:
 * then above. Measured before the first paint, so it never shows in the wrong
 * place first.
 */
export function useMenuPosition(menu: RefObject<HTMLElement | null>, anchor: Anchor | null): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!anchor || !menu.current) return;
    const height = menu.current.offsetHeight;
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - height;
    const top =
      below + height <= window.innerHeight - MARGIN
        ? below
        : above >= MARGIN
          ? above
          : // Fits neither way (a very short window): as much of it on screen as possible.
            Math.max(MARGIN, window.innerHeight - MARGIN - height);
    setStyle({ top, left: anchor.left });
  }, [anchor, menu]);
  return anchor ? style : { visibility: 'hidden' };
}
