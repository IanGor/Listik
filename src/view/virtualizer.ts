import type { RowsListener, VisibleRows } from '../model/rows';
import type { NodeId } from '../model/types';
import { spliceAll } from '../util/splice';
import { Fenwick } from './fenwick';

export type Estimate = (id: NodeId, depth: number) => number;

/**
 * Row offsets for variable-height virtualization, kept in step with
 * VisibleRows. Heights measured in the DOM are cached per node, so they
 * survive structural changes; unmeasured rows use the estimate.
 */
export class Virtualizer implements RowsListener {
  private heights: number[] = [];
  private tree = new Fenwick();
  private measured = new Map<NodeId, number>();
  private rows: VisibleRows;
  private estimate: Estimate;
  private unsubscribe: () => void;

  constructor(rows: VisibleRows, estimate: Estimate) {
    this.rows = rows;
    this.estimate = estimate;
    this.reset();
    this.unsubscribe = rows.subscribe(this);
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** New layout metrics (e.g. the width changed): every height is stale. */
  setEstimate(estimate: Estimate): void {
    this.estimate = estimate;
    this.measured.clear();
    this.reset();
  }

  reset(): void {
    const { ids, depths } = this.rows;
    this.heights = ids.map((id, i) => this.guess(id, depths[i]));
    this.tree.build(this.heights);
  }

  splice(at: number, removed: number, inserted: number): void {
    const { ids, depths } = this.rows;
    const added = new Array<number>(inserted);
    for (let k = 0; k < inserted; k++) added[k] = this.guess(ids[at + k], depths[at + k]);
    this.heights = spliceAll(this.heights, at, removed, added);
    this.tree.build(this.heights);
  }

  get total(): number {
    return this.tree.total();
  }

  offsetOf(i: number): number {
    return this.tree.prefix(i);
  }

  heightOf(i: number): number {
    return this.heights[i] ?? 0;
  }

  indexAt(y: number): number {
    return this.tree.find(y);
  }

  /** Records the measured height of row `i`; returns the change in px. */
  measure(i: number, h: number): number {
    this.measured.set(this.rows.ids[i], h);
    const d = h - this.heights[i];
    if (d !== 0) {
      this.heights[i] = h;
      this.tree.add(i, d);
    }
    return d;
  }

  /** Rows [start, end) covering [top - overscan, top + height + overscan). */
  range(top: number, height: number, overscan: number): [number, number] {
    const n = this.heights.length;
    if (n === 0) return [0, 0];
    const start = this.indexAt(Math.max(0, top - overscan));
    const end = Math.min(n, this.indexAt(top + height + overscan) + 1);
    return [start, end];
  }

  private guess(id: NodeId, depth: number): number {
    return this.measured.get(id) ?? this.estimate(id, depth);
  }
}
