import { createSignal } from 'solid-js';

export type Theme = 'light' | 'dark';

/**
 * Light or dark Claude theme. Until one is picked in the UI, the system's
 * is used; a pick is remembered per browser. CSS reads `data-theme` on
 * <html> (index.css); index.html applies a saved pick before the first paint.
 */
const KEY = 'listik-theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function saved(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

const system = (): Theme => (media?.matches ? 'dark' : 'light');

const [theme, setThemeSignal] = createSignal<Theme>(saved() ?? system());

/** The theme in effect. */
export { theme };

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Storage unavailable (private mode): the pick lasts for this page.
  }
  setThemeSignal(t);
}

/**
 * Switches to the other theme. The new one opens as a circle from `from` (the
 * button pressed); instant with reduced motion.
 */
export function toggleTheme(from: DOMRect): void {
  const next = theme() === 'dark' ? 'light' : 'dark';
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return setTheme(next);
  const x = from.left + from.width / 2;
  const y = from.top + from.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = document.startViewTransition(() => setTheme(next));
  void transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 560, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  });
}

media?.addEventListener('change', () => {
  if (!saved()) setThemeSignal(system());
});
