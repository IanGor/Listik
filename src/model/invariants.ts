import { TRASH, type Doc } from './doc';
import type { NodeId } from './types';

/** Throws if the tree (outline and trash) is inconsistent. Used by tests and dev assertions. */
export function checkInvariants(doc: Doc): void {
  for (const r of [doc.root, TRASH]) if (doc.get(r).parent !== null) throw new Error(`${r} has a parent`);
  const seen = new Set<NodeId>([doc.root, TRASH]);
  const stack = [doc.root, TRASH];
  while (stack.length) {
    const n = doc.get(stack.pop()!);
    let prev: { order: string; id: NodeId } | null = null;
    for (const cid of n.children) {
      if (seen.has(cid)) throw new Error(`${cid} reachable twice`);
      seen.add(cid);
      const c = doc.nodes.get(cid);
      if (!c) throw new Error(`${n.id} has missing child ${cid}`);
      if (c.parent !== n.id) throw new Error(`${cid}.parent is ${c.parent}, expected ${n.id}`);
      // Sorted by order; equal orders (concurrent inserts) by id.
      if (prev && !(prev.order < c.order || (prev.order === c.order && prev.id < c.id))) {
        throw new Error(`children of ${n.id} out of order`);
      }
      prev = { order: c.order, id: c.id };
      stack.push(cid);
    }
  }
  if (seen.size !== doc.nodes.size) throw new Error(`${doc.nodes.size - seen.size} unreachable nodes`);
  // The mirror index (`Doc.hasMirrors`, `copies`) agrees with the bullets' `mirrorOf`.
  const targets = new Set<NodeId>();
  for (const n of doc.nodes.values()) if (n.mirrorOf) targets.add(n.mirrorOf);
  for (const n of doc.nodes.values()) {
    if (doc.hasMirrors(n.id) !== targets.has(n.id)) throw new Error(`mirror index of ${n.id} is stale`);
  }
}
