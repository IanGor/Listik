import type { Doc } from './doc';
import type { NodeId } from './types';

/** Throws if the tree is inconsistent. Used by tests and dev assertions. */
export function checkInvariants(doc: Doc): void {
  const root = doc.get(doc.root);
  if (root.parent !== null) throw new Error('root has a parent');
  const seen = new Set<NodeId>([doc.root]);
  const stack = [doc.root];
  while (stack.length) {
    const n = doc.get(stack.pop()!);
    let prevOrder: string | null = null;
    for (const cid of n.children) {
      if (seen.has(cid)) throw new Error(`${cid} reachable twice`);
      seen.add(cid);
      const c = doc.nodes.get(cid);
      if (!c) throw new Error(`${n.id} has missing child ${cid}`);
      if (c.parent !== n.id) throw new Error(`${cid}.parent is ${c.parent}, expected ${n.id}`);
      if (prevOrder !== null && !(prevOrder < c.order)) throw new Error(`children of ${n.id} out of order`);
      prevOrder = c.order;
      stack.push(cid);
    }
  }
  if (seen.size !== doc.nodes.size) throw new Error(`${doc.nodes.size - seen.size} unreachable nodes`);
}
