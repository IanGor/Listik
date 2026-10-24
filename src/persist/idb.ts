import { Doc, type DocListener } from '../model/doc';
import type { Op } from '../model/types';
import { plainCodec, recoding, type Codec } from './codec';
import { compactLog, replay } from './compact';
import { done, openDb, readAll, writeSnapshot } from './db';
import { coalesce, deserialize, serialize } from './serialize';

/**
 * Writes go out at the end of the task that made them, ms. A page closed or
 * reloaded loses what is not yet in a transaction, and `pagehide` is too late
 * to start one: a window of 300 ms here lost the last word typed.
 */
const FLUSH_DELAY = 0;
/** Ops in the log before it is folded into a new snapshot. */
const COMPACT_AFTER = 10_000;
/** A write that failed is tried again after this, ms, if nothing else writes first. */
const RETRY_DELAY = 2000;

/**
 * A `meta` record written along with a batch of the log; `undefined`
 * deletes it. A promise (a record being sealed) is waited for before the
 * transaction opens: what it holds was decided when the batch was cut.
 */
export interface MetaWrite {
  key: string;
  value: unknown;
}

/**
 * What a rider (sync/engine.ts) writes with each batch, decided when the
 * batch is cut: its records then match the log exactly, whenever the page
 * stops.
 */
export type Rider = () => MetaWrite[];

/** Folds the log into the snapshot; resolves to the number of ops folded. */
type Compactor = (codec: Codec, force: boolean) => Promise<number>;

/** Runs compaction in a worker, so the main thread never serializes the whole doc. */
function workerCompactor(name: string): Compactor {
  const worker = new Worker(new URL('./compact.worker.ts', import.meta.url), { type: 'module' });
  return (codec, force) => new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<{ folded?: number; error?: string }>) =>
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.folded ?? 0);
    worker.postMessage({ name, key: codec.key, old: codec.old, force });
  });
}

/** Snapshot plus replayed log; a new single-bullet doc if nothing is stored yet. `merged`: ops of the log not from their state (`replay`). */
async function load(db: IDBDatabase, codec: Codec): Promise<{ doc: Doc; logSize: number; stored: boolean; merged: number }> {
  const { snapshot, batches } = await readAll(db);
  if (!snapshot) return { doc: Doc.withEmptyBullet(), logSize: 0, stored: false, merged: 0 };
  const doc = deserialize(await codec.decodeSnapshot(snapshot));
  let logSize = 0;
  let merged = 0;
  for (const record of batches) {
    const batch = await codec.decodeBatch(record);
    merged += replay(doc, batch);
    logSize += batch.length;
  }
  return { doc, logSize, stored: true, merged };
}

const idle = (fn: () => void) =>
  typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 10_000 }) : setTimeout(fn, 0);

/**
 * Stores the doc in IndexedDB as a snapshot plus a log of op batches.
 * The page only ever appends: every commit adds its ops (those of one task
 * together, FLUSH_DELAY), so the cost of saving an edit does not depend on
 * the size of the document. Riders add `meta` records to the same
 * transaction (the sync state, so it never disagrees with the log). Once the log grows past COMPACT_AFTER ops, a worker folds
 * it into a new snapshot (compact.ts), off the main thread. Records go
 * through the codec: plain, or encrypted with the document's key. A batch
 * that fails to be written (WebKit drops IndexedDB transactions, and even
 * the connection, after the page was in the background) is kept and goes
 * first in the next write, after reconnecting: dropped, it left a gap in the
 * log, and the next load stopped at the first op after it.
 */
export class Persistence implements DocListener {
  /** The last write error; writes keep being attempted. */
  error: unknown = null;
  /** Called when `error` changes. */
  onError: ((e: unknown) => void) | null = null;
  private pending: Op[] = [];
  /** A batch cut but not on disk yet, its riders' records with it: the next write takes it first. */
  private unsaved: { ops: Op[]; meta: { key: string; value: unknown }[] } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private riders = new Set<Rider>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Appends run strictly one after another. */
  private chain: Promise<void> = Promise.resolve();
  private compacting: Promise<void> | null = null;
  private compactScheduled = false;
  private logSize: number;
  private db: IDBDatabase;
  private name: string;
  private compactor: Compactor;
  private codec: Codec;

  private constructor(name: string, db: IDBDatabase, doc: Doc, logSize: number, compactor: Compactor, codec: Codec) {
    this.name = name;
    this.db = db;
    this.logSize = logSize;
    this.compactor = compactor;
    this.codec = codec;
    doc.subscribe(this);
  }

