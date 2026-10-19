import { clock } from '../model/clock';
import { invert, type Doc, type DocListener } from '../model/doc';
import { applyMerged } from '../model/merge';
import type { Op } from '../model/types';
import type { Codec } from '../persist/codec';
import { getMeta, putMeta } from '../persist/db';
import { coalesce, deserialize, serialize } from '../persist/serialize';
import { GoneError, type Transport } from './client';
import { decryptWith, encryptWith, type Encrypted } from './crypto';
import { fromBase64, fromUtf8, gunzip, gzip, sha256, toBase64, utf8 } from './encoding';

/**
 * Keeps this device's document equal to the server's log.
 *
 * The server holds one ordered log of batches per document. Every batch is
 * encrypted here; its plaintext names the batch before it (a hash chain),
 * so a server that drops, reorders or forges batches is caught. A device
 * appends only on top of the head it has applied (compare-and-append): if
 * another device got there first, this one pulls, rebases and tries again.
 *
 * Rebase: the local ops not on the server yet (the outbox) are undone,
 * the server's new batches applied, then the outbox re-applied, all through
 * the merge layer (model/merge.ts) and all in one transaction. The outbox
 * is sent as authored: every device runs the same merge over the same
 * order, so all of them end in the same state.
 *
 * The folded state (`setCollapsed`) stays on the device: it is never sent.
 */

export interface SyncState {
  /** Last server sequence applied here. */
  head: number;
  /** Hash of the batch at `head` (or of the snapshot's chain value), for the chain check. */
  headHash: string;
  /** This device's id, written into its batches. */
  device: string;
  /** Local ops not acknowledged by the server yet, as authored. */
  outbox: OutboxBatch[];
  /** The sequence of the last snapshot this device uploaded. */
  snapshotSeq: number;
}

export type SyncPhase = 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'stopped';

export interface SyncStatus {
  phase: SyncPhase;
  /** Ops waiting to go to the server. */
  pending: number;
  head: number;
  /** When the last successful exchange ended. */
  last?: number;
  error?: string;
}

/** A batch in the outbox; `sealed` once an exchange has started sending it (not stored). */
type OutboxBatch = Op[] & { sealed?: boolean };

interface BatchBody {
  device: string;
  prev: string;
  ops: Op[];
}

interface SnapshotBody {
  v: 1;
  seq: number;
  hash: string;
  snapshot: string;
}

const STATE_KEY = 'syncState';
/** Upload a fresh snapshot once this many batches have gone by since the last one. */
const SNAPSHOT_EVERY = 500;
/** Wait after a local change before pushing, ms: a typing burst goes as one batch. */
const PUSH_DELAY = 1000;
/** Wait after a local change before the outbox is written to IndexedDB, ms. */
const SAVE_DELAY = 300;

const opsAad = (docId: string, seq: number) => `listik|${docId}|ops|${seq}`;
const snapshotAad = (docId: string, seq: number) => `listik|${docId}|snapshot|${seq}`;

const newDeviceId = () => toBase64(crypto.getRandomValues(new Uint8Array(9)));

export const readSyncState = (db: IDBDatabase) => getMeta<SyncState>(db, STATE_KEY);
export const writeSyncState = (db: IDBDatabase, s: SyncState | undefined) => putMeta(db, STATE_KEY, s);

/** iv ‖ ciphertext, as sent to the server. */
const pack = (e: Encrypted): Uint8Array => {
  const out = new Uint8Array(e.iv.length + e.ct.length);
  out.set(e.iv);
  out.set(e.ct, e.iv.length);
  return out;
};
const unpack = (b: Uint8Array): Encrypted => ({ enc: 1, iv: b.subarray(0, 12), ct: b.subarray(12) });

/** Encrypts and packs a snapshot for the server; `hash` chains it to the batch it covers. */
export async function sealSnapshot(key: CryptoKey, docId: string, seq: number, hash: string, snapshot: string): Promise<Uint8Array> {
  const body: SnapshotBody = { v: 1, seq, hash, snapshot };
  return pack(await encryptWith(key, await gzip(utf8(JSON.stringify(body))), snapshotAad(docId, seq)));
}

export async function openSnapshot(key: CryptoKey, docId: string, seq: number, bytes: Uint8Array): Promise<SnapshotBody> {
  const plain = await gunzip(await decryptWith(key, unpack(bytes), snapshotAad(docId, seq)));
  const body = JSON.parse(fromUtf8(plain)) as SnapshotBody;
  if (body.seq !== seq) throw new Error('snapshot sequence mismatch');
  return body;
}

/**
 * Makes this device a replica of the server's document: writes the server's
 * snapshot as the local snapshot, clears the local log and sets the sync
 * state, keeping any outbox there is. Reload after. Every document on the
 * server starts with a snapshot (the creating device uploads one at once),
 * so two devices never invent two different first bullets.
 */
