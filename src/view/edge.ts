/**
 * A trial, to be settled and removed: iPadOS 26 blurs the top ~40pt of a
 * Home Screen app over its content (the Liquid Glass scroll edge effect),
 * and the header reads smeared. Reports say WebKit leaves the edge clear,
 * painted in its colour, when a fixed or sticky opaque box spans the top
 * edge. Nothing in a browser shows it, so the variants are picked on the
 * iPad itself from the menu; index.html sets `data-edge` on <html> before
 * the first paint, and index.css does the rest.
 *
 * 0 — as before; 1 — a sticky opaque header; 2 — the whole app in a fixed
 * opaque frame; 3 — as 1, with a 28px band above the header, clear of the blur.
 */
const KEY = 'listik-edge';

export const EDGE_NAMES = ['как было', 'закреплённая шапка', 'закреплённое окно', 'шапка с полосой'] as const;

function saved(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v > 0 && v < EDGE_NAMES.length ? v : 0;
  } catch {
    return 0;
  }
}

/** The variant in effect: the one index.html applied. */
export const edge = saved();

/** The next variant, applied from the start: the page reloads. */
export function nextEdge(): void {
  const next = (edge + 1) % EDGE_NAMES.length;
  try {
    if (next) localStorage.setItem(KEY, String(next));
    else localStorage.removeItem(KEY);
  } catch {
    return;
  }
  location.reload();
}
