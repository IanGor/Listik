import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCE, THEMES, readPreference, resolveTheme } from '../src/view/palettes';
import { contrast } from '../src/view/omarchy';

describe('theme catalogue', () => {
  it('preserves requested mode while resolving unavailable variants', () => {
    const preference = { version: 1 as const, themeId: 'dracula', mode: 'light' as const };
    expect(resolveTheme(preference, 'light', null).mode).toBe('dark');
    expect(preference.mode).toBe('light');
    expect(resolveTheme({ ...preference, themeId: 'listik' }, 'dark', null).mode).toBe('light');
    expect(resolveTheme({ ...preference, themeId: 'kanagawa' }, 'dark', null).palette?.colors.background).toBe('#f2ecbc');
  });
  it('migrates only valid legacy picks; rejects malformed new settings', () => {
    expect(readPreference(null, 'dark', 'light', 'dark').mode).toBe('light');
    expect(readPreference(null, 'light', 'dark', 'dark')).toEqual(DEFAULT_PREFERENCE);
    for (const raw of ['{}', 'null', 'bad', '{"version":1,"themeId":"evil","mode":"dark"}']) expect(readPreference(raw, 'light')).toEqual(DEFAULT_PREFERENCE);
  });
  it('uses external colors only for explicit Omarchy', () => {
    const desktop = { version: 1 as const, managed: true, palette: { mode: 'dark' as const, colors: { background: '#111c18', foreground: '#c1c497' } } };
    expect(resolveTheme(DEFAULT_PREFERENCE, 'light', desktop).palette).toBeNull();
    expect(resolveTheme({ ...DEFAULT_PREFERENCE, themeId: 'omarchy' }, 'light', desktop).palette).toBe(desktop.palette);
    expect(resolveTheme({ ...DEFAULT_PREFERENCE, themeId: 'omarchy' }, 'light', null).mode).toBe('light');
  });
  for (const def of THEMES) for (const mode of ['dark', 'light'] as const) {
    if (!def[mode]) continue;
    it(`${def.id} ${mode}: all text roles stay readable on every derived surface`, () => {
      const { tokens } = resolveTheme({ version: 1, themeId: def.id, mode }, 'dark', null);
      for (const ink of ['--text', '--muted', '--faint', '--primary', '--link', '--danger', '--tag', '--bold', '--italic']) {
        for (const bg of ['--canvas', '--surface', '--surface-2', '--chip', '--selection', '--hit', '--sketch-margin']) {
          expect(contrast(tokens[ink]!, tokens[bg]!), `${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
