import { TRASH_TTL, purgeTrash } from '../model/trash';
import { done, readAll } from './db';
import { deserialize, serialize } from './serialize';

/**
 * Folds the op log into the snapshot: reads both, applies the log, writes
 * the new snapshot and deletes the folded batches, all by key. Batches
 * appended meanwhile have larger keys, so they stay and apply on top of the
 * new snapshot. Works on the database alone, so it can run in a worker.
 * Returns the number of ops folded.
 */
export async function compactLog(db: IDBDatabase): Promise<number> {
  const { snapshot, batches, lastKey } = await readAll(db);
  if (!snapshot || lastKey === undefined) return 0;
  const doc = deserialize(snapshot);
  let folded = 0;
  for (const batch of batches) {
    for (const op of batch) doc.apply(op);
    folded += batch.length;
  }
  purgeTrash(doc, Date.now() - TRASH_TTL);
  const json = serialize(doc);
  const tx = db.transaction(['meta', 'oplog'], 'readwrite');
  tx.objectStore('meta').put(json, 'snapshot');
  tx.objectStore('oplog').delete(IDBKeyRange.upperBound(lastKey));
  await done(tx);
  return folded;
}
