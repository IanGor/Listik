import type { Op } from '../model/types';

/**
 * IndexedDB layout, shared by the page and the compaction worker:
 * `meta` / 'snapshot' holds the JSON snapshot (serialize.ts), `oplog` holds
 * one `Op[]` per flushed batch under auto-increment keys, in order.
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
  snapshot: string | undefined;
  batches: Op[][];
  /** Key of the last batch, if any. */
  lastKey: IDBValidKey | undefined;
}

/** Snapshot and log, read in one transaction so they are consistent. */
export async function readAll(db: IDBDatabase): Promise<Stored> {
  const tx = db.transaction(['meta', 'oplog'], 'readonly');
  const log = tx.objectStore('oplog');
  const [snapshot, batches, keys] = await Promise.all([
    request(tx.objectStore('meta').get('snapshot') as IDBRequest<string | undefined>),
    request(log.getAll() as IDBRequest<Op[][]>),
    request(log.getAllKeys()),
  ]);
  return { snapshot, batches, lastKey: keys[keys.length - 1] };
}

export async function writeSnapshot(db: IDBDatabase, json: string): Promise<void> {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(json, 'snapshot');
  await done(tx);
}
