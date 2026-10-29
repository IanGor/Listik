import 'fake-indexeddb/auto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { History } from '../src/model/history';
import { checkInvariants } from '../src/model/invariants';
import { CONFLICT } from '../src/model/merge';
import { VisibleRows } from '../src/model/rows';
import { openDb } from '../src/persist/db';
import { Persistence } from '../src/persist/idb';
import { httpTransport } from '../src/sync/client';
import { dataKey, newDocId } from '../src/sync/crypto';
import { SyncEngine, bootstrap, readSyncState } from '../src/sync/engine';
import { dump, rng } from './helpers';
import { plainCodec } from '../src/persist/codec';

let server: Server;
let url: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'listik-sync-'));
  process.env.LISTIK_DATA = dataDir;
  process.env.LISTIK_RETENTION = '0';
  const { createListikServer } = (await import('../server/index.js')) as { createListikServer(): Server };
  server = createListikServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let n = 0;
const key = () => dataKey(new Uint8Array(32).fill(42));

/** A device: its own IndexedDB, doc, history and engine, against the shared server. */
async function device(docId: string, token: string, opts: { bootstrap?: boolean; attach?: boolean } = {}) {
  const name = `sync-${docId}-${n++}`;
  const transport = httpTransport(url, docId, token);
  const k = await key();
  if (opts.bootstrap) {
    const db = await openDb(name);
    await bootstrap(db, plainCodec, k, docId, transport);
    db.close();
  }
  const { doc, persistence } = await Persistence.open(name);
  const rows = new VisibleRows(doc);
  const ctx = { doc, rows };
  const history = new History();
  const engine = await SyncEngine.open(doc, await openDb(name), transport, k, docId, { live: false });
  if (opts.attach) engine.attach(persistence);
  const run = (fn: () => unknown) => {
    const ops = doc.transact(() => { fn(); });
    history.record({ ops, before: null, after: null }, { typing: ops.length === 1 && ops[0].t === 'setText' });
  };
  return { name, doc, rows, ctx, history, engine, persistence, run, transport };
}

/** Creates the document on the server the way the app does: key slot, then the first device's snapshot. */
async function createDoc() {
  const docId = newDocId();
  const token = `token-${docId}`;
  const transport = httpTransport(url, docId, token);
  expect(await transport.putKeyslot({ v: 1, kdf: { m: 1, t: 1, p: 1 }, wrapped: { iv: '', ct: '' } })).toEqual({ created: true });
  const a = await device(docId, token);
  await a.engine.uploadSnapshot();
  return { docId, token, transport, a };
}

