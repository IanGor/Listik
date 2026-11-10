import { walkSnapshot, type Doc, type DocListener } from './doc';
import { compareOrder } from './links';
import type { NodeId, Op } from './types';

/** Sparse index: typing never scans the full document to rediscover stars. */
export class Favorites implements DocListener {
  private readonly candidates = new Set<NodeId>();
  private dirty = false;
  version = 0;
  private cachedVersion = -1;
  private cached: NodeId[] = [];
  private readonly doc: Doc;

  constructor(doc: Doc) {
    this.doc = doc;
    for (const n of doc.nodes.values()) if (n.favorite) this.candidates.add(n.id);
    doc.subscribe(this);
  }

  list(): NodeId[] {
    if (this.cachedVersion !== this.version) {
      this.cached = [...this.candidates].filter((id) => {
        const n = this.doc.nodes.get(id);
        return n?.favorite && !n.mirrorOf && id !== this.doc.root && this.doc.inOutline(id);
      }).sort((a, b) => compareOrder(this.doc, a, b));
      this.cachedVersion = this.version;
    }
    return this.cached;
  }

  op(op: Op): void {
    if (op.t === 'setFavorite') {
      if (op.to) this.candidates.add(op.id); else this.candidates.delete(op.id);
      this.dirty = true;
    } else if (op.t === 'insert' || op.t === 'remove') {
      walkSnapshot(op.node, (n) => {
        if (op.t === 'remove') this.candidates.delete(n.id);
        else if (n.favorite) this.candidates.add(n.id);
      });
      this.dirty = true;
    } else if (op.t === 'move' || op.t === 'setMirror') this.dirty = true;
  }

  commit(): void {
    if (this.dirty) this.version++;
    this.dirty = false;
  }

  rollback(): void {
    this.candidates.clear();
    for (const n of this.doc.nodes.values()) if (n.favorite) this.candidates.add(n.id);
    this.version++;
    this.dirty = false;
  }
}

export function toggleFavorite(doc: Doc, id: NodeId): void {
  const origin = doc.origin(id);
  if (origin === doc.root || !doc.inOutline(origin)) return;
  const n = doc.get(origin);
  doc.apply({ t: 'setFavorite', id: origin, from: !!n.favorite, to: !n.favorite });
}
