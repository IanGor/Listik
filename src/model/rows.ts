import { spliceAll } from '../util/splice';
import type { Doc, DocListener } from './doc';
import type { NodeId, Op, OutlineNode } from './types';

/**
 * A row's key. A bullet shows once in the outline, and once more under every
 * mirror of a bullet it is inside (model/mirrors.ts), so rows are keyed by
 * where they show: outside any mirror the key is the bullet's id; inside a
 * mirror, the mirror row's key, SEP, the id ("m/x", or "m/m2/x" for a
 * mirror inside a mirror). Ids never hold SEP.
 */
export type RowKey = string;
export const SEP = '/';

/** The bullet a row shows. */
export function nodeOf(key: RowKey): NodeId {
  const i = key.lastIndexOf(SEP);
  return i < 0 ? key : key.slice(i + 1);
}

/** The key of the mirror row the row shows under ('' outside any mirror). */
export function contextOf(key: RowKey): RowKey {
  const i = key.lastIndexOf(SEP);
  return i < 0 ? '' : key.slice(0, i);
}

/** The key of bullet `id` shown under the mirror row `context`. */
export const keyIn = (context: RowKey, id: NodeId): RowKey => (context ? context + SEP + id : id);

const PLAIN: readonly RowKey[] = [''];

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
 *
 * A mirror's row shows the children of its original below it, as if they
 * were its own, all the way down (keys: RowKey). A bullet changed is patched
 * wherever it shows: outside any mirror and under each mirror row on the
 * list (`mirrors`). A mirror inside what it mirrors would show itself
 * without end: there it shows no children (`host`).
 */