describe('sync', () => {
  it('two devices converge; a move and an edit of the same bullet both survive; the server sees only ciphertext', async () => {
    const { docId, token, a } = await createDoc();
    const b = await device(docId, token, { bootstrap: true });
    a.run(() => cmd.setText(a.ctx, a.rows.ids[0], 'первый'));
    a.run(() => cmd.split(a.ctx, a.rows.ids[0], 6));
    a.run(() => cmd.setText(a.ctx, a.rows.ids[1], 'второй'));
    await a.engine.sync();
    await b.engine.sync();
    expect(dump(b.doc)).toEqual(['первый', 'второй']);
    // Both offline: a moves "второй" under "первый", b edits its text.
    const second = b.rows.ids[1];
    a.run(() => cmd.indent(a.ctx, second));
    b.run(() => cmd.setText(b.ctx, second, 'второй, исправлен'));
    await a.engine.sync();
    await b.engine.sync(); // pulls a's move, rebases its edit, pushes
    await a.engine.sync(); // pulls b's edit
    expect(dump(a.doc)).toEqual(['первый', '  второй, исправлен']);
    expect(dump(b.doc)).toEqual(dump(a.doc));
    expect(a.engine.status.phase).toBe('synced');
    expect(a.engine.status.pending).toBe(0);
    checkInvariants(a.doc);
    checkInvariants(b.doc);

    const files = await readdir(join(dataDir, 'docs', docId));
    const log = await readFile(join(dataDir, 'docs', docId, 'ops.jsonl'), 'utf8');
    expect(files).toContain('ops.jsonl');
    expect(log).not.toContain('перв');
    expect(log).not.toContain('setText');
    // Undo on b works although a's move came in between (via the merge layer).
    b.history.undo(b.doc);
    expect(dump(b.doc)).toEqual(['первый', '  второй']);
    await b.engine.sync();
    await a.engine.sync();
    expect(dump(a.doc)).toEqual(['первый', '  второй']);
  });

  it('a collision keeps the later text and the other version in the note, on every device', async () => {
    const { docId, token, a } = await createDoc();
    const b = await device(docId, token, { bootstrap: true });
    a.run(() => cmd.setText(a.ctx, a.rows.ids[0], 'слово'));
    await a.engine.sync();
    await b.engine.sync();
    const id = a.rows.ids[0];
    a.run(() => cmd.setText(a.ctx, id, 'слово от a'));
    await new Promise((r) => setTimeout(r, 5));
    b.run(() => cmd.setText(b.ctx, id, 'слово от b'));
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect(a.doc.get(id).text).toBe('слово от b');
    expect(a.doc.get(id).note).toBe(`${CONFLICT}: слово от a`);
    expect(dump(b.doc)).toEqual(dump(a.doc));
    expect(b.doc.get(id).note).toBe(a.doc.get(id).note);
  });

  it('a new device starts from the snapshot, and a device left behind the retention gets told so', async () => {
    const { docId, token, a } = await createDoc();
    const stale = await device(docId, token, { bootstrap: true }); // starts at the seq-0 snapshot
    a.run(() => cmd.setText(a.ctx, a.rows.ids[0], 'в снимке'));
    a.run(() => cmd.split(a.ctx, a.rows.ids[0], 8));
    await a.engine.sync();
    await a.engine.uploadSnapshot(); // retention 0: the server drops the batches the snapshot covers
    a.run(() => cmd.setText(a.ctx, a.rows.ids[1], 'после снимка'));
    await a.engine.sync();
    const c = await device(docId, token, { bootstrap: true });
    expect((await readSyncState(await openDb(c.name), await key()))?.head).toBeGreaterThan(0);
    await c.engine.sync();
    expect(dump(c.doc)).toEqual(['в снимке', 'после снимка']);
    checkInvariants(c.doc);
    await expect(stale.engine.sync()).rejects.toThrow(/truncated/);
    expect(stale.engine.status.phase).toBe('error');
    // Bootstrapping again keeps what it had not sent; after the reload it rebases and catches up.
    stale.run(() => cmd.setText(stale.ctx, stale.rows.ids[0], 'в снимке, с отставшего'));
    await stale.engine.flush();
    await stale.persistence.flush();
    stale.persistence.close();
    const db = await openDb(stale.name);
    await bootstrap(db, plainCodec, await key(), docId, stale.transport);
    db.close();
    const reloaded = await Persistence.open(stale.name);
    const engine = await SyncEngine.open(reloaded.doc, await openDb(stale.name), stale.transport, await key(), docId, { live: false });
    expect(engine.status.pending).toBe(1);
    await engine.sync();
    expect(dump(reloaded.doc)).toEqual(['в снимке, с отставшего', 'после снимка']);
    await c.engine.sync();
    expect(dump(c.doc)).toEqual(dump(reloaded.doc));
  });

  it('attached to the log, the outbox agrees with it whenever the page stops: nothing typed stays unsent, nothing goes twice', async () => {
    const { docId, token, a: other } = await createDoc();
    const a = await device(docId, token, { bootstrap: true, attach: true });
    await a.engine.sync();
    a.run(() => cmd.setText(a.ctx, a.rows.ids[0], 'набрано'));
    a.run(() => { cmd.split(a.ctx, a.rows.ids[0], 7); });
    a.run(() => cmd.setText(a.ctx, a.rows.ids[1], 'и закрыто'));
    // The batch of the log goes at the end of the task; the state's own save (300 ms) never comes: the page is gone.
    await a.persistence.flush();
    const db = await openDb(a.name);
    expect((await readSyncState(db, await key()))?.outbox.flat().length).toBe(3);
    // Sealed with the document's key, as the log is: neither the state nor its tail shows the text.
    const raw = await new Promise<unknown[]>((resolve) => {
      const r = db.transaction('meta').objectStore('meta').getAll();
      r.onsuccess = () => resolve(r.result);
    });
    expect(JSON.stringify(raw)).not.toContain('набрано');
    expect(JSON.stringify(raw)).not.toContain('setText');
    await expect(readSyncState(db)).rejects.toThrow(/key/);
    db.close();
    const reloaded = await Persistence.open(a.name);
    expect(dump(reloaded.doc)).toEqual(['набрано', 'и закрыто']);
    const engine = await SyncEngine.open(reloaded.doc, await openDb(a.name), a.transport, await key(), docId, { live: false });
    engine.attach(reloaded.persistence);
    expect(engine.status.pending).toBe(3);
    await engine.sync();
    await other.engine.sync();
    expect(dump(other.doc)).toEqual(['набрано', 'и закрыто']);
    // Another device's edit comes in; the page stops right after: the head went with the ops it brought.
    other.run(() => cmd.setText(other.ctx, other.rows.ids[1], 'и закрыто, и исправлено'));
    await other.engine.sync();
    await engine.sync();
    await reloaded.persistence.flush();
    const again = await Persistence.open(a.name);
    const engine2 = await SyncEngine.open(again.doc, await openDb(a.name), a.transport, await key(), docId, { live: false });
    expect(engine2.status.pending).toBe(0);
    expect(engine2.head).toBe(engine.head);
    await engine2.sync();
    expect(dump(again.doc)).toEqual(['набрано', 'и закрыто, и исправлено']);
    expect(engine2.head).toBe(engine.head);
  });

  it('a batch the server took whose answer was lost is acknowledged when it comes back, not sent again over what came after', async () => {
    const { docId, token, a } = await createDoc();
    a.run(() => cmd.setText(a.ctx, a.rows.ids[0], 'one'));
    a.run(() => { cmd.split(a.ctx, a.rows.ids[0], 3); });
    a.run(() => cmd.setText(a.ctx, a.rows.ids[1], 'two'));
    await a.engine.sync();
    const b = await device(docId, token, { bootstrap: true });
    await b.engine.sync();
    const post = a.transport.postOps.bind(a.transport);
    let lose = true;
    (a.transport as { postOps: typeof post }).postOps = async (parent, body) => {
      const result = await post(parent, body);
      if (lose) {
        lose = false;
        throw new TypeError('Failed to fetch'); // the server has it; the answer never came
      }
      return result;
    };
    a.run(() => { cmd.indent(a.ctx, a.rows.ids[1]); });
    await expect(a.engine.sync()).rejects.toThrow(/fetch/);
    expect(a.engine.status.pending).toBe(1);
    await b.engine.sync();
    expect(dump(b.doc)).toEqual(['one', '  two']);
    b.run(() => { cmd.outdent(b.ctx, b.rows.ids[1]); });
    await b.engine.sync();
    const head = b.engine.head;
    await a.engine.sync();
    expect(a.engine.status.pending).toBe(0);
    expect(a.engine.head).toBe(head); // nothing went twice
    await b.engine.sync();
    expect(dump(a.doc)).toEqual(['one', 'two']);
    expect(dump(b.doc)).toEqual(['one', 'two']);
  });

  it('a lost answer is still known after a reload: the batch posted is in the stored state', async () => {
    const { docId, token, a: other } = await createDoc();
    other.run(() => cmd.setText(other.ctx, other.rows.ids[0], 'one'));
    other.run(() => { cmd.split(other.ctx, other.rows.ids[0], 3); });
    other.run(() => cmd.setText(other.ctx, other.rows.ids[1], 'two'));
    await other.engine.sync();
    const a = await device(docId, token, { bootstrap: true, attach: true });
    await a.engine.sync();
    const post = a.transport.postOps.bind(a.transport);
    (a.transport as { postOps: typeof post }).postOps = async (parent, body) => {
      await post(parent, body);
      throw new TypeError('Failed to fetch');
    };
    a.run(() => { cmd.indent(a.ctx, a.rows.ids[1]); });
    await expect(a.engine.sync()).rejects.toThrow(/fetch/);
    a.run(() => cmd.setText(a.ctx, a.rows.ids[0], 'one!')); // typed after: not in the lost batch
    await a.persistence.flush();
    await other.engine.sync();
    expect(dump(other.doc)).toEqual(['one', '  two']);
    other.run(() => { cmd.outdent(other.ctx, other.rows.ids[1]); });
    await other.engine.sync();
    const reloaded = await Persistence.open(a.name);
    const engine = await SyncEngine.open(reloaded.doc, await openDb(a.name), httpTransport(url, docId, token), await key(), docId, { live: false });
    engine.attach(reloaded.persistence);
    expect(engine.status.pending).toBe(2);
    await engine.sync();
    expect(engine.status.pending).toBe(0);
    await other.engine.sync();
    expect(dump(other.doc)).toEqual(['one!', 'two']);
    expect(dump(reloaded.doc)).toEqual(dump(other.doc));
    expect(engine.head).toBe(other.engine.head);
  });

  it('an outbox an earlier version stored plain is read as it is and sealed from then on', async () => {
    const { docId, token } = await createDoc();
    const name = `sync-legacy-${n++}`;
    const db = await openDb(name);
    await bootstrap(db, plainCodec, await key(), docId, httpTransport(url, docId, token));
    const op = { t: 'setText', id: 'x', from: '', to: 'неотправленное' };
    await new Promise<void>((resolve) => {
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const r = store.get('syncState');
      r.onsuccess = () => store.put({ ...r.result, outbox: [[op]] }, 'syncState');
      tx.oncomplete = () => resolve();
    });
    expect((await readSyncState(db, await key()))?.outbox).toEqual([[op]]);
    const { doc } = await Persistence.open(name);
    const engine = await SyncEngine.open(doc, db, httpTransport(url, docId, token), await key(), docId, { live: false });
    expect(engine.status.pending).toBe(1);
    await engine.flush();
    const raw = await new Promise<unknown>((resolve) => {
      const r = db.transaction('meta').objectStore('meta').get('syncState');
      r.onsuccess = () => resolve(r.result);
    });
    expect(JSON.stringify(raw)).not.toContain('неотправленное');
    expect((await readSyncState(db, await key()))?.outbox).toEqual([[op]]);
  });

  it('an edit made while an exchange is running is sent by that exchange, which ends', { timeout: 10_000 }, async () => {
    const { docId, token, a } = await createDoc();
    const b = await device(docId, token, { bootstrap: true });
    // Hook the transport: the first pull of the next exchange lands while the user presses Enter.
    const inner = a.transport.getOps.bind(a.transport);
    let hooked = false;
    (a.transport as { getOps: typeof inner }).getOps = async (after) => {
      const page = await inner(after);
      if (!hooked) {
        hooked = true;
        a.run(() => { cmd.split(a.ctx, a.rows.ids[0], 0); });
        a.run(() => cmd.setText(a.ctx, a.rows.ids[1], 'набрано во время обмена'));
      }
      return page;
    };
    a.run(() => cmd.setText(a.ctx, a.rows.ids[0], 'до обмена'));
    await a.engine.sync(); // used to spin forever here
    expect(a.engine.status.pending).toBe(0);
    await b.engine.sync();
    expect(dump(b.doc)).toEqual(['', 'набрано во время обмена']);
  });

  it('LISTIK_ALLOW_CREATE=0 refuses new documents but keeps serving existing ones', async () => {
    const { a } = await createDoc();
    process.env.LISTIK_ALLOW_CREATE = '0';
    try {
      const docId = newDocId();
      const t = httpTransport(url, docId, `token-${docId}`);
      await expect(t.putKeyslot({ v: 1, kdf: { m: 1, t: 1, p: 1 }, wrapped: { iv: '', ct: '' } })).rejects.toThrow(/new documents/);
      a.run(() => cmd.setText(a.ctx, a.rows.ids[0], 'по-прежнему работает'));
      await a.engine.sync();
      expect(a.engine.status.phase).toBe('synced');
    } finally {
      delete process.env.LISTIK_ALLOW_CREATE;
    }
  });

  it('the server refuses a forged or reordered batch chain', async () => {
    const { docId, token, transport, a } = await createDoc();
    a.run(() => cmd.setText(a.ctx, a.rows.ids[0], 'честно'));
    await a.engine.sync();
    // A tampering server (or a stranger with the token) appends garbage it cannot encrypt properly.
    await transport.postOps(1, Buffer.from('not a real batch, just bytes').toString('base64'));
    const b = await device(docId, token, { bootstrap: true });
    await expect(b.engine.sync()).rejects.toThrow();
    expect(b.engine.status.phase).toBe('error');
  });

  it('many devices editing and syncing at random all end with the same outline', { timeout: 120_000 }, async () => {
    for (let seed = 1; seed <= 3; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const { docId, token, a: first } = await createDoc();
      first.run(() => cmd.setText(first.ctx, first.rows.ids[0], 'корень'));
      await first.engine.sync();
      const devices = [first];
      for (let k = 0; k < 2; k++) {
        const d = await device(docId, token, { bootstrap: true });
        await d.engine.sync();
        devices.push(d);
      }
      let steps = 0;
      for (let step = 0; step < 120; step++) {
        const d = pick(devices);
        const roll = rand();
        if (roll < 0.08) d.history.undo(d.doc);
        else if (roll < 0.12) d.history.redo(d.doc);
        else if (d.rows.length) {
          const id = pick(d.rows.ids);
          const node = d.doc.get(id);
          const action = pick([
            () => cmd.split(d.ctx, id, Math.floor(rand() * (node.text.length + 1))),
            () => cmd.mergeUp(d.ctx, id),
            () => cmd.deleteNode(d.ctx, id),
            () => cmd.indent(d.ctx, id),
            () => cmd.outdent(d.ctx, id),
            () => cmd.moveUp(d.ctx, id),
            () => cmd.moveDown(d.ctx, id),
            () => cmd.setCollapsed(d.ctx, id, !node.collapsed),
            () => cmd.setText(d.ctx, id, node.text + 'абв'[Math.floor(rand() * 3)]),
            () => cmd.setNote(d.ctx, id, node.note + 'з'),
            () => cmd.cycleTask(d.ctx, [id]),
          ]);
          d.run(action);
          steps++;
        }
        // Devices sync at their own pace; some stay offline for long stretches.
        if (rand() < 0.3) await pick(devices).engine.sync();
      }
      expect(steps).toBeGreaterThan(80);
      for (let round = 0; round < 3; round++) for (const d of devices) await d.engine.sync();
      for (const d of devices) {
        checkInvariants(d.doc);
        expect(d.engine.status.pending, `seed ${seed}`).toBe(0);
        // The folded state is per device: compared without its marker.
        const shape = (lines: string[]) => lines.map((l) => l.replace(/ \[\+\]$/, ''));
        expect(shape(dump(d.doc)), `seed ${seed}`).toEqual(shape(dump(devices[0].doc)));
        // Notes and flags converge too; the folded state is per device and may differ.
        for (const id of d.rows.ids) {
          const x = d.doc.get(id);
          const y = devices[0].doc.get(id);
          expect([x.text, x.note, x.todo, x.done], `seed ${seed} ${id}`).toEqual([y.text, y.note, y.todo, y.done]);
        }
      }
      // What was stored locally replays to the same document.
      for (const d of devices) {
        await d.persistence.flush();
        d.persistence.close();
        const back = await Persistence.read(d.name);
        expect(dump(back), `seed ${seed} local log`).toEqual(dump(d.doc));
      }
    }
  });
  // Last: it throttles the one address every test here shares.
  it('repeated failed authentications get a 429 for a while', async () => {
    const { docId } = await createDoc();
    const wrong = httpTransport(url, docId, 'definitely-not-the-token');
    let last: unknown;
    for (let k = 0; k < 25; k++) {
      last = await wrong.getOps(0).catch((e: unknown) => e);
    }
    expect(String((last as Error).message)).toMatch(/429|too many/);
  });
});
