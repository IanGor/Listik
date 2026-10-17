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
 * What a filter shows: `keep` holds the matches with all their ancestors
 * (including the root); a kept node shows only its kept children unless it
 * is in `open`, which shows all of them. Below that, nodes follow their own
 * collapsed state. Both sets grow while editing under the filter, so edited
 * bullets never vanish; the doc's collapsed state is never touched.
 */
export interface Filter {
  keep: Set<NodeId>;
  open: Set<NodeId>;
}

/**
 * Ops one transaction may patch in place. Past this (collapse all, a long
 * paste, their undo), rows stop patching and are rebuilt once on commit,
 * which beats hundreds of splices on a 200k-row list. Commands read rows
 * mid-transaction only before their first few ops, so they never see the
 * stale list.
 */
const PATCH_LIMIT = 16;

/**
 * Matches plus their ancestors up to `top` (the root, or the zoomed-in
 * bullet). Always includes `top`, so that no matches shows nothing rather
 * than everything.
 */
export function keepSet(doc: Doc, matches: Iterable<NodeId>, top: NodeId = doc.root): Set<NodeId> {
  const keep = new Set<NodeId>([top]);
  for (const id of matches) {
    for (let p: NodeId | null = id; p !== null && !keep.has(p); p = doc.get(p).parent) keep.add(p);
  }
  return keep;
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
  /** Whose children are the top-level rows: the root, or the zoomed-in bullet. */
  top: NodeId;
  private doc: Doc;
  private filter: Filter | null = null;
  /** Where the last `indexOf` found its row. */
  private hint = 0;
  /** Completed bullets hidden (Ctrl+O). */
  private hideDone = false;
  /** Ops patched in the current transaction, and whether patching gave up. */
  private patched = 0;
  private stale = false;
  private listeners = new Set<RowsListener>();
  private unsubscribe: () => void;

  constructor(doc: Doc) {
    this.doc = doc;
    this.top = doc.root;
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

  get filtered(): boolean {
    return this.filter !== null;
  }

  setFilter(filter: Filter | null): void {
    this.filter = filter;
    this.rebuild();
  }

  /** Zoom: show the subtree of `top` (its children at depth 0). */
  setTop(top: NodeId): void {
    this.top = top;
    this.hint = 0;
    this.rebuild();
  }

  /** Is `id` strictly inside the subtree shown (below `top`)? */
  contains(id: NodeId): boolean {
    for (let p = this.doc.get(id).parent; p !== null; p = this.doc.get(p).parent) {
      if (p === this.top) return true;
    }
    return false;
  }

  /** Under a filter: is the node shown as part of a match's path (folding then is filter-only)? */
  onPath(id: NodeId): boolean {
    return !!this.filter?.keep.has(id);
  }

  isOpen(id: NodeId): boolean {
    return !!this.filter?.open.has(id);
  }

  /** Under a filter: show all children of a node on a match's path, or only the path. */
  setOpen(id: NodeId, open: boolean): void {
    const f = this.filter;
    if (!f || f.open.has(id) === open) return;
    if (open) f.open.add(id);
    else f.open.delete(id);
    this.refreshChildren(id);
    this.version++;
  }

  /** Children of `n` shown below it, assuming `n` itself is shown. */
  shownChildren(n: OutlineNode): NodeId[] {
    const f = this.filter;
    let shown: NodeId[];
    if (f?.keep.has(n.id)) shown = f.open.has(n.id) ? n.children : n.children.filter((c) => f.keep.has(c));
    // The zoomed-in bullet always shows its children, whatever its own collapsed state.
    else shown = n.collapsed && n.id !== this.top ? [] : n.children;
    return this.hideDone && shown.length ? shown.filter((c) => !this.doc.get(c).done) : shown;
  }

  get hidesDone(): boolean {
    return this.hideDone;
  }

  /** Leaves completed bullets (with their subtrees) out of the rows, or shows them again. */
  setHideDone(hide: boolean): void {
    if (this.hideDone === hide) return;
    this.hideDone = hide;
    this.rebuild();
  }

  showsChildren(n: OutlineNode): boolean {
    return this.shownChildren(n).length > 0;
  }

  /** Has children that are not shown: drawn as a folded bullet. */
  hasHiddenChildren(n: OutlineNode): boolean {
    return n.children.length > this.shownChildren(n).length;
  }

  /**
   * Row of `id`, or -1. Without `from`, searches outward from the last row
   * found: commands touch rows next to each other, so on a 200k-row list
   * this is usually a few steps instead of a scan.
   */
  indexOf(id: NodeId, from?: number): number {
    if (from !== undefined) return this.ids.indexOf(id, from);
    const ids = this.ids;
    const n = ids.length;
    const h = Math.min(this.hint, n - 1);
    for (let d = 0; d <= h || h + d < n; d++) {
      if (h + d < n && ids[h + d] === id) return (this.hint = h + d);
      if (d > 0 && d <= h && ids[h - d] === id) return (this.hint = h - d);
    }
    return -1;
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
    for (const c of this.shownChildren(this.doc.get(this.top))) this.collect(c, 0, this.ids, this.depths);
    this.version++;
    for (const l of this.listeners) l.reset?.();
  }

  op(op: Op): void {
    if (op.t === 'setText' || op.t === 'setNote' || op.t === 'setTodo') return;
    // Completion changes rows only while completed bullets are hidden.
    if (op.t === 'setDone' && !this.hideDone) return;
    // Under a filter, edited bullets must stay visible (admit), which needs
    // the in-place patches; there, every op is patched.
    if (!this.filter && (this.stale || ++this.patched > PATCH_LIMIT)) {
      this.stale = true;
      this.version++;
      return;
    }
    switch (op.t) {
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
      case 'setDone':
        if (op.to) this.hide(op.id);
        else this.show(op.id);
        break;
    }
    this.version++;
  }

  /**
   * A command about to apply many ops says so up front: rows skip patching
   * for the rest of the transaction and rebuild once on commit. (Without the
   * hint they switch over after PATCH_LIMIT ops anyway.)
   */
  expectMany(): void {
    if (!this.filter) this.stale = true;
  }

  commit(): void {
    this.settle();
  }

  rollback(): void {
    this.settle();
  }

  /** End of a transaction: rebuild if patching gave up. */
  private settle(): void {
    this.patched = 0;
    if (!this.stale) return;
    this.stale = false;
    this.rebuild();
  }

  /** Appends rows for `id` and its shown descendants, in pre-order. */
  private collect(id: NodeId, depth: number, ids: NodeId[], depths: number[]): void {
    const stackIds = [id];
    const stackDepths = [depth];
    while (stackIds.length) {
      const nid = stackIds.pop()!;
      const d = stackDepths.pop()!;
      ids.push(nid);
      depths.push(d);
      const children = this.shownChildren(this.doc.get(nid));
      for (let k = children.length - 1; k >= 0; k--) {
        stackIds.push(children[k]);
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
    if (!this.contains(id)) return;
    if (this.filter) {
      const anchor = this.admit(n);
      if (anchor !== n.parent) return this.refreshChildren(anchor);
    }
    const parent = this.doc.get(n.parent!);
    let parentRow = -1;
    if (parent.id !== this.top) {
      parentRow = this.indexOf(parent.id);
      if (parentRow < 0) return;
    }
    const siblings = this.shownChildren(parent);
    const k = siblings.indexOf(id);
    if (k < 0) return;
    const at = k === 0
      ? parentRow + 1
      : this.subtreeEnd(this.indexOf(siblings[k - 1], parentRow + 1));
    const depth = parentRow < 0 ? 0 : this.depths[parentRow] + 1;
    this.insertRows(at, id, depth);
  }

  /**
   * Under a filter, a node that is inserted or moved stays visible: its
   * hidden ancestors join the path, and so does the node if its parent shows
   * only the path. Returns the nearest ancestor that is on screen (or `top`).
   */
  private admit(n: OutlineNode): NodeId {
    const f = this.filter!;
    let anchor = n.parent!;
    while (anchor !== this.top && this.indexOf(anchor) < 0) {
      f.keep.add(anchor);
      anchor = this.doc.get(anchor).parent!;
    }
    const parent = n.parent!;
    if (f.keep.has(parent) && !f.open.has(parent) && !f.keep.has(n.id)) {
      f.keep.add(n.id);
      f.open.add(n.id);
    }
    return anchor;
  }

  private refreshChildren(id: NodeId): void {
    if (id === this.top) return this.rebuild();
    const i = this.indexOf(id);
    if (i < 0) return;
    this.removeRows(i + 1, this.subtreeEnd(i));
    let at = i + 1;
    for (const c of this.shownChildren(this.doc.get(id))) at = this.insertRows(at, c, this.depths[i] + 1);
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
