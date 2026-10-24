import type { Doc } from '../model/doc';
import { applyMerged } from '../model/merge';
import { TRASH_TTL, purgeTrash } from '../model/trash';
import type { Op } from '../model/types';
import { plainCodec, type Codec } from './codec';
import { done, readAll } from './db';
import { deserialize, serialize } from './serialize';

/**
 * Applies a stored batch of the log. An op that is not from this state (a
 * batch before it never reached the disk: Persistence lost failed writes
 * that way before it kept them) still applies, the same way on every load
 * and in compaction, so the document opens: a field set from another value
 * is set from the one it has (the op is this device's own later edit, and
 * holds the whole text), anything else merges as from another device
 * (model/merge.ts); what cannot apply at all is left out. Returns how many
 * ops did not apply as stored.
 */
export function replay(doc: Doc, batch: Op[]): number {
  let merged = 0;
  for (const op of batch) {
    try {
      doc.apply(op);
      continue;
    } catch {
      merged++;
    }
    try {
      const fixed = fromNow(doc, op);
      if (fixed) doc.apply(fixed);
      else applyMerged(doc, op);
    } catch (e) {
      console.warn('replay: op left out', op, e);
    }
  }
  return merged;
}

/** `op` from the bullet's current value, for ops that set one field (null for the rest, or a bullet not here). */
function fromNow(doc: Doc, op: Op): Op | null {
  if (op.t === 'insert' || op.t === 'remove' || op.t === 'addStrokes' || op.t === 'removeStrokes') return null;
  const n = doc.nodes.get(op.id);
  if (!n) return null;
  switch (op.t) {
    case 'setText': return { ...op, from: n.text };
    case 'setNote': return { ...op, from: n.note };
    case 'setCollapsed': return { ...op, from: n.collapsed };
    case 'setTodo': return { ...op, from: n.todo };
    case 'setDone': return { ...op, from: n.done };
    case 'setMirror': return { ...op, from: n.mirrorOf ?? null };
    case 'move': return doc.nodes.has(op.to.parent) && n.parent !== null ? { ...op, from: { parent: n.parent, order: n.order } } : null;
  }
}

/**
 * Folds the op log into the snapshot: reads both, applies the log, writes
 * the new snapshot and deletes the folded batches, all by key. Batches
 * appended meanwhile have larger keys, so they stay and apply on top of the
 * new snapshot. Works on the database alone, so it can run in a worker.
 * Returns the number of ops folded.
 */
export async function compactLog(db: IDBDatabase, codec: Codec = plainCodec, force = false): Promise<number> {
  const { snapshot, batches, lastKey } = await readAll(db);
  if (!snapshot || (lastKey === undefined && !force)) return 0;
  const doc = deserialize(await codec.decodeSnapshot(snapshot));
  let folded = 0;
  for (const record of batches) {
    const batch = await codec.decodeBatch(record);
    replay(doc, batch);
    folded += batch.length;
  }
  purgeTrash(doc, Date.now() - TRASH_TTL);
  const record = await codec.encodeSnapshot(serialize(doc));
  const tx = db.transaction(['meta', 'oplog'], 'readwrite');
  tx.objectStore('meta').put(record, 'snapshot');
  if (lastKey === undefined) {
    await done(tx);
    return 0;
  }
  tx.objectStore('oplog').delete(IDBKeyRange.upperBound(lastKey));
  await done(tx);
  return folded;
}
