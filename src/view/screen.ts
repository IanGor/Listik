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
