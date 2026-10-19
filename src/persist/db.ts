/**
 * IndexedDB layout, shared by the page and the compaction worker:
 * `meta` / 'snapshot' holds the snapshot (serialize.ts), `oplog` holds one
 * batch per flush under auto-increment keys, in order. Both are stored as
 * the codec (codec.ts) writes them: plain, or encrypted. `meta` also holds
 * the backup folder, the key slot and device key (sync/vault.ts) and the
 * sync state (sync/engine.ts).
 */

export function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function openDb(name: string): Promise<IDBDatabase> {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('meta');
    r.result.createObjectStore('oplog', { autoIncrement: true });
  };
  return request(r);
}

export interface Stored {
  snapshot: unknown;
  batches: unknown[];
  /** Key of the last batch, if any. */
  lastKey: IDBValidKey | undefined;
}

/** Snapshot and log, read in one transaction so they are consistent. */
export async function readAll(db: IDBDatabase): Promise<Stored> {
  const tx = db.transaction(['meta', 'oplog'], 'readonly');
  const log = tx.objectStore('oplog');
  const [snapshot, batches, keys] = await Promise.all([
    request(tx.objectStore('meta').get('snapshot') as IDBRequest<unknown>),
    request(log.getAll() as IDBRequest<unknown[]>),
    request(log.getAllKeys()),
  ]);
  return { snapshot, batches, lastKey: keys[keys.length - 1] };
}

export async function writeSnapshot(db: IDBDatabase, record: unknown): Promise<void> {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(record, 'snapshot');
  await done(tx);
}

export async function getMeta<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return request(db.transaction('meta').objectStore('meta').get(key) as IDBRequest<T | undefined>);
}

export async function putMeta(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = db.transaction('meta', 'readwrite');
  if (value === undefined) tx.objectStore('meta').delete(key);
  else tx.objectStore('meta').put(value, key);
  await done(tx);
}
