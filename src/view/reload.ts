import type { RowKey } from '../model/rows';
import type { NodeId } from '../model/types';

/**
 * A reload (Ctrl+R, F5, pulling the page down on a phone) is the same view
 * again, not a new start: the zoom comes back from the address
 * (zoom-hash.ts), the search and the scroll from here. They are kept in
 * sessionStorage, which lasts as long as the tab: a new start of the app
 * still opens on today (Outline.tsx).
 */

/** Where the view was: the zoom, the search, the first row in view and how far the view was into it. */
export interface Spot {
  zoom: NodeId | null;
  query: string;
  row: RowKey | null;
  offset: number;
}

const KEY = 'listik-reload';

/** Was this page loaded by reloading it? */
export function reloaded(): boolean {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return nav?.type === 'reload';
}

/** As the page goes away (`pagehide`, which a reload fires too). */
export function keepSpot(spot: Spot): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(spot));
  } catch {
    // Storage unavailable: a reload starts at the top of the place.
  }
}

/** The view before this reload, once; null if there is none or it cannot be read. */
export function takeSpot(): Spot | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const s: unknown = raw ? JSON.parse(raw) : null;
    if (!s || typeof s !== 'object') return null;
    const { zoom, query, row, offset } = s as Record<string, unknown>;
    return {
      zoom: typeof zoom === 'string' ? zoom : null,
      query: typeof query === 'string' ? query : '',
      row: typeof row === 'string' ? row : null,
      offset: typeof offset === 'number' && Number.isFinite(offset) ? offset : 0,
    };
  } catch {
    return null;
  }
}
