import { generateKeyBetween } from 'fractional-indexing';
import { nanoid } from 'nanoid';
import type { NodeId, NodeSnapshot, Op, OutlineNode } from './types';

export const newId = (): NodeId => nanoid();

export interface DocListener {
  /** Called after each op is applied. */
  op?(op: Op, doc: Doc): void;
  /** Called once per transaction (or per standalone op) after all its ops. */
  commit?(ops: Op[], doc: Doc): void;
}

export function invert(op: Op): Op {
  switch (op.t) {
    case 'insert':
      return { t: 'remove', parent: op.parent, node: op.node };
    case 'remove':
      return { t: 'insert', parent: op.parent, node: op.node };
    case 'setText':
      return { t: 'setText', id: op.id, from: op.to, to: op.from, at: op.at };
    case 'move':
      return { t: 'move', id: op.id, from: op.to, to: op.from };
    case 'setCollapsed':
      return { t: 'setCollapsed', id: op.id, from: op.to, to: op.from };
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
    this.nodes.set(root, {
      id: root, parent: null, children: [], order: '', text: '', collapsed: false, created: 0, updated: 0,
    });
  }

  /** A document with a single empty bullet — the state a new outline starts in. */
  static withEmptyBullet(): Doc {
    const doc = new Doc();
    const now = Date.now();
    doc.apply({
      t: 'insert',
      parent: doc.root,
      node: { id: newId(), order: generateKeyBetween(null, null), text: '', collapsed: false, created: now, updated: now, children: [] },
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
    const kids = this.get(parent).children;
    const a = index > 0 ? this.get(kids[index - 1]).order : null;
    const b = index < kids.length ? this.get(kids[index]).order : null;
    return generateKeyBetween(a, b);
  }

  snapshot(id: NodeId): NodeSnapshot {
    const n = this.get(id);
    return {
      id: n.id, order: n.order, text: n.text, collapsed: n.collapsed, created: n.created, updated: n.updated,
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
        collapsed: s.collapsed, created: s.created, updated: s.updated,
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

  /** Inserts `n` into its parent's children, keeping them sorted by order. */
  private attach(n: OutlineNode): void {
    const kids = this.get(n.parent!).children;
    let lo = 0;
    let hi = kids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.get(kids[mid]).order < n.order) lo = mid + 1;
      else hi = mid;
    }
    if (lo < kids.length && this.get(kids[lo]).order === n.order) throw new Error(`Duplicate order ${n.order}`);
    kids.splice(lo, 0, n.id);
  }

  private detach(n: OutlineNode): void {
    const kids = this.get(n.parent!).children;
    kids.splice(kids.indexOf(n.id), 1);
  }
}