export class VisibleRows implements DocListener {
  ids: RowKey[] = [];
  depths: number[] = [];
  /** Bumped on every change; the view subscribes to this. */
  version = 0;
  /** Whose children are the top-level rows: the root, or the zoomed-in bullet (never a mirror). */
  top: NodeId;
  private doc: Doc;
  private filter: Filter | null = null;
  /** Where the last `indexOf` found its row. */
  private hint = 0;
  /** Ops patched in the current transaction, and whether patching gave up. */
  private patched = 0;
  private stale = false;
  /** Keys of the mirror rows on the list: the contexts other rows may show in. */
  private mirrors = new Set<RowKey>();
  /**
   * How bullets fold under each mirror, apart from the other copies
   * (model/mirrors.ts): `mirror/bullet` → folded. A bullet with no entry
   * folds as the bullet does (`collapsed`). Kept by the view, per device,
   * like folding itself (never synced); `onFolds` hears of changes.
   */
  private folds = new Map<string, boolean>();
  onFolds: (() => void) | null = null;
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
    this.refreshAll(id);
    this.version++;
  }

  /**
   * The bullet whose children show under the row: the row's own, a mirror's
   * original. Null for a mirror with nothing to show: its original gone, or
   * the mirror inside its original, here or through the mirrors it shows in.
   */
  host(key: RowKey): OutlineNode | null {
    const n = this.doc.nodes.get(nodeOf(key));
    if (!n?.mirrorOf) return n ?? null;
    const target = this.doc.host(n.id);
    if (!target) return null;
    for (let k = key; k; k = contextOf(k)) if (this.doc.within(nodeOf(k), target.id)) return null;
    return target;
  }

  /** The key of bullet `id` shown right under the row `key` (`top` for the top level). */
  childKey(key: RowKey, id: NodeId): RowKey {
    return this.doc.get(nodeOf(key)).mirrorOf ? keyIn(key, id) : keyIn(contextOf(key), id);
  }

  /** The row the row `key` shows under; null at the top level. */
  parentKey(key: RowKey): RowKey | null {
    const n = this.doc.get(nodeOf(key));
    const context = contextOf(key);
    if (!context) return n.parent === this.top || n.parent === null ? null : n.parent;
    return n.parent === this.host(context)?.id ? context : keyIn(context, n.parent!);
  }

  /** Children of the row `key` (`top` for the top level) shown below it, assuming the row itself is shown: what folding and the filter leave. */
  shownChildren(key: RowKey): NodeId[] {
    const n = this.doc.get(nodeOf(key));
    const kids = this.host(key)?.children ?? [];
    const f = this.filter;
    if (f?.keep.has(n.id)) return f.open.has(n.id) ? kids : kids.filter((c) => f.keep.has(c));
    // The zoomed-in bullet always shows its children, whatever its own collapsed state.
    return key !== this.top && this.folded(key) ? [] : kids;
  }

  /** The fold entry of the row `key` under a mirror: the mirror's id, SEP, the bullet's. */
  private foldKey(key: RowKey): string {
    return nodeOf(contextOf(key)) + SEP + nodeOf(key);
  }

  /** Is the row folded: under a mirror the way it folds there, elsewhere as its bullet does. */
  folded(key: RowKey): boolean {
    const n = this.doc.get(nodeOf(key));
    if (this.folds.size && key.includes(SEP)) return this.folds.get(this.foldKey(key)) ?? n.collapsed;
    return n.collapsed;
  }

  /** Folds or unfolds a row under a mirror, there only: the other copies show the bullet as they did. */
  setFold(key: RowKey, folded: boolean): void {
    if (!contextOf(key) || this.folded(key) === folded) return;
    this.folds.set(this.foldKey(key), folded);
    // The fold is the mirror's: every row of that mirror on the list shows it.
    const mirror = nodeOf(contextOf(key));
    if (!this.stale) for (const m of [...this.mirrors]) if (nodeOf(m) === mirror) this.refreshRow(keyIn(m, nodeOf(key)));
    this.version++;
    this.onFolds?.();
  }

  /**
   * The bullet `id` is about to fold or unfold where it lives: every mirror
   * of a bullet around it, which shows it too, keeps it as it shows it now.
   */
  freeze(id: NodeId): void {
    const collapsed = this.doc.get(id).collapsed;
    let changed = false;
    for (let p = this.doc.get(id).parent; p !== null; p = this.doc.get(p).parent) {
      if (!this.doc.hasMirrors(p)) continue;
      for (const m of this.doc.copies(p)) {
        const key = m + SEP + id;
        if (m === p || this.folds.has(key)) continue;
        this.folds.set(key, collapsed);
        changed = true;
      }
    }
    if (changed) this.onFolds?.();
  }

  /** The folds under mirrors, to keep; `loadFolds` takes them back, leaving out mirrors that are gone. */
  foldEntries(): [string, boolean][] {
    return [...this.folds];
  }

  loadFolds(entries: [string, boolean][]): void {
    this.folds.clear();
    for (const [key, folded] of entries) {
      const i = key.indexOf(SEP);
      const m = this.doc.nodes.get(key.slice(0, i));
      if (m?.mirrorOf && this.doc.has(key.slice(i + 1))) this.folds.set(key, folded);
    }
    this.rebuild();
  }

  showsChildren(key: RowKey): boolean {
    return this.shownChildren(key).length > 0;
  }

  /** Is the row open: its arrow turned down, its children listed? */
  unfolded(key: RowKey): boolean {
    return this.showsChildren(key);
  }

  /** Has children that folding or the filter keep out of view: drawn as a folded bullet. */
  hasHiddenChildren(key: RowKey): boolean {
    return (this.host(key)?.children.length ?? 0) > this.shownChildren(key).length;
  }

  /**
   * Row of `key`, or -1. Without `from`, searches outward from the last row
   * found: commands touch rows next to each other, so on a 200k-row list
   * this is usually a few steps instead of a scan.
   */
  indexOf(key: RowKey, from?: number): number {
    if (from !== undefined) return this.ids.indexOf(key, from);
    const ids = this.ids;
    const n = ids.length;
    const h = Math.min(this.hint, n - 1);
    for (let d = 0; d <= h || h + d < n; d++) {
      if (h + d < n && ids[h + d] === key) return (this.hint = h + d);
      if (d > 0 && d <= h && ids[h - d] === key) return (this.hint = h - d);
    }
    return -1;
  }

  /**
   * The row showing `id` nearest to the row `near`: under the same mirror,
   * then under the mirrors around it, then outside any, then under any
   * other mirror. Commands name
   * bullets; this finds the row of one where the caret was. A row key in
   * `id` is taken as it is while it is on the list.
   */
  locate(id: RowKey, near: RowKey = id): RowKey | null {
    if (this.indexOf(id) >= 0 && (id.includes(SEP) || !this.mirrors.size)) return id;
    const node = nodeOf(id);
    // A key under a mirror that is gone (a copy taken out, `handOver`): the bullet where it is now.
    if (!this.mirrors.size) return this.indexOf(node) >= 0 ? node : null;
    for (let c = near; c; c = contextOf(c)) {
      if (this.mirrors.has(c) && this.indexOf(keyIn(c, node)) >= 0) return keyIn(c, node);
    }
    if (this.indexOf(node) >= 0) return node;
    // Under some other mirror, if anywhere.
    return this.ids.find((key) => nodeOf(key) === node) ?? null;
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
    this.mirrors.clear();
    for (const c of this.shownChildren(this.top)) this.collect(c, 0, this.ids, this.depths);
    this.version++;
    for (const l of this.listeners) l.reset?.();
  }

  op(op: Op): void {
    // Text and task state change no rows: completed bullets always show, struck through.
    if (op.t === 'setText' || op.t === 'setNote' || op.t === 'setTodo' || op.t === 'setDone') return;
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
        this.refreshMirrorsOf(op.node.id);
        break;
      case 'remove':
        this.hide(op.node.id);
        this.refreshMirrorsOf(op.node.id);
        break;
      case 'move':
        this.hide(op.id);
        this.show(op.id);
        this.refreshMirrorsIn(op.id);
        break;
      case 'setCollapsed':
        this.refreshAll(op.id);
        break;
      case 'setMirror':
        this.refreshAll(op.id);
        this.refreshMirrorsOf(op.id);
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

  /** Contexts a bullet may show in: outside any mirror, and under each mirror row on the list. */
  private contexts(): readonly RowKey[] {
    return this.mirrors.size ? ['', ...this.mirrors] : PLAIN;
  }

  /** Appends rows for `key` and its shown descendants, in pre-order. */
  private collect(key: RowKey, depth: number, ids: RowKey[], depths: number[]): void {
    const stackKeys = [key];
    const stackDepths = [depth];
    const stackContexts = [contextOf(key)];
    while (stackKeys.length) {
      const k = stackKeys.pop()!;
      const d = stackDepths.pop()!;
      let context = stackContexts.pop()!;
      ids.push(k);
      depths.push(d);
      if (this.doc.get(nodeOf(k)).mirrorOf) {
        this.mirrors.add(k);
        context = k;
      }
      const children = this.shownChildren(k);
      for (let j = children.length - 1; j >= 0; j--) {
        stackKeys.push(keyIn(context, children[j]));
        stackDepths.push(d + 1);
        stackContexts.push(context);
      }
    }
  }

  private hide(id: NodeId): void {
    for (const context of this.contexts()) {
      const i = this.indexOf(keyIn(context, id));
      if (i >= 0) this.removeRows(i, this.subtreeEnd(i));
    }
  }

  /** Inserts rows for a node that is already in its final place in the doc, wherever it shows. */
  private show(id: NodeId): void {
    const n = this.doc.get(id);
    if (this.filter && this.contains(id)) {
      const anchor = this.admit(n);
      if (anchor !== n.parent) {
        this.refreshAll(anchor);
        // Under a mirror the parent may show where the anchor does not.
        for (const context of this.contexts()) if (context && this.indexOf(keyIn(context, id)) < 0) this.showIn(context, n);
        return;
      }
    }
    for (const context of this.contexts()) this.showIn(context, n);
  }

  /** `show` under one mirror row (or outside any, for ''). */
  private showIn(context: RowKey, n: OutlineNode): void {
    const p = n.parent!;
    let parentKey: RowKey;
    if (!context) {
      if (!this.contains(n.id)) return;
      parentKey = p;
    } else {
      const host = this.host(context);
      if (!host || !this.doc.within(p, host.id)) return;
      parentKey = p === host.id ? context : keyIn(context, p);
    }
    let parentRow = -1;
    if (parentKey !== this.top) {
      parentRow = this.indexOf(parentKey);
      if (parentRow < 0) return;
    }
    const siblings = this.shownChildren(parentKey);
    const k = siblings.indexOf(n.id);
    if (k < 0) return;
    const at = k === 0
      ? parentRow + 1
      : this.subtreeEnd(this.indexOf(keyIn(context, siblings[k - 1]), parentRow + 1));
    const depth = parentRow < 0 ? 0 : this.depths[parentRow] + 1;
    this.insertRows(at, keyIn(context, n.id), depth);
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

  /** Re-lists the children of every row of bullet `id`. */
  private refreshAll(id: NodeId): void {
    if (id === this.top) return this.rebuild();
    for (const context of this.contexts()) {
      // Under a mirror, its original's children are the mirror row's.
      this.refreshRow(context && this.host(context)?.id === id ? context : keyIn(context, id));
    }
  }

  /**
   * A mirror of a mirror shows the children of the bullet at the end of the
   * chain (`Doc.host`): when a bullet on the way comes, goes or changes what
   * it mirrors, the mirror rows that lead through it show other children.
   */
  private refreshMirrorsOf(id: NodeId): void {
    for (const key of [...this.mirrors]) {
      const seen = new Set<NodeId>();
      for (let p = this.doc.nodes.get(nodeOf(key))?.mirrorOf; p && !seen.has(p); p = this.doc.nodes.get(p)?.mirrorOf) {
        if (p === id) {
          this.refreshRow(key);
          break;
        }
        seen.add(p);
      }
    }
  }

  /**
   * Whether a mirror row would show itself (`host`) depends on where the
   * mirrors in its key stand: after a move of `id`, the mirror rows with one
   * of those inside it are listed again.
   */
  private refreshMirrorsIn(id: NodeId): void {
    for (const key of [...this.mirrors]) {
      for (let k = key; k; k = contextOf(k)) {
        if (this.doc.within(nodeOf(k), id)) {
          this.refreshRow(key);
          break;
        }
      }
    }
  }

  /** Re-lists the children of the row `key`, if it is on the list. */
  private refreshRow(key: RowKey): void {
    const i = this.indexOf(key);
    if (i < 0) return;
    this.removeRows(i + 1, this.subtreeEnd(i));
    let inner = contextOf(key);
    if (this.doc.get(nodeOf(key)).mirrorOf) {
      this.mirrors.add(key);
      inner = key;
    } else this.mirrors.delete(key);
    let at = i + 1;
    for (const c of this.shownChildren(key)) at = this.insertRows(at, keyIn(inner, c), this.depths[i] + 1);
  }

  private removeRows(from: number, to: number): void {
    if (to <= from) return;
    if (this.mirrors.size) for (let j = from; j < to; j++) this.mirrors.delete(this.ids[j]);
    this.ids.splice(from, to - from);
    this.depths.splice(from, to - from);
    for (const l of this.listeners) l.splice?.(from, to - from, 0);
  }

  /** Inserts the rows of subtree `key` at row `at`; returns the index after them. */
  private insertRows(at: number, key: RowKey, depth: number): number {
    const ids: RowKey[] = [];
    const depths: number[] = [];
    this.collect(key, depth, ids, depths);
    this.ids = spliceAll(this.ids, at, 0, ids);
    this.depths = spliceAll(this.depths, at, 0, depths);
    for (const l of this.listeners) l.splice?.(at, 0, ids.length);
    return at + ids.length;
  }
}
