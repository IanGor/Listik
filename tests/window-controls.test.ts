import { describe, expect, it } from 'vitest';
import { CONTROLS_INSET, controlsInset } from '../src/view/window-controls';

const screen = { w: 1376, h: 1032 };

describe('controlsInset', () => {
  it('leaves the name in place when the app fills the screen', () => {
    expect(controlsInset({ w: 1376, h: 1032 }, screen)).toBe(0);
    expect(controlsInset({ w: 1370, h: 1030 }, screen)).toBe(0);
  });

  it('makes room for the controls in a window', () => {
    expect(controlsInset({ w: 1376, h: 900 }, screen)).toBe(CONTROLS_INSET);
    expect(controlsInset({ w: 900, h: 1032 }, screen)).toBe(CONTROLS_INSET);
  });
});
