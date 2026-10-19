import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { nanoid } from 'nanoid';
import type { NodeId, NodeSnapshot, Op, OutlineNode } from './types';

export const newId = (): NodeId => nanoid();

/**
 * The hidden second root. Deleting a bullet moves it here instead of
 * destroying it, so an edit arriving late from another device still has
 * somewhere to land, and so undoing a deletion works across devices. The
 * trash is purged of old entries by compaction (`purgeTrash`).
 */
export const TRASH: NodeId = 'trash';

/**
 * Order key of a bullet in the trash: when it was thrown away, as a
 * fixed-width base-36 time, so the trash sorts by age and purging stops at
 * the first entry that is young enough. Never fed to `generateKeyBetween`.
 */
export const trashKey = (time: number): string => Math.max(0, Math.floor(time)).toString(36).padStart(9, '0');
export const trashTime = (key: string): number => parseInt(key, 36);

export interface DocListener {
  /** Called after each op is applied. */
  op?(op: Op, doc: Doc): void;
  /** Called once per transaction (or per standalone op) after all its ops. */
  commit?(ops: Op[], doc: Doc): void;
  /** Called after a failed transaction was rolled back (no commit follows). */
  rollback?(doc: Doc): void;
}

/** Visits every node of a snapshot subtree. */
export function walkSnapshot(root: NodeSnapshot, fn: (s: NodeSnapshot) => void): void {
  const stack = [root];
  while (stack.length) {
    const s = stack.pop()!;
    fn(s);
    for (const c of s.children) stack.push(c);
  }
}

export function invert(op: Op): Op {
  switch (op.t) {
    case 'insert':
      // Undoing a creation puts the bullet in the trash rather than destroying it (see TRASH).
      return { t: 'move', id: op.node.id, from: { parent: op.parent, order: op.node.order }, to: { parent: TRASH, order: trashKey(op.node.created) } };
    case 'remove':
      return { t: 'insert', parent: op.parent, node: op.node };
    case 'setText':
      return { t: 'setText', id: op.id, from: op.to, to: op.from, at: op.at };
    case 'move':
      return { t: 'move', id: op.id, from: op.to, to: op.from };
    case 'setCollapsed':
      return { t: 'setCollapsed', id: op.id, from: op.to, to: op.from };
    case 'setTodo':
      return { t: 'setTodo', id: op.id, from: op.to, to: op.from };
    case 'setDone':
      return { t: 'setDone', id: op.id, from: op.to, to: op.from };
    case 'setNote':
      return { t: 'setNote', id: op.id, from: op.to, to: op.from, at: op.at };
  }
}

/**
 * Plain, non-reactive outline tree. `apply` is the single mutation point;
 * indexes and views stay in sync by subscribing to ops.
 */
export class Doc {
  readonly nodes = new Map<NodeId, OutlineNode>();
  readonly root: NodeId;
  private listeners = new Set<DocListener>();
  private pending: Op[] | null = null;

  constructor(root: NodeId = 'root') {
    this.root = root;
    for (const id of [root, TRASH]) {
      this.nodes.set(id, {
        id, parent: null, children: [], order: '', text: '', note: '', collapsed: false, todo: false, done: false,
        created: 0, updated: 0,
      });
    }
  }

  /** Is the bullet in the outline proper (not in the trash)? */
  inOutline(id: NodeId): boolean {
    for (let p: NodeId | null = id; p !== null; p = this.get(p).parent) if (p === this.root) return true;
    return false;
  }

  /** Visits `id` and all its descendants. */
  walk(id: NodeId, fn: (n: OutlineNode) => void): void {
    const stack = [id];
    while (stack.length) {
      const n = this.get(stack.pop()!);
      fn(n);
      for (const c of n.children) stack.push(c);
    }
  }

  /** A document with a single empty bullet — the state a new outline starts in. */
  static withEmptyBullet(): Doc {
    const doc = new Doc();
    const now = Date.now();
    doc.apply({
      t: 'insert',
      parent: doc.root,
      node: {
        id: newId(), order: generateKeyBetween(null, null), text: '', note: '', collapsed: false, todo: false, done: false,
        created: now, updated: now, children: [],
      },
    });
    return doc;
  }

