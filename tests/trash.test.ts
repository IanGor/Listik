import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { TRASH, invert, trashKey, trashTime } from '../src/model/doc';
import { History } from '../src/model/history';
import { checkInvariants } from '../src/model/invariants';
import { TextIndex } from '../src/model/search';
import { TagIndex } from '../src/model/tags';
import { TRASH_TTL, deletedEntries, deletedFrom, deletedKey, purgeTrash, restoreDeleted } from '../src/model/trash';
import { deserialize, serialize } from '../src/persist/serialize';
import { dump, dumpRows, setup } from './helpers';

describe('trash', () => {
  it('deleting moves the subtree to the trash; undo brings it back where it was', () => {
    const { doc, ctx, rows, run } = setup(['a', 'b', '  c', 'd']);
    const history = new History();
    const ops = doc.transact(() => { cmd.deleteNode(ctx, 'b'); });
    history.record({ ops, before: null, after: null });
    expect(dump(doc)).toEqual(['a', 'd']);
    expect(dumpRows(rows, doc)).toEqual(['a', 'd']);
    expect(doc.get(TRASH).children).toEqual(['b']);
    expect(doc.get('c').parent).toBe('b');
    history.undo(doc);
    expect(dump(doc)).toEqual(['a', 'b', '  c', 'd']);
    expect(dumpRows(rows, doc)).toEqual(['a', 'b', '  c', 'd']);
    checkInvariants(doc);
    run(() => cmd.mergeUp(ctx, 'd'));
    expect(doc.get(TRASH).children).toEqual(['d']);
  });

  it('trash keys sort by time and round-trip it', () => {
    const t = Date.now();
    expect(trashTime(trashKey(t))).toBe(t);
    expect(trashKey(t) < trashKey(t + 1)).toBe(true);
    expect(trashKey(1) < trashKey(36 ** 8)).toBe(true);
  });

  it('search and tags do not see the trash, and see a restored bullet again', () => {
    const { doc, ctx, run } = setup(['a #x', 'b #x слово']);
    const tags = new TagIndex(doc);
    const text = new TextIndex(doc);
    const history = new History();
    const ops = doc.transact(() => { cmd.deleteNode(ctx, 'b #x слово'); });
    history.record({ ops, before: null, after: null });
    expect(tags.nodesWith('x').size).toBe(1);
    expect(text.find(['слово']).size).toBe(0);
    history.undo(doc);
    expect(tags.nodesWith('x').size).toBe(2);
    expect(text.find(['слово']).size).toBe(1);
    run(() => cmd.deleteNode(ctx, 'a #x'));
    expect(tags.nodesWith('x').size).toBe(1);
  });

  it('the snapshot carries the trash (v4), older versions load with an empty one', () => {
    const { doc, ctx, run } = setup(['a', 'b', '  c']);
    run(() => cmd.deleteNode(ctx, 'b'));
    const copy = deserialize(serialize(doc));
    checkInvariants(copy);
    expect(dump(copy)).toEqual(['a']);
    expect(copy.get(TRASH).children).toEqual(['b']);
    expect(copy.get('c').parent).toBe('b');
    const v3 = JSON.stringify({ v: 3, root: 'root', rows: [['x', -1, 'a0', 'старый', 0, 1, 2, 0, '', 0]] });
    expect(deserialize(v3).get(TRASH).children).toEqual([]);
  });

  it('compaction purges entries older than the TTL and keeps younger ones', () => {
    const { doc } = setup(['a', 'b', 'c']);
    const now = Date.now();
    const toTrash = (id: string, at: number) => {
      const n = doc.get(id);
      doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent: TRASH, order: trashKey(at) } });
    };
    toTrash('b', now - TRASH_TTL - 1000);
    toTrash('c', now - 1000);
    expect(purgeTrash(doc, now - TRASH_TTL)).toBe(1);
    expect(doc.has('b')).toBe(false);
    expect(doc.get(TRASH).children).toEqual(['c']);
    checkInvariants(doc);
  });

  it('a deleted bullet keeps where it was in its trash key, the time still first', () => {
    const key = deletedKey(1234, 'p-1_x', 'a0V');
    expect(trashTime(key)).toBe(1234);
    expect(deletedFrom(key)).toEqual({ parent: 'p-1_x', order: 'a0V' });
    expect(deletedFrom(trashKey(1234))).toBeNull();
    expect(deletedKey(1, 'z', 'zz') < deletedKey(2, 'a', 'a')).toBe(true);
  });

  it('lists what was deleted, newest first, without empty lines and undone creations', () => {
    const { doc, ctx, rows, run } = setup(['a', 'b', '  c', 'd', '']);
    run(() => cmd.deleteNode(ctx, 'b'));
    run(() => cmd.deleteNode(ctx, ''));
    const made = doc.transact(() => { cmd.split(ctx, 'd', 1); });
    run(() => [...made].reverse().forEach((op) => doc.apply(invert(op))));
    run(() => cmd.deleteNode(ctx, 'a'));
    expect(deletedEntries(doc).map((e) => e.id)).toEqual(['a', 'b']);
    expect(deletedEntries(doc)[1].from).toEqual({ parent: 'root', order: expect.any(String) });
    expect(rows.ids).toEqual(['d']);
  });

  it('"Вернуть" puts a block back between the same neighbours, one undoable move; a gone place sends it to the end', () => {
    const { doc, ctx, run } = setup(['a', '  b', '    c', '  d', 'e']);
    run(() => cmd.deleteNode(ctx, 'b'));
    const ops = doc.transact(() => { expect(restoreDeleted(ctx, 'b')).toEqual({ home: true }); });
    expect(ops).toHaveLength(1);
    expect(dump(doc)).toEqual(['a', '  b', '    c', '  d', 'e']);
    run(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(dump(doc)).toEqual(['a', '  d', 'e']);
    // Its place went too: back at the end of the top level, and the place's own entry stays.
    run(() => cmd.deleteNode(ctx, 'a'));
    expect(run(() => restoreDeleted(ctx, 'b'))).toEqual({ home: false });
    expect(dump(doc)).toEqual(['e', 'b', '  c']);
    expect(deletedEntries(doc).map((e) => e.id)).toEqual(['a']);
    expect(run(() => restoreDeleted(ctx, 'e'))).toBeNull();
    checkInvariants(doc);
    const copy = deserialize(serialize(doc));
    expect(deletedFrom(copy.get('a').order)).toEqual({ parent: 'root', order: expect.any(String) });
  });

  it('a copy brought back is a copy again, whichever one went', () => {
    const { doc, ctx, run } = setup(['a', '  b', 'm']);
    run(() => doc.apply({ t: 'setMirror', id: 'm', from: null, to: 'a' }));
    run(() => cmd.deleteNode(ctx, 'a'));
    expect(doc.get('m').mirrorOf).toBeNull();
    run(() => restoreDeleted(ctx, 'a'));
    expect(doc.copies('m').sort()).toEqual(['a', 'm']);
    expect(doc.content('a').text).toBe('a');
    // "m" now holds it all (its own text the copies' text), "a" mirrors it.
    expect(dump(doc)).toEqual(['a', 'a', '  b']);
    expect(doc.get('a').mirrorOf).toBe('m');
    checkInvariants(doc);
  });
});
