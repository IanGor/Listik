import { describe, expect, it } from 'vitest';
import { Fenwick } from '../src/view/fenwick';
import { rng } from './helpers';

describe('Fenwick', () => {
  it('matches naive prefix sums under random updates', () => {
    const rand = rng(7);
    const values = Array.from({ length: 1000 }, () => 10 + Math.floor(rand() * 90));
    const f = new Fenwick();
    f.build(values);
    for (let step = 0; step < 500; step++) {
      const i = Math.floor(rand() * values.length);
      const d = Math.floor(rand() * 50) - 25;
      values[i] += d;
      f.add(i, d);
    }
    let sum = 0;
    for (let i = 0; i <= values.length; i++) {
      expect(f.prefix(i)).toBe(sum);
      sum += values[i] ?? 0;
    }
    expect(f.total()).toBe(sum);
  });

  it('finds the index whose span contains an offset', () => {
    const f = new Fenwick();
    f.build([10, 20, 30]);
    expect([0, 9, 10, 29, 30, 59, 60, 1e9].map((y) => f.find(y))).toEqual([0, 0, 1, 1, 2, 2, 2, 2]);
  });

  it('reuses its buffer when rebuilt smaller', () => {
    const f = new Fenwick();
    f.build([1, 2, 3, 4, 5]);
    f.build([7, 8]);
    expect(f.size).toBe(2);
    expect(f.total()).toBe(15);
    expect(f.find(0)).toBe(0);
  });

  it('handles an empty list', () => {
    const f = new Fenwick();
    f.build([]);
    expect(f.total()).toBe(0);
    expect(f.find(100)).toBe(0);
  });
});
