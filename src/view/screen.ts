import { createSignal, type Accessor } from 'solid-js';

/** A media query as a signal. */
function query(q: string): Accessor<boolean> {
  const media = typeof matchMedia === 'function' ? matchMedia(q) : null;
  const [matches, setMatches] = createSignal(media?.matches ?? false);
  media?.addEventListener('change', (e) => setMatches(e.matches));
  return matches;
}

/**
 * A phone-width screen: a shorter search placeholder. The width must match
 * the `max-width: 640px` media query in index.css.
 */
export const narrow = query('(max-width: 640px)');

/**
 * A touch screen as the main pointer (phone, tablet): no keyboard to rely on,
 * so editing gets a bar of actions (EditBar.tsx).
 */
export const touch = query('(pointer: coarse)');

/** Shrinking the window by more than this is the keyboard, not the address bar, px. */
const KEYBOARD_MIN = 150;

/**
 * The on-screen keyboard is up. It shrinks the window (index.html:
 * interactive-widget=resizes-content), so the window is then notably shorter
 * than it has been at this width. A new width (turned, resized) starts over.
 */
export const keyboard: Accessor<boolean> = (() => {
  if (typeof window === 'undefined') return () => false;
  let width = innerWidth;
  let full = innerHeight;
  const [up, setUp] = createSignal(false);
  addEventListener('resize', () => {
    if (innerWidth !== width) {
      width = innerWidth;
      full = innerHeight;
    }
    full = Math.max(full, innerHeight);
    setUp(full - innerHeight > KEYBOARD_MIN);
  });
  return up;
})();
