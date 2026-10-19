import { TRASH_TTL, purgeTrash } from '../model/trash';
import { plainCodec, type Codec } from './codec';
import { done, readAll } from './db';
import { deserialize, serialize } from './serialize';

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
    for (const op of batch) doc.apply(op);
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
