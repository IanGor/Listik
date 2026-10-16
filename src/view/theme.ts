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

media?.addEventListener('change', () => {
  if (!saved()) setThemeSignal(system());
});
