import { createSignal } from 'solid-js';

export type Theme = 'light' | 'dark';

/**
 * Light or dark Claude theme, in step with the system's: when the system
 * switches, so does the app. A system that tells no theme (no preference,
 * or no `prefers-color-scheme` at all) gets the dark one. A pick in the menu
 * holds until the system switches next: it is remembered per browser with
 * the system's theme at that moment, and dropped once the system's differs
 * (now, or by the next start). CSS reads `data-theme` on <html>
 * (index.css), always set; index.html sets it before the first paint by
 * the same rule.
 */
const KEY = 'listik-theme';
/** The system's theme when the pick was made. */
const SYSTEM_KEY = 'listik-theme-system';
const lightMedia = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode): the pick lasts for this page.
  }
}

/** The system's theme: light only when it says so. */
const system = (): Theme => (lightMedia?.matches ? 'light' : 'dark');

/** The pick, while the system is as it was when it was made. */
function picked(): Theme | null {
  const t = read(KEY);
  return (t === 'light' || t === 'dark') && read(SYSTEM_KEY) === system() ? t : null;
}

const DARK_BAR = '#262624';
const LIGHT_BAR = '#faf9f5';

function apply(t: Theme): void {
  document.documentElement.dataset.theme = t;
  // The browser's and the installed app's bar, whatever the system says.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = t === 'dark' ? DARK_BAR : LIGHT_BAR;
}

const [theme, setThemeSignal] = createSignal<Theme>(picked() ?? system());
apply(theme());

/** The theme in effect. */
export { theme };

/** A pick in the menu: it holds until the system switches. Picking the system's own theme just follows it again. */
export function setTheme(t: Theme): void {
  const s = system();
  write(KEY, t === s ? null : t);
  write(SYSTEM_KEY, t === s ? null : s);
  apply(t);
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

// The system switched: the app follows, and a pick made before is let go.
lightMedia?.addEventListener('change', () => {
  write(KEY, null);
  write(SYSTEM_KEY, null);
  const t = system();
  apply(t);
  setThemeSignal(t);
});
