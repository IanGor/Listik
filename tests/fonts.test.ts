import { describe, expect, it } from 'vitest';
import { CANDIDATES, DEFAULT_STACK, KINDS, PER_KIND, installed, pickFonts, platformOf } from '../src/view/fonts';

describe('platform', () => {
  it('is read from the browser, an iPad posing as a Mac included', () => {
    expect(platformOf({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', platform: 'Linux x86_64' })).toBe('linux');
    expect(platformOf({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' })).toBe('windows');
    expect(platformOf({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel' })).toBe('apple');
    expect(platformOf({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone' })).toBe('apple');
    expect(platformOf({ userAgent: 'Mozilla/5.0 (Linux; Android 13; IN2013) Chrome/130 Mobile', platform: 'Linux armv81' })).toBe('android');
  });
});

describe('installed', () => {
  // A browser that has "Known" only: the text set in it is wider than in any fallback.
  const widths: Record<string, number> = { monospace: 100, serif: 90, 'sans-serif': 95 };
  const measure = (font: string) => {
    const m = /^"(.+)", (.+)$/.exec(font);
    if (!m) return widths[font];
    return m[1] === 'Known' ? 120 : widths[m[2]];
  };

  it('tells a font that is there from one that falls back', () => {
    expect(installed('Known', measure)).toBe(true);
    expect(installed('Missing', measure)).toBe(false);
  });
});

describe('the offer', () => {
  it('has at most three of each kind, the system one first, only of those installed', () => {
    const picked = pickFonts('linux', (family) => ['DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'Ubuntu Mono', 'Noto Sans'].includes(family));
    expect(picked.mono.map((f) => f.name)).toEqual(['Системный моноширинный', 'DejaVu Sans Mono', 'Liberation Mono']);
    expect(picked.mono[0].stack).toBe(DEFAULT_STACK);
    expect(picked.mono[1].stack).toBe('"DejaVu Sans Mono", monospace');
    expect(picked.sans.map((f) => f.name)).toEqual(['Системный', 'Noto Sans']);
    expect(picked.serif.map((f) => f.name)).toEqual(['Системный с засечками']);
  });

  it('is less than three when there is not enough, never empty: the system fonts are always there', () => {
    for (const platform of Object.keys(CANDIDATES) as (keyof typeof CANDIDATES)[]) {
      const bare = pickFonts(platform, () => false);
      for (const kind of KINDS) {
        expect(bare[kind].length).toBe(1);
        const full = pickFonts(platform, () => true);
        expect(full[kind].length).toBeLessThanOrEqual(PER_KIND);
      }
    }
  });

  it('starts with the default on every platform and every stack falls back to its kind', () => {
    for (const platform of Object.keys(CANDIDATES) as (keyof typeof CANDIDATES)[]) {
      const all = pickFonts(platform, () => true);
      expect(all.mono[0].stack).toBe(DEFAULT_STACK);
      expect(all.mono.every((f) => /monospace$/.test(f.stack))).toBe(true);
      expect(all.sans.every((f) => /sans-serif$/.test(f.stack))).toBe(true);
      expect(all.serif.every((f) => /serif$/.test(f.stack))).toBe(true);
    }
  });
});
