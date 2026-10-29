import { clock } from '../model/clock';
import { invert, type Doc, type DocListener } from '../model/doc';
import { applyMerged } from '../model/merge';
import type { Op } from '../model/types';
import { LockedError, type Codec } from '../persist/codec';
import { done, request } from '../persist/db';
import type { MetaWrite, Rider } from '../persist/idb';
import { coalesceInto, deserialize, serialize } from '../persist/serialize';
import { GoneError, type Transport } from './client';
import { decryptWith, encryptWith, isEncrypted, type Encrypted } from './crypto';
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
  /**
   * The batch last posted and not acknowledged yet: its id and how many
   * batches at the head of the outbox it carries. Written before the post,
   * so a batch the server took whose answer was lost is known when it comes
   * back in a pull: acknowledged then, not applied and sent a second time
   * (which undid what other devices did in between).
   */
  sent?: { id: string; batches: number };
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
  /** Random per post (`SyncState.sent`); absent in batches of earlier versions. */
  id?: string;
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
/**
 * Local ops made since the state was last written whole, written with every
 * batch of the log (persist/idb.ts riders): the outbox as of that batch is
 * the state's plus these. Reading the state folds them in.
 */
const TAIL_KEY = 'syncTail';
/** Upload a fresh snapshot once this many batches have gone by since the last one. */
const SNAPSHOT_EVERY = 500;
/** Wait after a local change before pushing, ms: a typing burst goes as one batch. */
const PUSH_DELAY = 1000;
/** Wait after a local change before the outbox is written to IndexedDB, ms. */
const SAVE_DELAY = 300;

const opsAad = (docId: string, seq: number) => `listik|${docId}|ops|${seq}`;
const snapshotAad = (docId: string, seq: number) => `listik|${docId}|snapshot|${seq}`;

const newDeviceId = () => toBase64(crypto.getRandomValues(new Uint8Array(9)));
const newBatchId = () => toBase64(crypto.getRandomValues(new Uint8Array(12)));

/**
 * The ops waiting to be sent are the document's text: stored sealed with
 * its key, as the log is (persist/codec.ts). Head, hash, device id and the
 * snapshot's sequence stay plain. An outbox stored plain by an earlier
 * version is read as it is and sealed by the next write.
 */
const OUTBOX_AAD = 'listik|local|outbox';
const TAIL_AAD = 'listik|local|tail';

/** The state as stored: the outbox sealed. */
type StoredState = Omit<SyncState, 'outbox'> & { outbox: Op[][] | Encrypted };

const seal = (key: CryptoKey, value: unknown, aad: string) => encryptWith(key, utf8(JSON.stringify(value)), aad);

async function unseal<T>(key: CryptoKey | undefined, value: T | Encrypted, aad: string): Promise<T> {
  if (!isEncrypted(value)) return value as T;
  if (!key) throw new LockedError();
  return JSON.parse(fromUtf8(await decryptWith(key, value as Encrypted, aad))) as T;
}

/** The sync state, its outbox with the ops of the tail after it; `key` opens them. */
export async function readSyncState(db: IDBDatabase, key?: CryptoKey): Promise<SyncState | undefined> {
  const store = db.transaction('meta').objectStore('meta');
  const [stored, sealedTail] = await Promise.all([
    request(store.get(STATE_KEY) as IDBRequest<StoredState | undefined>),
    request(store.get(TAIL_KEY) as IDBRequest<Op[] | Encrypted | undefined>),
  ]);
  if (!stored) return undefined;
  const state: SyncState = { ...stored, outbox: await unseal<Op[][]>(key, stored.outbox, OUTBOX_AAD) };
  const tail = sealedTail && (await unseal<Op[]>(key, sealedTail, TAIL_AAD));
  if (tail?.length) state.outbox.push(tail);
  return state;
}

/** Writes the state whole, its outbox sealed with `key` (or deletes it): the tail is in it now. */
export async function writeSyncState(db: IDBDatabase, s: SyncState | undefined, key?: CryptoKey): Promise<void> {
  if (s && !key) throw new Error('the sync state is written sealed: a key is needed');
  const writes = await Promise.all(stateWrites(s, key!).map(async ({ key: k, value }) => ({ key: k, value: await value })));
  const tx = db.transaction('meta', 'readwrite');
  for (const { key: k, value } of writes) {
    if (value === undefined) tx.objectStore('meta').delete(k);
    else tx.objectStore('meta').put(value, k);
  }
  await done(tx);
}