  get(id: NodeId): OutlineNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Unknown node ${id}`);
    return n;
  }

  has(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  subscribe(listener: DocListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Index of `id` among its siblings. */
  index(id: NodeId): number {
    const n = this.get(id);
    return this.get(n.parent!).children.indexOf(id);
  }

  /** A fresh order key for inserting at `index` among the current children of `parent`. */
  orderAt(parent: NodeId, index: number): string {
    return this.ordersAt(parent, index, 1)[0];
  }

  /**
   * `count` fresh order keys for inserting at `index`. Siblings may share a
   * key after two devices inserted into the same gap at once (ties break by
   * id); there is nothing strictly between equal keys, so the new keys then
   * go after the whole run of equals.
   */
  ordersAt(parent: NodeId, index: number, count: number): string[] {
    const kids = this.get(parent).children;
    const a = index > 0 ? this.get(kids[index - 1]).order : null;
    let k = index;
    while (a !== null && k < kids.length && this.get(kids[k]).order <= a) k++;
    const b = k < kids.length ? this.get(kids[k]).order : null;
    return generateNKeysBetween(a, b, count);
  }

  snapshot(id: NodeId): NodeSnapshot {
    const n = this.get(id);
    return {
      id: n.id, order: n.order, text: n.text, note: n.note, collapsed: n.collapsed, todo: n.todo, done: n.done,
      created: n.created, updated: n.updated,
      children: n.children.map((c) => this.snapshot(c)),
    };
  }

  /**
   * Runs `fn`, which applies ops, as one unit: listeners get a single commit.
   * If `fn` throws, already applied ops are rolled back and the error rethrown.
   */
  transact(fn: () => void): Op[] {
    if (this.pending) throw new Error('Nested transactions are not supported');
    const ops: Op[] = [];
    this.pending = ops;
    try {
      fn();
    } catch (e) {
      this.pending = null;
      for (let i = ops.length - 1; i >= 0; i--) this.applyOne(invert(ops[i]));
      for (const l of this.listeners) l.rollback?.(this);
      throw e;
    }
    this.pending = null;
    if (ops.length) for (const l of this.listeners) l.commit?.(ops, this);
    return ops;
  }

  apply(op: Op): void {
    this.applyOne(op);
    if (this.pending) this.pending.push(op);
    else for (const l of this.listeners) l.commit?.([op], this);
  }

  private applyOne(op: Op): void {
    switch (op.t) {
      case 'insert':
        this.insertSubtree(op.parent, op.node);
        break;
      case 'remove': {
        const n = this.get(op.node.id);
        if (n.parent !== op.parent) throw new Error(`remove: ${n.id} is not a child of ${op.parent}`);
        this.removeSubtree(n);
        break;
      }
      case 'setText': {
        const n = this.get(op.id);
        if (n.text !== op.from) throw new Error(`setText: stale text for ${op.id}`);
        n.text = op.to;
        if (op.at !== undefined) n.updated = op.at;
        break;
      }
      case 'move': {
        const n = this.get(op.id);
        if (n.parent !== op.from.parent || n.order !== op.from.order) throw new Error(`move: stale position for ${op.id}`);
        for (let p: NodeId | null = op.to.parent; p !== null; p = this.get(p).parent) {
          if (p === op.id) throw new Error(`move: ${op.id} into its own subtree`);
        }
        this.detach(n);
        n.parent = op.to.parent;
        n.order = op.to.order;
        this.attach(n);
        break;
      }
      case 'setCollapsed': {
        const n = this.get(op.id);
        if (n.collapsed !== op.from) throw new Error(`setCollapsed: stale state for ${op.id}`);
        n.collapsed = op.to;
        break;
      }
      case 'setTodo': {
        const n = this.get(op.id);
        if (n.todo !== op.from) throw new Error(`setTodo: stale state for ${op.id}`);
        n.todo = op.to;
        break;
      }
      case 'setDone': {
        const n = this.get(op.id);
        if (n.done !== op.from) throw new Error(`setDone: stale state for ${op.id}`);
        n.done = op.to;
        break;
      }
      case 'setNote': {
        const n = this.get(op.id);
        if (n.note !== op.from) throw new Error(`setNote: stale note for ${op.id}`);
        n.note = op.to;
        if (op.at !== undefined) n.updated = op.at;
        break;
      }
    }
    for (const l of this.listeners) l.op?.(op, this);
  }

  private insertSubtree(parent: NodeId, snap: NodeSnapshot): void {
    this.get(parent);
    const stack: [NodeId, NodeSnapshot][] = [[parent, snap]];
    while (stack.length) {
      const [p, s] = stack.pop()!;
      if (this.nodes.has(s.id)) throw new Error(`insert: duplicate id ${s.id}`);
      const n: OutlineNode = {
        id: s.id, parent: p, children: [], order: s.order, text: s.text,
        note: s.note, collapsed: s.collapsed, todo: s.todo, done: s.done, created: s.created, updated: s.updated,
      };
      this.nodes.set(n.id, n);
      this.attach(n);
      // Reversed so children pop in order and each attach appends instead of splicing at 0.
      for (let k = s.children.length - 1; k >= 0; k--) stack.push([n.id, s.children[k]]);
    }
  }

  private removeSubtree(n: OutlineNode): void {
    this.detach(n);
    const stack = [n.id];
    while (stack.length) {
      const id = stack.pop()!;
      for (const c of this.get(id).children) stack.push(c);
      this.nodes.delete(id);
    }
  }

  /** Inserts `n` into its parent's children, keeping them sorted by order, then by id for equal orders. */
  private attach(n: OutlineNode): void {
    const kids = this.get(n.parent!).children;
    let lo = 0;
    let hi = kids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.get(kids[mid]);
      if (m.order < n.order || (m.order === n.order && m.id < n.id)) lo = mid + 1;
      else hi = mid;
    }
    kids.splice(lo, 0, n.id);
  }

  private detach(n: OutlineNode): void {
    const kids = this.get(n.parent!).children;
    kids.splice(kids.indexOf(n.id), 1);
  }
}
