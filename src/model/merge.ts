import { TRASH, trashKey, type Doc } from './doc';
import { merge3 } from './merge-text';
import type { NodeId, NodeSnapshot, Op, Position } from './types';

/**
 * Applies an op that was not authored against this exact document: one from
 * another device, or an undo whose bullet has since changed. `Doc.apply`
 * rejects such ops (their `from` is stale); this turns each into the ops that
 * carry out its intent on the document as it is now, so the document is
 * always consistent and every change still goes through `Doc.apply`.
 *
 * Every device applies the shared log in the same order through this same
 * function, so they all end in the same state. The rules:
 * - fields are independent: moving a bullet and editing its text never clash;
 * - text and notes merge three ways; when the same words were changed on both
 *   sides, the later edit (by its clock stamp) wins and the other version is
 *   kept in the note, never dropped;
 * - a bullet that is gone here is in the trash or purged: edits to it still
 *   apply in the trash, and anything inserted under it goes to the trash;
 * - a move that would make a cycle is skipped; a move of a bullet that is
 *   already elsewhere wins (its device moved it on purpose);
 * - the folded state is per device and never follows another device's op.
 */
export function applyMerged(doc: Doc, op: Op): Op[] {
  if (op.t === 'insert') return mergeInsert(doc, op.parent, op.node);
  const ops = mergeOp(doc, op);
  for (const o of ops) doc.apply(o);
  return ops;
}

/** The ops that carry out `op` on the document as it is now (everything but inserts, which are applied as they go). */
function mergeOp(doc: Doc, op: Exclude<Op, { t: 'insert' }>): Op[] {
  switch (op.t) {
    case 'remove': {
      // Another device threw it away: into the trash here, where a late edit can still land.
      const n = doc.nodes.get(op.node.id);
      if (!n || n.parent === TRASH) return [];
      return [{ t: 'move', id: n.id, from: { parent: n.parent!, order: n.order }, to: { parent: TRASH, order: trashKey(op.node.updated) } }];
    }
    case 'move': {
      const n = doc.nodes.get(op.id);
      if (!n || n.parent === null) return [];
      const to = reachable(doc, op.to, op.id);
      if (!to) return [];
      if (n.parent === to.parent && n.order === to.order) return [];
      return [{ t: 'move', id: n.id, from: { parent: n.parent, order: n.order }, to }];
    }
    case 'setText':
      return mergeText(doc, op, 'text');
    case 'setNote':
      return mergeText(doc, op, 'note');
    case 'setCollapsed': {
      const n = doc.nodes.get(op.id);
      return n && n.collapsed !== op.to ? [{ ...op, from: n.collapsed }] : [];
    }
    case 'setTodo': {
      const n = doc.nodes.get(op.id);
      return n && n.todo !== op.to ? [{ ...op, from: n.todo }] : [];
    }
    case 'setDone': {
      const n = doc.nodes.get(op.id);
      return n && n.done !== op.to ? [{ ...op, from: n.done }] : [];
    }
  }
}

/** The position, with a missing parent replaced by the trash; null if it would put `id` inside itself. */
function reachable(doc: Doc, to: Position, id: NodeId): Position | null {
  if (!doc.has(to.parent)) return { parent: TRASH, order: to.order };
  for (let p: NodeId | null = to.parent; p !== null; p = doc.get(p).parent) if (p === id) return null;
  return to;
}

/**
 * A subtree from elsewhere, node by node and applied as it goes (children
 * need their parent in place): new bullets are inserted, under the trash if
 * their parent is gone; bullets that exist already are moved to where the
 * subtree puts them, their content left alone.
 */
function mergeInsert(doc: Doc, parent: NodeId, node: NodeSnapshot): Op[] {
  const out: Op[] = [];
  const stack: [NodeId, NodeSnapshot][] = [[parent, node]];
  while (stack.length) {
    const [p, s] = stack.pop()!;
    const existing = doc.nodes.get(s.id);
    if (!existing) {
      const target = doc.has(p) ? p : TRASH;
      out.push({ t: 'insert', parent: target, node: { ...s, children: [] } });
      doc.apply(out[out.length - 1]);
    } else {
      const to = reachable(doc, { parent: p, order: s.order }, s.id);
      if (to && existing.parent !== null && (existing.parent !== to.parent || existing.order !== to.order)) {
        out.push({ t: 'move', id: s.id, from: { parent: existing.parent, order: existing.order }, to });
        doc.apply(out[out.length - 1]);
      }
    }
    for (let k = s.children.length - 1; k >= 0; k--) stack.push([s.id, s.children[k]]);
  }
  return out;
}

type TextOp = Extract<Op, { t: 'setText' | 'setNote' }>;

/** Marks the version that lost a collision; it goes into the note. */
export const CONFLICT = '⚠ Другая версия';

function mergeText(doc: Doc, op: TextOp, field: 'text' | 'note'): Op[] {
  const n = doc.nodes.get(op.id);
  if (!n || n.parent === null) return [];
  const current = n[field];
  if (current === op.to) return [];
  const merged = merge3(op.from, op.to, current);
  const at = op.at;
  if (merged !== null) return [{ ...op, from: current, to: merged, at }];
  // The same words changed on both sides: the later edit wins, the other is kept in the note.
  const theirsWin = (at ?? 0) > n.updated;
  const winner = theirsWin ? op.to : current;
  const loser = theirsWin ? current : op.to;
  const out: Op[] = [];
  if (winner !== current) out.push({ ...op, from: current, to: winner, at });
  const marker = `${CONFLICT}: ${loser}`;
  const note = field === 'note' ? winner : n.note;
  const noteFrom = field === 'note' ? winner : n.note;
  if (!note.includes(marker)) {
    out.push({ t: 'setNote', id: n.id, from: noteFrom, to: note ? `${note}\n${marker}` : marker, at });
  }
  return out;
}