/** The records of the state written whole; the outbox is being sealed (persist/idb.ts waits for it). */
const stateWrites = (s: SyncState | undefined, key: CryptoKey): MetaWrite[] => [
  { key: STATE_KEY, value: s && seal(key, s.outbox, OUTBOX_AAD).then((outbox): StoredState => ({ ...s, outbox })) },
  { key: TAIL_KEY, value: undefined },
];

/** Where the document's log is written (persist/idb.ts `Persistence`): the state goes along with it. */
export interface StateStore {
  flush(): Promise<void>;
  ride(rider: Rider): () => void;
}

type TextEdit = Extract<Op, { t: 'setText' | 'setNote' }>;

/** The first text or note edit of each bullet in the outbox: the one whose `was` is the server's time. */
function firstEdits(outbox: Op[][]): TextEdit[] {
  const seen = new Set<string>();
  const out: TextEdit[] = [];
  for (const batch of outbox) {
    for (const op of batch) {
      if ((op.t === 'setText' || op.t === 'setNote') && !seen.has(op.id)) {
        seen.add(op.id);
        out.push(op);
      }
    }
  }
  return out;
}

/** An op as sent: without `was`, which is this device's own bookkeeping. */
const unkept = (op: Op): Op => {
  if ((op.t !== 'setText' && op.t !== 'setNote') || op.was === undefined) return op;
  const { was: _, ...rest } = op;
  return rest;
};

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
  const prev = await readSyncState(db, key);
  const snap = await transport.getSnapshot();
  if (!snap) throw new Error('На сервере ещё нет снимка этого документа');
  const body = await openSnapshot(key, docId, snap.seq, snap.bytes);
  deserialize(body.snapshot); // must parse: a corrupt snapshot fails here, not on the next load
  const record = await codec.encodeSnapshot(body.snapshot);
  const outbox = await seal(key, prev?.outbox ?? [], OUTBOX_AAD);
  const tx = db.transaction(['meta', 'oplog'], 'readwrite');
  tx.objectStore('meta').put(record, 'snapshot');
  tx.objectStore('oplog').clear();
  tx.objectStore('meta').put({
    head: snap.seq, headHash: body.hash, device: prev?.device ?? newDeviceId(), outbox, snapshotSeq: snap.seq,
    ...(prev?.sent ? { sent: prev.sent } : {}),
  } satisfies StoredState, STATE_KEY);
  tx.objectStore('meta').delete(TAIL_KEY); // folded into the outbox above
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
  /** The log the state is written with (`attach`); null: written on its own. */
  private store: { flush(): Promise<void>; unride: () => void } | null = null;
  /** The next batch of the log takes the whole state. */
  private whole = false;
  /** Local ops since the state was last cut whole: the tail. */
  private tail: Op[] = [];
  private tailChanged = false;
  /** The head in the state last cut whole: a moved head goes whole with the batch that moved it. */
  private wholeHead: number;

  constructor(doc: Doc, db: IDBDatabase, transport: Transport, key: CryptoKey, docId: string, state: SyncState, options: { live?: boolean; now?: () => number } = {}) {
    this.doc = doc;
    this.db = db;
    this.transport = transport;
    this.key = key;
    this.docId = docId;
    this.options = options;
    this.state = state;
    // Batches read back may have been posted: new edits open a batch of their own, so `sent.batches` still counts right.
    for (const b of state.outbox as OutboxBatch[]) b.sealed = true;
    this.wholeHead = state.head;
    this.status = { phase: 'idle', pending: this.pendingCount(), head: state.head };
    doc.subscribe(this);
  }

  static async open(doc: Doc, db: IDBDatabase, transport: Transport, key: CryptoKey, docId: string, options?: { live?: boolean }): Promise<SyncEngine> {
    const stored = await readSyncState(db, key);
    const state = stored ?? { head: 0, headHash: '', device: newDeviceId(), outbox: [], snapshotSeq: -1 };
    if (!stored) await writeSyncState(db, state, key);
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

  /**
   * Writes the state with the document's log from now on, in the same
   * transactions: the ops in the log and the outbox (and the head) always
   * agree, whenever the page stops. Without it a page closed between the two
   * writes kept an edit here that never reached the server.
   */
  attach(store: StateStore): void {
    this.store = { flush: () => store.flush(), unride: store.ride(this.ride) };
    void this.save();
  }

  /** The state's records for the batch being cut: whole when asked or when the head moved, else the tail. */
  private ride = (): MetaWrite[] => {
    if (this.whole || this.state.head !== this.wholeHead) {
      this.whole = false;
      this.tail = [];
      this.tailChanged = false;
      this.wholeHead = this.state.head;
      return stateWrites(this.copy(), this.key);
    }
    if (!this.tailChanged) return [];
    this.tailChanged = false;
    return [{ key: TAIL_KEY, value: seal(this.key, this.tail, TAIL_AAD) }];
  };

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
    // The state was cut just now: nothing more goes with the log.
    this.store?.unride();
    this.store = null;
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
    let last = this.state.outbox[this.state.outbox.length - 1];
    if (!last || last.sealed) this.state.outbox.push((last = []));
    // A typing burst becomes one op here, not only in the batch sent: the
    // rebase must apply exactly what the other devices get, or a collision
    // came out one way here and another way there.
    const kept = shared.map((op) => (op.t === 'setText' || op.t === 'setNote' ? { ...op, was: this.doc.updatedBefore(op) } : op));
    for (const op of kept) coalesceInto(last, op);
    if (this.store) {
      this.tail.push(...kept);
      this.tailChanged = true;
    }
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
      await this.pull();
      // Each round seals what the outbox holds right now (ops typed meanwhile
      // open a new batch rather than changing one in flight) and sends it;
      // a round that sent nothing new ends the exchange.
      for (;;) {
        for (const b of this.state.outbox) b.sealed = true;
        if (!this.state.outbox.length) break;
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
      // A batch of the outbox already posted? Then the server took it though its answer never came.
      const sent = this.state.sent;
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
      let theirs: Op[] = [];
      for (const b of batches) {
        if (sent && b.body.id === sent.id && b.body.device === this.state.device) {
          // This device's own batch, its answer lost: the ops are here already; it is acknowledged, not applied again.
          if (theirs.length) this.applyRemote(theirs);
          theirs = [];
          this.state.outbox.splice(0, Math.min(sent.batches, this.state.outbox.length));
          this.state.sent = undefined;
          this.set({ pending: this.pendingCount() });
        } else {
          theirs.push(...b.body.ops);
        }
      }
      if (theirs.length) this.applyRemote(theirs);
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
        // An undone edit leaves its own time in `updated`, which decides a
        // collision (merge.ts): each bullet gets back the server's, so the
        // ops that come apply here as on any other device.
        const first = firstEdits(outbox);
        for (const op of first) {
          const n = this.doc.nodes.get(op.id);
          if (n && op.was !== undefined && n.updated !== op.was) this.doc.apply({ t: 'setText', id: n.id, from: n.text, to: n.text, at: op.was });
        }
        for (const op of ops) applyMerged(this.doc, op);
        for (const op of first) {
          const n = this.doc.nodes.get(op.id);
          if (n) op.was = n.updated;
        }
        for (const batch of outbox) for (const op of batch) applyMerged(this.doc, op);
      });
    } finally {
      this.remote = false;
    }
  }

  /** Sends the sealed outbox as one batch on top of our head; false if the server moved on. */
  private async push(): Promise<boolean> {
    const sealed = this.state.outbox.filter((b) => b.sealed);
    if (!sealed.length) throw new Error('push without a sealed batch'); // the exchange loop seals first
    // As the outbox holds them (each batch coalesced as it grew): the rebase here applied the same ops.
    const ops = sealed.flat().map(unkept);
    const seq = this.state.head + 1;
    const id = newBatchId();
    const body: BatchBody = { device: this.state.device, id, prev: this.state.headHash, ops };
    const bytes = pack(await encryptWith(this.key, utf8(JSON.stringify(body)), opsAad(this.docId, seq)));
    // On disk before the post: a reload after a lost answer still knows the batch when it comes back.
    this.state.sent = { id, batches: sealed.length };
    await this.save();
    const result = await this.transport.postOps(this.state.head, toBase64(bytes));
    if ('conflict' in result) return false;
    // The state changes all at once: a batch of the log cut in between would take half of it.
    const hash = await sha256(bytes);
    this.state.sent = undefined;
    this.state.outbox = this.state.outbox.filter((b) => !b.sealed);
    this.state.head = result.seq;
    this.state.headHash = hash;
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

  /** Writes the state whole: with the next batch of the log when attached, else on its own. */
  private save(): Promise<void> {
    if (this.store) {
      this.whole = true;
      return this.store.flush();
    }
    return writeSyncState(this.db, this.copy(), this.key);
  }

  private copy(): SyncState {
    const { head, headHash, device, outbox, snapshotSeq, sent } = this.state;
    return { head, headHash, device, outbox: outbox.map((b) => [...b]), snapshotSeq, ...(sent ? { sent: { ...sent } } : {}) };
  }

  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }
}
