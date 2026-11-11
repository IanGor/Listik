import { createSignal, type Accessor } from 'solid-js';

/** A media query as a signal. */
function query(q: string): Accessor<boolean> {
  const media = typeof matchMedia === 'function' ? matchMedia(q) : null;
  const [matches, setMatches] = createSignal(media?.matches ?? false);
  media?.addEventListener('change', (e) => setMatches(e.matches));
  return matches;
}

/** Layout follows the window; input capability is independent of its width.
 * Keep the 768px boundary in sync with index.css. */
export const narrow = query('(max-width: 767px)');
export const touch = query('(pointer: coarse)');
export const touchCapable = () => touch() || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
export const tablet: Accessor<boolean> = () => !narrow() && touchCapable();
export const phone: Accessor<boolean> = () => narrow() && touchCapable();

export function watchTablet(): void {
  const root = document.documentElement;
  const media = [matchMedia('(pointer: coarse)'), matchMedia('(max-width: 767px)')];
  const update = () => root.classList.toggle('tablet', tablet());
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
  root.classList.toggle('touch-capable', touchCapable());
  const seen = (e: PointerEvent) => root.classList.toggle('mouse', e.pointerType === 'mouse');
  addEventListener('pointermove', seen, { capture: true, passive: true });
  addEventListener('pointerdown', seen, { capture: true, passive: true });
  // Safari on iOS applies :active to what a finger presses only with a touch listener on the page.
  addEventListener('touchstart', () => {}, { passive: true });
}

/** Shrinking the window by more than this is the keyboard, not the address bar, px. */
const KEYBOARD_MIN = 150;

/**
 * A docked on-screen keyboard shrinks either the layout viewport (Android)
 * or only the visual viewport (iPadOS Safari). A new width starts over.
 * Browsers do not reliably expose whether a hardware keyboard is attached.
 */
export const keyboard: Accessor<boolean> = (() => {
  if (typeof window === 'undefined') return () => false;
  let width = innerWidth;
  let full = innerHeight;
  const [up, setUp] = createSignal(false);
  const viewport = window.visualViewport;
  const update = () => {
    if (innerWidth !== width) {
      width = innerWidth;
      full = innerHeight;
    }
    full = Math.max(full, innerHeight);
    // Compare in layout pixels: zoom alone must not look like a keyboard,
    // but must not prevent detecting a keyboard opened while zoomed in.
    const height = Math.min(innerHeight, viewport ? viewport.height * viewport.scale : innerHeight);
    const visible = full - height > KEYBOARD_MIN;
    setUp(visible);
    const root = document.documentElement;
    if (visible && viewport && viewport.height < innerHeight) {
      root.style.setProperty('--keyboard-visible-height', `${Math.min(innerHeight, viewport.height + viewport.offsetTop)}px`);
    } else root.style.removeProperty('--keyboard-visible-height');
  };
  addEventListener('resize', update);
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  update();
  return up;
})();

/** An Apple device: the modifier is ⌘ (and ⌥). The help and every hint of a key take their names from here. */
export const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
export const MOD = MAC ? '⌘' : 'Ctrl';
export const ALT = MAC ? '⌥' : 'Alt';
