import { Doc } from '../model/doc';
import type { NodeId, Op } from '../model/types';

/** One node; `parent` is the index of the parent's row, -1 for the root. */
export type SnapshotRow = [id: NodeId, parent: number, order: string, text: string, collapsed: 0 | 1, created: number, updated: number];

/** Rows in pre-order, so children arrive already sorted. */
export interface Snapshot {
  v: 1;
  root: NodeId;
  rows: SnapshotRow[];
}

export function serialize(doc: Doc): string {
  const rows: SnapshotRow[] = [];
  const stackIds: NodeId[] = [];
  const stackParents: number[] = [];
  const pushChildren = (children: NodeId[], parent: number) => {
    for (let k = children.length - 1; k >= 0; k--) {
      stackIds.push(children[k]);
      stackParents.push(parent);
    }
  };
  pushChildren(doc.get(doc.root).children, -1);
  while (stackIds.length) {
    const n = doc.get(stackIds.pop()!);
    const parent = stackParents.pop()!;
    const index = rows.length;
    rows.push([n.id, parent, n.order, n.text, n.collapsed ? 1 : 0, n.created, n.updated]);
    pushChildren(n.children, index);
  }
  const snapshot: Snapshot = { v: 1, root: doc.root, rows };
  return JSON.stringify(snapshot);
}

/** Bulk load: fills the node map directly, bypassing ops (nothing is subscribed yet). */
export function deserialize(json: string): Doc {
  const s = JSON.parse(json) as Snapshot;
  if (s.v !== 1) throw new Error(`Unsupported snapshot version ${s.v}`);
  const doc = new Doc(s.root);
  const ids = new Array<NodeId>(s.rows.length);
  s.rows.forEach(([id, p, order, text, collapsed, created, updated], i) => {
    const parent = p < 0 ? s.root : ids[p];
    ids[i] = id;
    doc.nodes.set(id, { id, parent, children: [], order, text, collapsed: collapsed === 1, created, updated });
    doc.get(parent).children.push(id);
  });
  return doc;
}

/** Merges adjacent edits of the same bullet: a typing burst becomes one op. */
export function coalesce(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    if (prev?.t === 'setText' && op.t === 'setText' && prev.id === op.id) {
      out[out.length - 1] = { ...prev, to: op.to, at: op.at };
    } else {
      out.push(op);
    }
  }
  return out;
}
