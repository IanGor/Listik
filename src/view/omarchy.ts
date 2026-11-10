export type Palette = { mode: 'light' | 'dark'; colors: Record<string, string> };
export type ThemeState = { version: 1; managed: boolean; palette: Palette | null };
export type DesktopBridge = {
  version: 1;
  getTheme(): unknown;
  onTheme(callback: (state: unknown) => void): () => void;
};
declare global { interface Window { listikDesktop?: DesktopBridge } }

export function readDesktopTheme(value: unknown): ThemeState | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (s.version !== 1 || typeof s.managed !== 'boolean') return null;
  if (s.palette === null) return { version: 1, managed: s.managed, palette: null };
  if (!s.palette || typeof s.palette !== 'object') return null;
  const p = s.palette as Record<string, unknown>;
  if ((p.mode !== 'light' && p.mode !== 'dark') || !p.colors || typeof p.colors !== 'object') return null;
  const colors: Record<string, string> = {};
  for (const [key, color] of Object.entries(p.colors)) {
    if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) return null;
    colors[key] = color;
  }
  if (!colors.background || !colors.foreground) return null;
  return { version: 1, managed: s.managed, palette: { mode: p.mode, colors } };
}

const rgb = (color: string) => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
const luminance = (color: string) => rgb(color).reduce((sum, v, i) => {
  const x = v / 255;
  return sum + (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
}, 0);
export const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
function mix(a: string, b: string, amount: number): string {
  const second = rgb(b);
  return '#' + rgb(a).map((v, i) => Math.round(v + (second[i] - v) * amount).toString(16).padStart(2, '0')).join('');
}
function readable(color: string, background: string | string[]): string {
  const backgrounds = typeof background === 'string' ? [background] : background;
  const score = (ink: string) => Math.min(...backgrounds.map(bg => contrast(ink, bg)));
  if (score(color) >= 4.5) return color;
  const end = score('#ffffff') > score('#000000') ? '#ffffff' : '#000000';
  for (let i = 1; i <= 100; i++) {
    const next = mix(color, end, i / 100);
    if (score(next) >= 4.5) return next;
  }
  return end;
}

export function paletteToTokens({ colors: c, mode }: Palette): Record<string, string> {
  const bg = c.background;
  const baseInk = contrast('#ffffff', bg) > contrast('#000000', bg) ? '#ffffff' : '#000000';
  const opposite = baseInk === '#ffffff' ? '#000000' : '#ffffff';
  // Keep all text surfaces on the same readable side, including mid-gray themes.
  const surface = (color: string, amount: number) => {
    const result = mix(bg, color, amount);
    return contrast(baseInk, result) >= 4.5 ? result : mix(bg, opposite, amount);
  };
  const surface1 = surface(c.foreground, 0.04);
  const surface2 = surface(c.foreground, 0.08);
  const chip = surface(c.accent ?? c.foreground, 0.12);
  const tagChip = surface(c.cyan ?? c.green ?? c.foreground, 0.1);
  const tagStrong = surface(c.cyan ?? c.green ?? c.foreground, 0.2);
  const hit = surface(c.yellow ?? c.accent ?? c.foreground, 0.22);
  const selection = surface(c.accent ?? c.foreground, 0.2);
  const margin = surface(c.cyan ?? c.green ?? c.foreground, 0.15);
  const backgrounds = [bg, surface1, surface2, chip, tagChip, tagStrong, hit, selection, margin];
  const ink = (color: string | undefined) => readable(color ?? c.accent ?? c.foreground, backgrounds);
  const text = ink(c.foreground);
  const primary = ink(c.accent ?? c.blue);
  const tag = ink(c.cyan ?? c.green);
  const shadow = mode === 'light' ? '#00000020' : '#00000080';
  return {
    '--canvas': bg, '--surface': surface1, '--surface-2': surface2,
    '--window': bg, '--material': surface1, '--material-solid': surface1,
    '--popover': bg, '--popover-solid': bg, '--material-border': mix(bg, text, 0.15),
    '--control-border': ink(mix(bg, text, 0.5)),
    '--text': text, '--muted': ink(mix(bg, text, 0.65)), '--faint': ink(mix(bg, text, 0.5)),
    '--hairline': mix(bg, text, 0.15), '--guide': mix(bg, text, 0.1), '--halo': surface(primary, 0.2),
    '--primary': primary, '--link': ink(c.blue ?? c.accent), '--chip': chip,
    '--tag': tag, '--tag-chip': tagChip, '--tag-chip-strong': tagStrong,
    '--tag-on-strong': readable(tag, tagStrong), '--on-primary': readable('#ffffff', primary),
    '--marker-swatch': ink(c.yellow), '--hit': hit,
    '--marker': (c.yellow ?? primary) + '66', '--sketch-margin': margin,
    '--danger': ink(c.red), '--bold': ink(c.blue), '--italic': ink(c.green),
    '--ring': primary + '44', '--selection': selection,
    '--shadow': `0 1px 2px ${shadow}`, '--shadow-pop': `0 12px 32px ${shadow}`, '--scrim': '#00000066',
  };
}
