import { walkSnapshot, type Doc, type DocListener } from './doc';
import type { NodeId, Op, OutlineNode } from './types';

/**
 * Open tasks (a checkbox, not checked) in the outline, and for any bullet
 * the first of them inside it, top first, with how many there are: what a
 * folded bullet shows under it (view/Row.tsx), so its tasks are seen
 * without opening it.
 *
 * The set of open tasks follows the ops (task state, inserts, deletions
 * through the trash), so it costs nothing until asked. Asked after a
 * change, the counts are rebuilt once from the open tasks alone (each one
 * counts for every bullet above it), and the first task under a bullet is
 * looked for only when that bullet asks.
 */
export class PendingTasks implements DocListener {
  /** Bumped when what is open, or where it lies, may have changed. */
  version = 0;
  private open = new Set<NodeId>();
  private built = -1;
  private first = new Map<NodeId, NodeId>();
  private counts = new Map<NodeId, number>();
  private doc: Doc;
  private unsubscribe: () => void;

  constructor(doc: Doc) {
    this.doc = doc;
    doc.walk(doc.root, (n) => this.see(n));
    this.unsubscribe = doc.subscribe(this);
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** A mirror's task state is its original's: the original counts, once. Returns whether the set changed. */
  private see(n: OutlineNode): boolean {
    const open = n.todo && !n.done && !n.mirrorOf;
    if (open === this.open.has(n.id)) return false;
    if (open) this.open.add(n.id);
    else this.open.delete(n.id);
    return true;
  }

  private drop(id: NodeId): boolean {
    return this.open.delete(id);
  }

  /**
   * Only what touches an open task bumps the version: its state, or a
   * subtree holding one coming, going or moving. Typing, Enter and moving
   * plain bullets cost nothing here.
   */
  op(op: Op, doc: Doc): void {
    let changed = false;
    switch (op.t) {
      case 'setTodo':
      case 'setDone':
      case 'setMirror': {
        const n = doc.nodes.get(op.id);
        changed = n && doc.inOutline(n.id) ? this.see(n) : this.drop(op.id);
        break;
      }
      case 'insert':
        if (doc.inOutline(op.parent)) walkSnapshot(op.node, (s) => { changed = this.see(doc.get(s.id)) || changed; });
        break;
      case 'remove':
        walkSnapshot(op.node, (s) => { changed = this.drop(s.id) || changed; });
        break;
      case 'move': {
        const now = doc.inOutline(op.to.parent);
        if (now !== doc.inOutline(op.from.parent)) doc.walk(op.id, (n) => { changed = (now ? this.see(n) : this.drop(n.id)) || changed; });
        // Within the outline: the tasks inside it lie elsewhere now (counts may be stale: then bump anyway).
        else changed = this.open.has(op.id) || this.counts.has(op.id) || this.built !== this.version;
        break;
      }
    }
    if (changed) this.version++;
  }

  /** Is the bullet itself an open task? */
  isOpen(id: NodeId): boolean {
    return this.open.has(id);
  }

  /** The first open task inside `id` (not `id` itself), and how many open tasks are inside; null if none. */
  inside(id: NodeId): { task: NodeId; count: number } | null {
    this.build();
    const count = this.counts.get(id);
    if (!count) return null;
    let task = this.first.get(id);
    if (task === undefined) this.first.set(id, (task = this.firstBelow(id)));
    return { task, count };
  }

  /**
   * Top first: down the branches that hold open tasks only (`counts`), in
   * order, to the first open one. A few steps for a bullet on screen,
   * however big the document.
   */
  private firstBelow(id: NodeId): NodeId {
    let at = id;
    for (;;) {
      const next = this.doc.get(at).children.find((c) => this.open.has(c) || this.counts.has(c))!;
      if (this.open.has(next)) return next;
      at = next;
    }
  }

  /** How many open tasks lie inside each bullet: one walk up from each task. Firsts are found when asked. */
  private build(): void {
    if (this.built === this.version) return;
    this.built = this.version;
    this.first.clear();
    this.counts.clear();
    for (const task of this.open) {
      for (let p = this.doc.nodes.get(task)?.parent ?? null; p !== null; p = this.doc.get(p).parent) {
        this.counts.set(p, (this.counts.get(p) ?? 0) + 1);
      }
    }
  }
}