export async function bootstrap(db: IDBDatabase, codec: Codec, key: CryptoKey, docId: string, transport: Transport): Promise<void> {
  const prev = await readSyncState(db);
  const snap = await transport.getSnapshot();
  if (!snap) throw new Error('На сервере ещё нет снимка этого документа');
  const body = await openSnapshot(key, docId, snap.seq, snap.bytes);
  deserialize(body.snapshot); // must parse: a corrupt snapshot fails here, not on the next load
  const record = await codec.encodeSnapshot(body.snapshot);
  const tx = db.transaction(['meta', 'oplog'], 'readwrite');
  tx.objectStore('meta').put(record, 'snapshot');
  tx.objectStore('oplog').clear();
  tx.objectStore('meta').put({
    head: snap.seq, headHash: body.hash, device: prev?.device ?? newDeviceId(), outbox: prev?.outbox ?? [], snapshotSeq: snap.seq,
  } satisfies SyncState, STATE_KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export class SyncEngine implements DocListener {
  status: SyncStatus;
  /** Called with every status change. */
  private listeners = new Set<(s: SyncStatus) => void>();
  private state: SyncState;
  private remote = false;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private running = false;
  private uploading: Promise<void> | null = null;
  /** A failed chain check: nothing more is sent or applied until the user resets. */
  private broken = false;
  private doc: Doc;
  private db: IDBDatabase;
  private transport: Transport;
  private key: CryptoKey;
  private docId: string;
  private options: { live?: boolean; now?: () => number };

  constructor(doc: Doc, db: IDBDatabase, transport: Transport, key: CryptoKey, docId: string, state: SyncState, options: { live?: boolean; now?: () => number } = {}) {
    this.doc = doc;
    this.db = db;
    this.transport = transport;
    this.key = key;
    this.docId = docId;
    this.options = options;
    this.state = state;
    this.status = { phase: 'idle', pending: this.pendingCount(), head: state.head };
    doc.subscribe(this);
  }

  static async open(doc: Doc, db: IDBDatabase, transport: Transport, key: CryptoKey, docId: string, options?: { live?: boolean }): Promise<SyncEngine> {
    const state = (await readSyncState(db)) ?? { head: 0, headHash: '', device: newDeviceId(), outbox: [], snapshotSeq: -1 };
    if (!(await readSyncState(db))) await writeSyncState(db, state);
    return new SyncEngine(doc, db, transport, key, docId, state, options);
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get head(): number {
    return this.state.head;
  }

  get device(): string {
    return this.state.device;
  }

  /** Starts syncing: one exchange now, then pushes after local changes and pulls when the server announces more. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.sync();
    if (this.options.live !== false) void this.listen();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onVisible);
      window.addEventListener('pagehide', this.onHide);
    }
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    void this.flush();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      document.removeEventListener('visibilitychange', this.onVisible);
      window.removeEventListener('pagehide', this.onHide);
    }
    this.set({ phase: 'stopped' });
  }

  // --- DocListener ---------------------------------------------------------

  commit(ops: Op[]): void {
    if (this.remote) return;
    // The folded state is this device's own.
    const shared = ops.filter((op) => op.t !== 'setCollapsed');
    if (!shared.length) return;
    const last = this.state.outbox[this.state.outbox.length - 1];
    if (last && !last.sealed) last.push(...shared);
    else this.state.outbox.push(shared);
    this.set({ pending: this.pendingCount() });
    // The outbox outlives the page: saved soon, like the document itself (idb.ts).
    this.saveTimer ??= setTimeout(() => void this.flush(), SAVE_DELAY);
    if (this.running && !this.pushTimer) this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.sync();
    }, PUSH_DELAY);
  }

  // --- The exchange ----------------------------------------------------------

  /** Pulls what the server has, pushes what this device has, until both sides agree. Exchanges never overlap. */
  sync(): Promise<void> {
    const run = this.chain.then(() => this.exchange());
    this.chain = run.catch(() => {});
    return run;
  }

  private async exchange(): Promise<void> {
    if (this.broken) return;
    this.set({ phase: 'syncing' });
    try {
      // Seal the current outbox batches: new local ops open a new batch rather than changing one in flight.
      for (const b of this.state.outbox) b.sealed = true;
      await this.pull();
      while (this.state.outbox.length) {
        if (!(await this.push())) await this.pull();
      }
      await this.save();
      this.set({ phase: 'synced', last: (this.options.now ?? Date.now)(), error: undefined });
      this.maybeUploadSnapshot();
    } catch (e) {
      await this.save();
      if (e instanceof GoneError) {
        this.set({ phase: 'error', error: 'Сервер больше не хранит журнал с этого места: нужно загрузить документ с сервера заново' });
        throw e;
      }
      const offline = e instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false);
      this.set({ phase: offline ? 'offline' : 'error', error: offline ? undefined : String(e instanceof Error ? e.message : e) });
      if (!offline) console.error('Sync failed', e);
      throw e;
    }
  }

  /** Applies every batch after our head. */
  private async pull(): Promise<void> {
    for (;;) {
      const page = await this.transport.getOps(this.state.head);
      if (!page.batches.length) return;
      const batches: { seq: number; body: BatchBody; hash: string }[] = [];
      let prev = this.state.headHash;
      for (const b of page.batches) {
        const bytes = fromBase64(b.body);
        let body: BatchBody | null = null;
        try {
          body = JSON.parse(fromUtf8(await decryptWith(this.key, unpack(bytes), opsAad(this.docId, b.seq)))) as BatchBody;
        } catch {
          // Not ours, or not at this position: forged or moved.
        }
        if (!body || body.prev !== prev) {
          this.broken = true;
          this.set({ phase: 'error', error: 'Журнал на сервере не сходится с этим устройством: запись не расшифровывается или цепочка разорвана' });
          throw new Error(`batch ${b.seq} rejected: ${body ? 'hash chain broken' : 'cannot decrypt'}`);
        }
        prev = await sha256(bytes);
        batches.push({ seq: b.seq, body, hash: prev });
      }
      this.applyRemote(batches.flatMap((b) => b.body.ops));
      const last = batches[batches.length - 1];
      this.state.head = last.seq;
      this.state.headHash = last.hash;
      this.set({ head: last.seq });
      if (last.seq >= page.head) return;
    }
  }

  /** Remote ops land in one transaction: the outbox is undone, they apply, the outbox re-applies on top. */
  private applyRemote(ops: Op[]): void {
    for (const op of ops) if ('at' in op && op.at !== undefined) clock.observe(op.at);
    const outbox = this.state.outbox;
    this.remote = true;
    try {
      this.doc.transact(() => {
        for (let i = outbox.length - 1; i >= 0; i--) {
          for (let k = outbox[i].length - 1; k >= 0; k--) applyMerged(this.doc, invert(outbox[i][k]));
        }
        for (const op of ops) applyMerged(this.doc, op);
        for (const batch of outbox) for (const op of batch) applyMerged(this.doc, op);
      });
    } finally {
      this.remote = false;
    }
  }

  /** Sends the sealed outbox as one batch on top of our head; false if the server moved on. */
  private async push(): Promise<boolean> {
    const sealed = this.state.outbox.filter((b) => b.sealed);
    if (!sealed.length) return true;
    const ops = coalesce(sealed.flat());
    const seq = this.state.head + 1;
    const body: BatchBody = { device: this.state.device, prev: this.state.headHash, ops };
    const bytes = pack(await encryptWith(this.key, utf8(JSON.stringify(body)), opsAad(this.docId, seq)));
    const result = await this.transport.postOps(this.state.head, toBase64(bytes));
    if ('conflict' in result) return false;
    this.state.outbox = this.state.outbox.filter((b) => !b.sealed);
    this.state.head = result.seq;
    this.state.headHash = await sha256(bytes);
    this.set({ head: result.seq, pending: this.pendingCount() });
    return true;
  }

  private maybeUploadSnapshot(): void {
    if (this.uploading || this.state.outbox.length) return;
    if (this.state.head - this.state.snapshotSeq < SNAPSHOT_EVERY && this.state.snapshotSeq >= 0) return;
    this.uploading = this.uploadSnapshot().catch((e: unknown) => console.error('Snapshot upload failed', e)).finally(() => {
      this.uploading = null;
    });
  }

  /** Puts the document as it is now on the server, for new devices and devices far behind. */
  async uploadSnapshot(): Promise<void> {
    const seq = this.state.head;
    const bytes = await sealSnapshot(this.key, this.docId, seq, this.state.headHash, serialize(this.doc));
    await this.transport.putSnapshot(seq, bytes);
    this.state.snapshotSeq = Math.max(this.state.snapshotSeq, seq);
    await this.save();
  }

  /** The event stream: the server says when its head moves. Reconnects with backoff while running. */
  private async listen(): Promise<void> {
    let delay = 1000;
    while (this.running) {
      this.abort = new AbortController();
      try {
        await this.transport.events((head) => {
          delay = 1000;
          if (head > this.state.head) void this.sync();
        }, this.abort.signal);
      } catch {
        // Dropped or refused: fall through to the retry.
      }
      if (!this.running) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private onOnline = () => void this.sync();
  private onVisible = () => document.visibilityState === 'visible' && void this.sync();
  private onHide = () => void this.flush();

  /** Writes the sync state (outbox included) now. */
  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.save();
  }

  private pendingCount(): number {
    return this.state.outbox.reduce((n, b) => n + b.length, 0);
  }

  private save(): Promise<void> {
    const { head, headHash, device, outbox, snapshotSeq } = this.state;
    return writeSyncState(this.db, { head, headHash, device, outbox: outbox.map((b) => [...b]), snapshotSeq });
  }

  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }
}
