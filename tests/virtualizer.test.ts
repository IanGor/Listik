import { describe, expect, it } from 'vitest';
import { setCollapsed } from '../src/model/commands';
import { Virtualizer } from '../src/view/virtualizer';
import { setup } from './helpers';

const ROW = 20;

describe('Virtualizer', () => {
  it('lays rows out from estimates and measurements', () => {
    const { rows } = setup(['a', 'b', 'c', 'd']);
    const v = new Virtualizer(rows, () => ROW);
    expect(v.total).toBe(80);
    expect(v.measure(1, 50)).toBe(30);
    expect([v.offsetOf(0), v.offsetOf(1), v.offsetOf(2), v.total]).toEqual([0, 20, 70, 110]);
    expect(v.indexAt(69)).toBe(1);
    expect(v.indexAt(70)).toBe(2);
  });

  it('returns the rows covering the viewport plus overscan', () => {
    const { rows } = setup(Array.from({ length: 100 }, (_, i) => `r${i}`));
    const v = new Virtualizer(rows, () => ROW);
    expect(v.range(1000, 200, 0)).toEqual([50, 61]);
    expect(v.range(1000, 200, 100)).toEqual([45, 66]);
    expect(v.range(0, 200, 100)).toEqual([0, 16]);
  });

  it('keeps measured heights per node across structural changes', () => {
    const { rows, ctx, run } = setup(['a', '  b', 'c']);
    const v = new Virtualizer(rows, () => ROW);
    v.measure(2, 60); // c
    run(() => setCollapsed(ctx, 'a', true));
    expect(rows.ids).toEqual(['a', 'c']);
    expect(v.heightOf(1)).toBe(60);
    expect(v.total).toBe(80);
    run(() => setCollapsed(ctx, 'a', false));
    expect(v.total).toBe(100);
  });

  it('drops measurements when the estimate changes', () => {
    const { rows } = setup(['a', 'b']);
    const v = new Virtualizer(rows, () => ROW);
    v.measure(0, 99);
    v.setEstimate(() => 30);
    expect(v.total).toBe(60);
  });
});