  /**
   * Loads the doc (snapshot + log replay), or starts a new one with a single
   * empty bullet (`fresh`). `merged`: ops of the log that had to be merged
   * (a gap in it, `replay`); the log is then folded into the snapshot at once.
   */
  static async open(name = 'listik', codec: Codec = plainCodec): Promise<{ doc: Doc; persistence: Persistence; fresh: boolean; merged: number }> {
    const db = await openDb(name);
    const { doc, logSize, stored, merged } = await load(db, codec);
    if (!stored) await writeSnapshot(db, await codec.encodeSnapshot(serialize(doc)));
    const compactor: Compactor = typeof Worker === 'function' ? workerCompactor(name) : (c, force) => compactLog(persistence.db, c, force);
    const persistence = new Persistence(name, db, doc, logSize, compactor, codec);
    if (merged) void persistence.compact();
    else if (logSize > COMPACT_AFTER) persistence.scheduleCompact();
    if (typeof window !== 'undefined') {
      const flush = () => void persistence.flush();
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
      void navigator.storage?.persist?.();
    }
    return { doc, persistence, fresh: !stored, merged };
  }

  /** The doc as stored, without saving anything back: for a read-only tab. */
  static async read(name = 'listik', codec: Codec = plainCodec): Promise<Doc> {
    const db = await openDb(name);
    try {
      return (await load(db, codec)).doc;
    } finally {
      db.close();
    }
  }

  /** Is the document stored encrypted? */
  get encrypted(): boolean {
    return this.codec.encrypted;
  }

  commit(ops: Op[]): void {
    for (const op of ops) this.pending.push(op);
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_DELAY);
  }

  /** Writes `rider`'s records with every batch from now on; returns the way to stop. */
  ride(rider: Rider): () => void {
    this.riders.add(rider);
    return () => this.riders.delete(rider);
  }

  /** Writes pending ops, and what riders have, now (a batch that failed before, first). Resolves when everything queued so far is on disk. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const meta = [...this.riders].flatMap((r) => r());
    if (!this.pending.length && !meta.length && !this.unsaved) return this.chain;
    const batch = coalesce(this.pending);
    this.pending = [];
    this.logSize += batch.length;
    const codec = this.codec;
    const written = this.enqueue(async () => {
      const records = await Promise.all(meta.map(async ({ key, value }) => ({ key, value: await value })));
      // What failed before goes in the same record, ahead: the log never skips a batch.
      const held = this.unsaved;
      const ops = held ? coalesce([...held.ops, ...batch]) : batch;
      const all = held ? [...held.meta, ...records] : records;
      this.unsaved = { ops, meta: all };
      if (!ops.length && !all.length) return;
      // WebKit may have closed the connection along with the failed transaction.
      if (held) await this.reconnect();
      const record = ops.length ? await codec.encodeBatch(ops) : null;
      const tx = this.db.transaction(['oplog', 'meta'], 'readwrite');
      if (record !== null) tx.objectStore('oplog').add(record);
      for (const { key, value } of all) {
        if (value === undefined) tx.objectStore('meta').delete(key);
        else tx.objectStore('meta').put(value, key);
      }
      await done(tx);
      this.unsaved = null;
      if (this.error !== null) {
        this.error = null;
        this.onError?.(null);
      }
    });
    if (this.logSize > COMPACT_AFTER) this.scheduleCompact();
    return written;
  }

  /** Folds the log into a new snapshot (one compaction at a time). */
  compact(force = false): Promise<void> {
    this.compacting ??= this.flush()
      .then(() => this.compactor(this.codec, force))
      .then((folded) => {
        this.logSize -= folded;
      })
      .catch((e: unknown) => this.fail(e))
      .finally(() => {
        this.compacting = null;
      });
    return this.compacting;
  }

  /**
   * Switches to another codec: new writes use it at once, and a forced
   * compaction rewrites the snapshot and folds the log, so nothing stays
   * stored the old way. Turning encryption on (or off), or onto another key,
   * is this. The compaction reads both ways (`recoding`); unlike routine
   * compaction its failure is thrown, since until it succeeds the store
   * mixes two codecs and the caller must not go on as if it were switched.
   */
  async recode(codec: Codec): Promise<void> {
    await this.flush();
    if (this.compacting) await this.compacting;
    const through = recoding(codec, this.codec);
    this.codec = codec;
    const run = this.compactor(through, true).then((folded) => {
      this.logSize -= folded;
    });
    this.compacting = run.catch(() => {}).finally(() => {
      this.compacting = null;
    });
    await run;
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
    const run = this.chain.then(task).catch((e: unknown) => this.fail(e));
    this.chain = run;
    return run;
  }

  private fail(e: unknown): void {
    this.error = e;
    console.error('Saving failed', e);
    this.onError?.(e);
    if (this.unsaved && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.flush();
      }, RETRY_DELAY);
    }
  }

  /** A new connection to the database, the old one closed. */
  private async reconnect(): Promise<void> {
    const db = await openDb(this.name);
    this.db.close();
    this.db = db;
  }
}
