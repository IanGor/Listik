import { Doc, TRASH } from '../model/doc';
import type { NodeId, Op } from '../model/types';
import { own } from '../util/own';

/**
 * One node; `parent` is the index of the parent's row, -1 for the root and
 * -2 for the trash (v4). Version 1 rows end at `updated`; version 2 adds
 * `done` and `note`; version 3 adds `todo` (in v2, anything done was in
 * effect a task); version 4 adds the trash's rows after the outline's.
 */
export type SnapshotRow = [
  id: NodeId, parent: number, order: string, text: string, collapsed: 0 | 1, created: number, updated: number,
  done?: 0 | 1, note?: string, todo?: 0 | 1,
];

/** Rows in pre-order, so children arrive already sorted. */
export interface Snapshot {
  v: 1 | 2 | 3 | 4;
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
  // The trash's rows come after the whole outline: pushed first, popped last.
  pushChildren(doc.get(TRASH).children, -2);
  pushChildren(doc.get(doc.root).children, -1);
  while (stackIds.length) {
    const n = doc.get(stackIds.pop()!);
    const parent = stackParents.pop()!;
    const index = rows.length;
    rows.push([n.id, parent, n.order, n.text, n.collapsed ? 1 : 0, n.created, n.updated, n.done ? 1 : 0, n.note, n.todo ? 1 : 0]);
    pushChildren(n.children, index);
  }
  const snapshot: Snapshot = { v: 4, root: doc.root, rows };
  return JSON.stringify(snapshot);
}


/**
 * Bulk load: fills the node map directly, bypassing ops (nothing is subscribed
 * yet). Strings are copied out of the snapshot (`own`): on 200k bullets the
 * doc takes 63 MB instead of 113 MB, for ~70 ms more loading.
 */
export function deserialize(json: string): Doc {
  const s = JSON.parse(json) as Snapshot;
  if (s.v !== 1 && s.v !== 2 && s.v !== 3 && s.v !== 4) throw new Error(`Unsupported snapshot version ${s.v}`);
  const doc = new Doc(s.root);
  const ids = new Array<NodeId>(s.rows.length);
  s.rows.forEach(([rawId, p, order, text, collapsed, created, updated, done, note, todo], i) => {
    const parent = p === -1 ? s.root : p === -2 ? TRASH : ids[p];
    const id = own(rawId);
    ids[i] = id;
    doc.nodes.set(id, {
      id, parent, children: [], order: own(order), text: own(text), note: note ? own(note) : '',
      collapsed: collapsed === 1, todo: todo === 1 || done === 1, done: done === 1, created, updated,
    });
    doc.get(parent).children.push(id);
  });
  return doc;
}

/** Merges adjacent edits of the same bullet's text (or note): a typing burst becomes one op. */
export function coalesce(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    if (prev && (op.t === 'setText' || op.t === 'setNote') && prev.t === op.t && prev.id === op.id) {
      out[out.length - 1] = { ...prev, to: op.to, at: op.at };
    } else {
      out.push(op);
    }
  }
  return out;
}
