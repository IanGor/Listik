import { createSignal } from 'solid-js';
import { readDesktopTheme, type ThemeState } from './omarchy';
import { DEFAULT_PREFERENCE, PREFERENCE_KEY, readPreference, resolveTheme, type Theme, type ThemeMode } from './palettes';
export type { Theme } from './palettes';
export { THEMES } from './palettes';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
const system = (): Theme => media?.matches ? 'light' : 'dark';
const [systemTheme, setSystemTheme] = createSignal<Theme>(system());
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const initial = readPreference(read(PREFERENCE_KEY), system(), read('listik-theme'), read('listik-theme-system'));
const [preference, setPreference] = createSignal(initial);
export { preference };
let desktop: ThemeState | null = null;
try { if (window.listikDesktop?.version === 1) desktop = readDesktopTheme(window.listikDesktop.getTheme()); } catch { /* Web fallback. */ }
const [omarchyAvailable, setOmarchyAvailable] = createSignal(Boolean(desktop?.managed && desktop.palette));
export { omarchyAvailable, systemTheme, externalPalette };
const [externalPalette, setExternalPalette] = createSignal(desktop?.palette ?? null);
const [theme, setThemeSignal] = createSignal<Theme>(system());
export { theme };
let tokenNames: string[] = [];
function apply() {
  const resolved = resolveTheme(preference(), system(), desktop);
  for (const key of tokenNames) document.documentElement.style.removeProperty(key);
  tokenNames = Object.keys(resolved.tokens);
  for (const [key, value] of Object.entries(resolved.tokens)) document.documentElement.style.setProperty(key, value);
  document.documentElement.dataset.theme = resolved.mode;
  document.documentElement.dataset.palette = resolved.definition.id;
  setThemeSignal(resolved.mode);
  const background = resolved.palette?.colors.background ?? (resolved.mode === 'dark' ? '#1c1c1e' : '#ffffff');
  document.documentElement.style.backgroundColor = background;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = background;
  try { window.listikDesktop?.setBackground?.(background); } catch { /* Older shells keep their own background. */ }
}
function save() {
  try {
    localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preference()));
    localStorage.removeItem('listik-theme'); localStorage.removeItem('listik-theme-system');
  } catch { /* The selection still lasts for this session. */ }
}
apply(); save();
if (window.listikDesktop?.version === 1) window.listikDesktop.onTheme(value => {
  const next = readDesktopTheme(value);
  if (!next) return;
  if (next.managed && !next.palette && desktop?.managed && desktop.palette) return;
  desktop = next;
  setOmarchyAvailable(Boolean(next.managed && next.palette));
  setExternalPalette(next.managed ? next.palette : null);
  apply();
});
media?.addEventListener('change', () => { setSystemTheme(system()); apply(); });
// Settings follow other windows in the same browser profile.
window.addEventListener('storage', e => {
  if (e.key !== PREFERENCE_KEY && e.key !== null) return;
  setPreference(readPreference(read(PREFERENCE_KEY), system())); apply();
});
function changeSelection(update: () => void) {
  // Persist synchronously; animation must not delay a quick follow-up selection.
  update(); save();
  apply();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.body.animate([{ opacity: .85 }, { opacity: 1 }], { duration: 160 });
  }
}
export function setThemeId(themeId: string) {
  changeSelection(() => setPreference(readPreference(JSON.stringify({ ...preference(), themeId }), system())));
}
export function setThemeMode(mode: ThemeMode) { changeSelection(() => setPreference({ ...preference(), mode })); }
export function resetTheme() { setPreference({ ...DEFAULT_PREFERENCE }); save(); apply(); }
const [themePanelOpen, setThemePanelOpen] = createSignal(false);
export { themePanelOpen };
let returnFocus: HTMLElement | null = null;
export function openThemePanel() { returnFocus = document.activeElement as HTMLElement | null; setThemePanelOpen(true); }
export function closeThemePanel() {
  setThemePanelOpen(false);
  queueMicrotask(() => {
    if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus();
    else document.querySelector<HTMLButtonElement>('.menu-button')?.focus();
  });
}
