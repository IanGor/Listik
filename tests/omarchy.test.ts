import { describe, expect, it } from 'vitest';
import { readDesktopTheme, paletteToTokens, contrast } from '../src/view/omarchy';

describe('Omarchy bridge and palette', () => {
  it('accepts v1, rejects unknown protocols, modes and CSS injection', () => {
    expect(readDesktopTheme(undefined)).toBeNull();
    expect(readDesktopTheme({ version: 2, managed: true, palette: null })).toBeNull();
    expect(readDesktopTheme({ version: 1, managed: true, palette: { mode: 'dark', colors: { background: 'url(evil)', foreground: '#ffffff' } } })).toBeNull();
    expect(readDesktopTheme({ version: 1, managed: true, palette: null })?.managed).toBe(true);
    expect(readDesktopTheme({ version: 1, managed: true, palette: { mode: 'auto', colors: { background: '#000000', foreground: '#ffffff' } } })).toBeNull();
  });
  for (const [mode, background, foreground] of [['dark', '#1f1f28', '#dcd7ba'], ['light', '#faf9f5', '#1f1e1c'], ['dark', '#777777', '#777777']] as const) {
    it(`keeps text and states readable on ${background}`, () => {
      const tokens = paletteToTokens({ mode, colors: { background, foreground, accent: '#888888', red: '#999999', green: '#666666' } });
      expect(tokens['--canvas']).toBe(background);
      for (const name of ['--text', '--muted', '--faint', '--primary', '--link', '--tag', '--bold', '--italic', '--danger']) {
        for (const surface of ['--canvas', '--surface', '--surface-2', '--selection', '--hit', '--material', '--popover']) {
          expect(contrast(tokens[name], tokens[surface])).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(tokens['--on-primary'], tokens['--primary'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['--tag-on-strong'], tokens['--tag-chip-strong'])).toBeGreaterThanOrEqual(4.5);
      expect(Object.keys(tokens)).toContain('--scrim');
    });
  }
});
