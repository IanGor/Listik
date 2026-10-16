import { Doc, type DocListener } from '../model/doc';
import type { Op } from '../model/types';
import { coalesce, deserialize, serialize } from './serialize';

/** Batching window for writes, ms. */
const FLUSH_DELAY = 300;
/** Ops in the log before it is folded into a new snapshot. */
const COMPACT_AFTER = 10_000;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(name: string): Promise<IDBDatabase> {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('meta');
    r.result.createObjectStore('oplog', { autoIncrement: true });
  };
  return request(r);
}

const idle = (fn: () => void) =>
  typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 10_000 }) : setTimeout(fn, 0);

/**
 * Stores the doc in IndexedDB as a snapshot plus a log of op batches.
 * Every commit appends only its ops (batched for FLUSH_DELAY), so the cost
 * of saving an edit does not depend on the size of the document. Once the
 * log grows past COMPACT_AFTER ops, it is folded into a fresh snapshot when
 * the browser is idle.
 */
export class Persistence implements DocListener {
  /** The last write error; writes keep being attempted. */
  error: unknown = null;
  private pending: Op[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Writes run strictly one after another. */
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by each compaction; batches taken before it are already in the snapshot. */
  private generation = 0;
  private logSize: number;
  private compactScheduled = false;
  private db: IDBDatabase;
  private doc: Doc;

  private constructor(db: IDBDatabase, doc: Doc, logSize: number) {
    this.db = db;
    this.doc = doc;
    this.logSize = logSize;
    doc.subscribe(this);
  }

  /** Loads the doc (snapshot + log replay), or starts a new one with a single empty bullet. */
  static async open(name = 'listik'): Promise<{ doc: Doc; persistence: Persistence }> {
    const db = await openDb(name);
    const tx = db.transaction(['meta', 'oplog'], 'readonly');
    const [snapshot, batches] = await Promise.all([
      request(tx.objectStore('meta').get('snapshot') as IDBRequest<string | undefined>),
      request(tx.objectStore('oplog').getAll() as IDBRequest<Op[][]>),
    ]);
    let doc: Doc;
    let logSize = 0;
    if (snapshot) {
      doc = deserialize(snapshot);
      for (const batch of batches) {
        for (const op of batch) doc.apply(op);
        logSize += batch.length;
      }
    } else {
      doc = Doc.withEmptyBullet();
    }
    const persistence = new Persistence(db, doc, logSize);
    if (!snapshot) await persistence.compact();
    else if (logSize > COMPACT_AFTER) persistence.scheduleCompact();
    if (typeof window !== 'undefined') {
      const flush = () => void persistence.flush();
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
      void navigator.storage?.persist?.();
    }
    return { doc, persistence };
  }

  commit(ops: Op[]): void {
    for (const op of ops) this.pending.push(op);
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_DELAY);
  }

  /** Writes pending ops now. Resolves when everything queued so far is on disk. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return this.chain;
    const batch = coalesce(this.pending);
    this.pending = [];
    this.logSize += batch.length;
    const generation = this.generation;
    const written = this.enqueue(async () => {
      if (generation !== this.generation) return;
      const tx = this.db.transaction('oplog', 'readwrite');
      tx.objectStore('oplog').add(batch);
      await done(tx);
    });
    if (this.logSize > COMPACT_AFTER) this.scheduleCompact();
    return written;
  }

  /** Replaces snapshot + log with a snapshot of the current doc. */
  compact(): Promise<void> {
    return this.enqueue(async () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      // The snapshot covers every op applied so far, including unwritten ones.
      const json = serialize(this.doc);
      this.pending = [];
      this.logSize = 0;
      this.generation++;
      const tx = this.db.transaction(['meta', 'oplog'], 'readwrite');
      tx.objectStore('meta').put(json, 'snapshot');
      tx.objectStore('oplog').clear();
      await done(tx);
    });
  }

  close(): void {
    this.db.close();
  }

  private scheduleCompact(): void {
    if (this.compactScheduled) return;
    this.compactScheduled = true;
    idle(() => {
      this.compactScheduled = false;
      void this.compact();
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task).catch((e: unknown) => {
      this.error = e;
      console.error('Saving failed', e);
    });
    this.chain = run;
    return run;
  }
}
