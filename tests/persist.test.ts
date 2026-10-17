import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { History } from '../src/model/history';
import { checkInvariants } from '../src/model/invariants';
import { VisibleRows } from '../src/model/rows';
import { Persistence } from '../src/persist/idb';
import { coalesce, deserialize, serialize } from '../src/persist/serialize';
import { build, dump, rng } from './helpers';

let dbCounter = 0;
const freshName = () => `test-${dbCounter++}`;

async function reopen(name: string) {
  const { doc, persistence } = await Persistence.open(name);
  persistence.close();
  checkInvariants(doc);
  return doc;
}

async function logLength(name: string): Promise<number> {
  const db = await new Promise<IDBDatabase>((resolve) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => resolve(r.result);
  });
  const batches = await new Promise<unknown[][]>((resolve) => {
    const r = db.transaction('oplog').objectStore('oplog').getAll();
    r.onsuccess = () => resolve(r.result as unknown[][]);
  });
  db.close();
  return batches.reduce((n, b) => n + b.length, 0);
}

describe('snapshot', () => {
  it('round-trips structure, text, collapsed state and timestamps', () => {
    const doc = build(['a', '  b [+]', '    c', 'd']);
    const copy = deserialize(serialize(doc));
    checkInvariants(copy);
    expect(dump(copy)).toEqual(dump(doc));
    expect(copy.get('c')).toEqual(doc.get('c'));
  });

  it('coalesces adjacent edits of the same bullet only', () => {
    const ops = coalesce([
      { t: 'setText', id: 'a', from: '', to: 'x' },
      { t: 'setText', id: 'a', from: 'x', to: 'xy' },
      { t: 'setText', id: 'b', from: '', to: 'z' },
      { t: 'setText', id: 'a', from: 'xy', to: 'xyz' },
    ]);
    expect(ops).toEqual([
      { t: 'setText', id: 'a', from: '', to: 'xy', at: undefined },
      { t: 'setText', id: 'b', from: '', to: 'z' },
      { t: 'setText', id: 'a', from: 'xy', to: 'xyz' },
    ]);
  });
});

describe('Persistence', () => {
  it('starts a new document with one empty bullet and keeps it', async () => {
    const name = freshName();
    const { doc, persistence } = await Persistence.open(name);
    expect(dump(doc)).toEqual(['']);
    persistence.close();
    expect(dump(await reopen(name))).toEqual(['']);
  });

  it('saves edits as a log of ops, one op per typing burst', async () => {
    const name = freshName();
    const { doc, persistence } = await Persistence.open(name);
    const rows = new VisibleRows(doc);
    const ctx = { doc, rows };
    const id = rows.ids[0];
    for (const text of ['т', 'те', 'тек', 'текст']) doc.transact(() => cmd.setText(ctx, id, text));
    doc.transact(() => { cmd.split(ctx, id, 5); });
    await persistence.flush();
    persistence.close();
    // Four keystrokes coalesce into one setText; Enter at the end only inserts.
    expect(await logLength(name)).toBe(2);
    expect(dump(await reopen(name))).toEqual(['текст', '']);
  });

  it('folds the log into a snapshot on compaction', async () => {
    const name = freshName();
    const { doc, persistence } = await Persistence.open(name);
    const ctx = { doc, rows: new VisibleRows(doc) };
    doc.transact(() => cmd.setText(ctx, ctx.rows.ids[0], 'сжато'));
    await persistence.flush();
    await persistence.compact();
    persistence.close();
    expect(await logLength(name)).toBe(0);
    expect(dump(await reopen(name))).toEqual(['сжато']);
  });

  it('reloads exactly what was edited, whatever the interleaving of writes and compactions', { timeout: 30_000 }, async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const name = freshName();
      const { doc, persistence } = await Persistence.open(name);
      const rows = new VisibleRows(doc);
      const ctx = { doc, rows };
      const history = new History();

      for (let step = 0; step < 300; step++) {
        const roll = rand();
        if (roll < 0.1) history.undo(doc);
        else if (roll < 0.15) history.redo(doc);
        else {
          const id = pick(rows.ids);
          const n = doc.get(id);
          const action = pick([
            () => cmd.split(ctx, id, Math.floor(rand() * (n.text.length + 1))),
            () => cmd.mergeUp(ctx, id),
            () => cmd.deleteNode(ctx, id),
            () => cmd.indent(ctx, id),
            () => cmd.outdent(ctx, id),
            () => cmd.moveUp(ctx, id),
            () => cmd.moveDown(ctx, id),
            () => cmd.setCollapsed(ctx, id, !n.collapsed),
            () => cmd.setText(ctx, id, n.text + 'абв'[Math.floor(rand() * 3)]),
          ]);
          const ops = doc.transact(() => { action(); });
          history.record({ ops, before: null, after: null }, { typing: ops[0]?.t === 'setText' });
        }
        // Writes and compactions are deliberately not awaited, and editing
        // yields now and then, so compactions run while the log keeps growing.
        if (rand() < 0.2) void persistence.flush();
        if (rand() < 0.03) void persistence.compact();
        if (rand() < 0.1) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await persistence.compact();
      await persistence.flush();
      persistence.close();
      expect(dump(await reopen(name)), `seed ${seed}`).toEqual(dump(doc));
    }
  });
});

describe('snapshot versions', () => {
  it('keeps done and notes (v2) and still reads v1 snapshots', () => {
    const doc = build(['a', '  b']);
    doc.apply({ t: 'setDone', id: 'b', from: false, to: true });
    doc.apply({ t: 'setNote', id: 'a', from: '', to: 'заметка\nв две строки' });
    const copy = deserialize(serialize(doc));
    expect(copy.get('b').done).toBe(true);
    expect(copy.get('a').note).toBe('заметка\nв две строки');

    // v2 had no tasks: a completed bullet becomes a completed task.
    const v2 = JSON.stringify({ v: 2, root: 'root', rows: [['y', -1, 'a0', 'было сделано', 0, 1, 2, 1, '']] });
    expect(deserialize(v2).get('y')).toMatchObject({ todo: true, done: true });
    expect(deserialize(serialize(deserialize(v2))).get('y')).toMatchObject({ todo: true, done: true });

    const v1 = JSON.stringify({ v: 1, root: 'root', rows: [['x', -1, 'a0', 'старый', 0, 1, 2]] });
    expect(deserialize(v1).get('x')).toMatchObject({ text: 'старый', done: false, note: '', created: 1, updated: 2 });
  });
});
