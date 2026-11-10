import { describe, expect, it } from 'vitest';
import { Favorites, toggleFavorite } from '../src/model/favorites';
import { History } from '../src/model/history';
import { applyMerged } from '../src/model/merge';
import { deleteNode, setText } from '../src/model/commands';
import { replay } from '../src/persist/compact';
import { deserialize, serialize } from '../src/persist/serialize';
import { toMarkdown } from '../src/model/outline-text';
import { checkInvariants } from '../src/model/invariants';
import { setup } from './helpers';

describe('node favorites', () => {
  it('preserves bookmarks through rename, move, undo/redo and snapshot round-trip without adding text markers', () => {
    const { doc, ctx, run } = setup(['A', '  B', 'C']);
    const favorites = new Favorites(doc), history = new History();
    const ops = doc.transact(() => toggleFavorite(doc, 'B'));
    history.record({ ops, before: null, after: null });
    expect(favorites.list()).toEqual(['B']);
    run(() => setText(ctx, 'B', 'Renamed'));
    run(() => {
      const n = doc.get('B');
      doc.apply({ t: 'move', id: 'B', from: { parent: n.parent!, order: n.order }, to: { parent: 'C', order: doc.orderAt('C', 0) } });
    });
    expect(favorites.list()).toEqual(['B']);
    history.undo(doc);
    expect(favorites.list()).toEqual([]);
    history.redo(doc);
    expect(favorites.list()).toEqual(['B']);
    const copy = deserialize(serialize(doc));
    expect(new Favorites(copy).list()).toEqual(['B']);
    expect(toMarkdown(doc)).not.toContain('★');
    expect(toMarkdown(doc)).toContain('Renamed');
    checkInvariants(copy);
  });

  it('keeps hidden trash stars and restores them on undo; hard removal leaves no dangling entries', () => {
    const { doc, ctx, run } = setup(['A', 'B']);
    const favorites = new Favorites(doc);
    run(() => toggleFavorite(doc, 'A'));
    const history = new History();
    const ops = doc.transact(() => deleteNode(ctx, 'A'));
    history.record({ ops, before: null, after: null });
    expect(favorites.list()).toEqual([]);
    expect(doc.get('A').favorite).toBe(true);
    expect(new Favorites(deserialize(serialize(doc))).list()).toEqual([]);
    history.undo(doc);
    expect(favorites.list()).toEqual(['A']);
    run(() => doc.apply({ t: 'remove', parent: doc.root, node: doc.snapshot('A') }));
    expect(favorites.list()).toEqual([]);
  });

  it('stars the original and transfers its bookmark to the heir when the original is deleted', () => {
    const { doc, ctx, run } = setup(['A', '  child', 'Copy']);
    run(() => doc.apply({ t: 'setMirror', id: 'Copy', from: null, to: 'A' }));
    const favorites = new Favorites(doc), history = new History();
    run(() => toggleFavorite(doc, 'Copy'));
    expect(favorites.list()).toEqual(['A']);
    const ops = doc.transact(() => deleteNode(ctx, 'A'));
    history.record({ ops, before: null, after: null });
    expect(favorites.list()).toEqual(['Copy']);
    expect(doc.get('Copy').children).toEqual(['child']);
    history.undo(doc);
    expect(favorites.list()).toEqual(['A']);
    history.redo(doc);
    expect(favorites.list()).toEqual(['Copy']);
    checkInvariants(doc);
  });

  it('merges a late bookmark edit onto the surviving original after mirror handover', () => {
    const { doc, ctx, run } = setup(['A', 'Copy']);
    run(() => doc.apply({ t: 'setMirror', id: 'Copy', from: null, to: 'A' }));
    const favorites = new Favorites(doc);
    run(() => deleteNode(ctx, 'A'));
    run(() => applyMerged(doc, { t: 'setFavorite', id: 'A', from: false, to: true }));
    expect(favorites.list()).toEqual(['Copy']);
    run(() => applyMerged(doc, { t: 'setFavorite', id: 'A', from: true, to: false }));
    expect(favorites.list()).toEqual([]);
  });

  it('handles old snapshots, operation replay and rollback without losing or inventing bookmarks', () => {
    const { doc, run } = setup(['A']);
    const old = JSON.parse(serialize(doc));
    old.v = 8;
    const copy = deserialize(JSON.stringify(old));
    expect(copy.get('A').favorite).toBeUndefined();
    const favorites = new Favorites(copy);
    replay(copy, [{ t: 'setFavorite', id: 'A', from: false, to: true }]);
    expect(favorites.list()).toEqual(['A']);
    expect(() => copy.transact(() => { toggleFavorite(copy, 'A'); throw new Error('abort'); })).toThrow('abort');
    expect(favorites.list()).toEqual(['A']);
    run(() => toggleFavorite(doc, doc.root));
    expect(doc.get(doc.root).favorite).toBeUndefined();
  });

  it('has no count cap and does not rebuild its list during ordinary typing', () => {
    const { doc, ctx, run } = setup(Array.from({ length: 80 }, (_, i) => `Node ${i}`));
    const favorites = new Favorites(doc);
    run(() => { for (const id of doc.get(doc.root).children) toggleFavorite(doc, id); });
    expect(favorites.list()).toHaveLength(80);
    const list = favorites.list(), version = favorites.version;
    run(() => setText(ctx, 'Node 0', 'Edited'));
    expect(favorites.version).toBe(version);
    expect(favorites.list()).toBe(list);
    expect(new Favorites(deserialize(serialize(doc))).list()).toHaveLength(80);
  });
});
