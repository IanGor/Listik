import { paletteToTokens, type Palette, type ThemeState } from './omarchy';

export type Theme = 'dark' | 'light';
export type ThemeMode = Theme | 'auto';
export type ThemePreference = { version: 1; themeId: string; mode: ThemeMode };
export type ThemeDefinition = { id: string; name: string; source?: string; dark?: Palette; light?: Palette };
const palette = (mode: Theme, background: string, foreground: string, accent: string, red: string, green: string, yellow: string, blue: string, cyan = green): Palette =>
  ({ mode, colors: { background, foreground, accent, red, green, yellow, blue, cyan } });
const dark = (...colors: Parameters<typeof palette> extends [Theme, ...infer C] ? C : never) => palette('dark', ...colors);
const light = (...colors: Parameters<typeof palette> extends [Theme, ...infer C] ? C : never) => palette('light', ...colors);

/** Bundled snapshots; provenance and redistribution notices: docs/THEME-SOURCES.md. */
export const THEMES: readonly ThemeDefinition[] = [
  { id: 'listik', name: 'Listik · По умолчанию' },
  { id: 'omarchy', name: 'Omarchy' },
  { id: 'retro-82', name: 'Retro 82', source: 'omarchy', dark: dark('#05182e', '#f6dcac', '#faa968', '#f85525', '#028391', '#e97b3c', '#3f8f8a', '#8cbfb8') },
  { id: 'ristretto', name: 'Ristretto', source: 'omarchy', dark: dark('#2c2525', '#e6d9db', '#f38d70', '#fd6883', '#adda78', '#f9cc6c', '#f38d70', '#85dacc') },
  { id: 'kanagawa', name: 'Kanagawa', source: 'kanagawa.nvim', dark: dark('#1f1f28', '#dcd7ba', '#dcd7ba', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#6a9589'), light: light('#f2ecbc', '#545464', '#624c83', '#c84053', '#6f894e', '#77713f', '#4d699b', '#597b75') },
  { id: 'osaka-jade', name: 'Osaka Jade', source: 'omarchy', dark: dark('#111c18', '#c1c497', '#509475', '#ff5345', '#549e6a', '#e5c736', '#509475', '#2dd5b7') },
  { id: 'dracula', name: 'Dracula', source: 'dracula', dark: dark('#282a36', '#f8f8f2', '#bd93f9', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#8be9fd') },
  { id: 'catppuccin', name: 'Catppuccin', source: 'catppuccin', dark: dark('#1e1e2e', '#cdd6f4', '#cba6f7', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#94e2d5'), light: light('#eff1f5', '#4c4f69', '#8839ef', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#179299') },
  { id: 'gruvbox', name: 'Gruvbox', source: 'gruvbox', dark: dark('#282828', '#ebdbb2', '#d79921', '#cc241d', '#98971a', '#d79921', '#458588', '#689d6a'), light: light('#fbf1c7', '#3c3836', '#af3a03', '#9d0006', '#79740e', '#b57614', '#076678', '#427b58') },
  { id: 'tokyo-night', name: 'Tokyo Night', source: 'tokyonight.nvim', dark: dark('#1a1b26', '#c0caf5', '#7aa2f7', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#7dcfff'), light: light('#e1e2e7', '#3760bf', '#2e7de9', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#007197') },
  { id: 'nord', name: 'Nord', source: 'nord', dark: dark('#2e3440', '#d8dee9', '#88c0d0', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#8fbcbb') },
];
export const DEFAULT_PREFERENCE: ThemePreference = { version: 1, themeId: 'listik', mode: 'auto' };
export const PREFERENCE_KEY = 'listik-appearance';
export function readPreference(raw: string | null, system: Theme, legacy?: string | null, legacySystem?: string | null): ThemePreference {
  if (raw !== null) {
    try {
      const p = JSON.parse(raw);
      if (p?.version === 1 && THEMES.some(t => t.id === p.themeId) && ['dark', 'light', 'auto'].includes(p.mode)) return { version: 1, themeId: p.themeId, mode: p.mode };
    } catch { /* Invalid settings use the default. */ }
    return { ...DEFAULT_PREFERENCE };
  }
  return { ...DEFAULT_PREFERENCE, mode: (legacy === 'dark' || legacy === 'light') && legacySystem === system ? legacy : 'auto' };
}
export function resolveTheme(preference: ThemePreference, system: Theme, desktop: ThemeState | null) {
  const definition = THEMES.find(t => t.id === preference.themeId) ?? THEMES[0]!;
  const desired = preference.mode === 'auto' ? system : preference.mode;
  const external = definition.id === 'omarchy' && desktop?.managed ? desktop.palette : null;
  const palette = external || definition[desired] || definition.dark || definition.light || null;
  return { definition, palette, mode: palette?.mode ?? desired, tokens: palette ? paletteToTokens(palette) : {} as Record<string, string> };
}
