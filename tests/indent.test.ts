import { afterEach, describe, expect, it, vi } from 'vitest';
import { indentation } from '../src/view/indent';

/** A probe as wide as --indent, with the custom properties index.css gives it. */
function probe(indent: number, props: Record<string, string>) {
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => props[name] ?? '' }));
  return { getBoundingClientRect: () => ({ width: indent }) } as unknown as HTMLElement;
}

afterEach(() => vi.unstubAllGlobals());

describe('indentation', () => {
  it('a computer: one step a level, at any depth', () => {
    const at = indentation(probe(38, { '--deep': ' 1000', '--indent-deep': ' 38px' }));
    expect([0, 1, 10].map(at.at)).toEqual([0, 38, 380]);
    expect(at.levelAt(37)).toBe(0);
    expect(at.levelAt(38)).toBe(1);
    expect(at.levelAt(400)).toBe(10);
  });

  it('a phone: past --deep levels the narrower step; levelAt finds the level back', () => {
    const at = indentation(probe(28, { '--deep': ' 4', '--indent-deep': ' 12px' }));
    expect([0, 4, 5, 10].map(at.at)).toEqual([0, 112, 124, 184]);
    for (let d = 0; d <= 12; d++) {
      expect(at.levelAt(at.at(d))).toBe(d);
      expect(at.levelAt(at.at(d + 1) - 1)).toBe(d);
    }
  });

  it('no deep step given: the plain indent', () => {
    const at = indentation(probe(20, {}));
    expect(at.at(7)).toBe(140);
    expect(at.levelAt(139)).toBe(6);
  });
});
