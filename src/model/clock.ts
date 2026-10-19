/**
 * Hybrid logical clock, one per device: wall-clock milliseconds that never
 * go backwards and never repeat here, and that jump ahead of any stamp seen
 * from another device. Stamps order concurrent edits of the same field across
 * devices (merge.ts), so "later" must mean later even when clocks disagree.
 */
let last = 0;

export const clock = {
  /** A stamp greater than every stamp issued or observed so far. */
  now(): number {
    const t = Date.now();
    last = t > last ? t : last + 1;
    return last;
  },
  /** A stamp from another device: stay ahead of it. */
  observe(t: number): void {
    if (Number.isFinite(t) && t > last) last = t;
  },
};
