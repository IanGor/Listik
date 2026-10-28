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

/** The shorter side of the device's screen at least this is a tablet, px (iPad mini: 744). */
const TABLET_MIN = 700;

/**
 * A tablet (iPad): a finger as the main pointer on a wide screen. It gets the
 * computer's layout (arrows by the bullets, the calendar button at the row's
 * end, the full menu), with a finger's target sizes. The window's width counts
 * too, so Slide Over (a phone-wide strip of an iPad) is a phone. The device is
 * judged by `screen`, not the window: the keyboard shrinks the window.
 */
const bigScreen = typeof screen !== 'undefined' && Math.min(screen.width, screen.height) >= TABLET_MIN;
const wide = query('(min-width: 641px)');
export const tablet: Accessor<boolean> = () => bigScreen && touch() && wide();

/** The phone's touch layout: a finger on a screen too small for the computer's. */
export const phone: Accessor<boolean> = () => touch() && !tablet();

/** Keeps `tablet` on <html> (index.css has no media query for it). */
export function watchTablet(): void {
  const root = document.documentElement;
  const media = [matchMedia('(pointer: coarse)'), matchMedia('(min-width: 641px)')];
  const update = () => root.classList.toggle('tablet', bigScreen && media.every((m) => m.matches));
  for (const m of media) m.addEventListener('change', update);
  update();
}

/**
 * Hover effects follow a real mouse or trackpad, not a media query: an
 * iPad's main pointer is a finger, so `(hover: hover)` never holds there,
 * even with the Magic Keyboard's trackpad, while a finger's tap must not
 * leave a hover lit. index.css puts every `:hover` under
 * `:where(:root.mouse)` (the rules weigh what they did), which this keeps on
 * while the last pointer was a mouse or trackpad. It also lets Safari light a
 * pressed button under a finger (`:active`).
 */
export function watchPointer(): void {
  const root = document.documentElement;
  const seen = (e: PointerEvent) => root.classList.toggle('mouse', e.pointerType === 'mouse');
  addEventListener('pointermove', seen, { capture: true, passive: true });
  addEventListener('pointerdown', seen, { capture: true, passive: true });
  // Safari on iOS applies :active to what a finger presses only with a touch listener on the page.
  addEventListener('touchstart', () => {}, { passive: true });
}

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
