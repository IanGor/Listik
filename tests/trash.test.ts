import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { TRASH, trashKey, trashTime } from '../src/model/doc';
import { History } from '../src/model/history';
import { checkInvariants } from '../src/model/invariants';
import { TextIndex } from '../src/model/search';
import { TagIndex } from '../src/model/tags';
import { TRASH_TTL, purgeTrash } from '../src/model/trash';
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
});
