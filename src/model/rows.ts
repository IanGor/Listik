import { spliceAll } from '../util/splice';
import type { Doc, DocListener } from './doc';
import type { NodeId, Op, OutlineNode } from './types';

export interface RowsListener {
  /** `removed` rows at `at` were dropped, then `inserted` rows now at `at` were added. */
  splice?(at: number, removed: number, inserted: number): void;
  /** The whole list was rebuilt. */
  reset?(): void;
}

/**
 * The outline flattened into visible rows in pre-order. A subtree always
 * occupies a contiguous range, so ops patch the list locally instead of
 * rebuilding it.
 */
export class VisibleRows implements DocListener {
  ids: NodeId[] = [];
  depths: number[] = [];
  /** Bumped on every change; the view subscribes to this. */
  version = 0;
  private doc: Doc;
  private listeners = new Set<RowsListener>();
  private unsubscribe: () => void;

  constructor(doc: Doc) {
    this.doc = doc;
    this.rebuild();
    this.unsubscribe = doc.subscribe(this);
  }

  dispose(): void {
    this.unsubscribe();
  }

  subscribe(listener: RowsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get length(): number {
    return this.ids.length;
  }

  expanded(n: OutlineNode): boolean {
    return !n.collapsed;
  }

  indexOf(id: NodeId, from = 0): number {
    return this.ids.indexOf(id, from);
  }

  /** First row index after the subtree that starts at row `i`. */
  subtreeEnd(i: number): number {
    const d = this.depths[i];
    let j = i + 1;
    while (j < this.depths.length && this.depths[j] > d) j++;
    return j;
  }

  rebuild(): void {
    this.ids = [];
    this.depths = [];
    for (const c of this.doc.get(this.doc.root).children) this.collect(c, 0, this.ids, this.depths);
    this.version++;
    for (const l of this.listeners) l.reset?.();
  }

  op(op: Op): void {
    switch (op.t) {
      case 'setText':
        return;
      case 'insert':
        this.show(op.node.id);
        break;
      case 'remove':
        this.hide(op.node.id);
        break;
      case 'move':
        this.hide(op.id);
        this.show(op.id);
        break;
      case 'setCollapsed':
        this.refreshChildren(op.id);
        break;
    }
    this.version++;
  }

  /** Appends rows for `id` and its visible descendants, in pre-order. */
  private collect(id: NodeId, depth: number, ids: NodeId[], depths: number[]): void {
    const stackIds = [id];
    const stackDepths = [depth];
    while (stackIds.length) {
      const nid = stackIds.pop()!;
      const d = stackDepths.pop()!;
      ids.push(nid);
      depths.push(d);
      const n = this.doc.get(nid);
      if (!this.expanded(n)) continue;
      for (let k = n.children.length - 1; k >= 0; k--) {
        stackIds.push(n.children[k]);
        stackDepths.push(d + 1);
      }
    }
  }

  private hide(id: NodeId): void {
    const i = this.indexOf(id);
    if (i < 0) return;
    this.removeRows(i, this.subtreeEnd(i));
  }

  /** Inserts rows for a node that is already in its final place in the doc. */
  private show(id: NodeId): void {
    const n = this.doc.get(id);
    const parent = this.doc.get(n.parent!);
    let parentRow = -1;
    if (parent.id !== this.doc.root) {
      parentRow = this.indexOf(parent.id);
      if (parentRow < 0 || !this.expanded(parent)) return;
    }
    const k = parent.children.indexOf(id);
    const at = k === 0
      ? parentRow + 1
      : this.subtreeEnd(this.indexOf(parent.children[k - 1], parentRow + 1));
    const depth = parentRow < 0 ? 0 : this.depths[parentRow] + 1;
    this.insertRows(at, id, depth);
  }

  private refreshChildren(id: NodeId): void {
    const i = this.indexOf(id);
    if (i < 0) return;
    this.removeRows(i + 1, this.subtreeEnd(i));
    const n = this.doc.get(id);
    if (!this.expanded(n)) return;
    let at = i + 1;
    for (const c of n.children) at = this.insertRows(at, c, this.depths[i] + 1);
  }

  private removeRows(from: number, to: number): void {
    if (to <= from) return;
    this.ids.splice(from, to - from);
    this.depths.splice(from, to - from);
    for (const l of this.listeners) l.splice?.(from, to - from, 0);
  }

  /** Inserts the rows of subtree `id` at row `at`; returns the index after them. */
  private insertRows(at: number, id: NodeId, depth: number): number {
    const ids: NodeId[] = [];
    const depths: number[] = [];
    this.collect(id, depth, ids, depths);
    this.ids = spliceAll(this.ids, at, 0, ids);
    this.depths = spliceAll(this.depths, at, 0, depths);
    for (const l of this.listeners) l.splice?.(at, 0, ids.length);
    return at + ids.length;
  }
}
