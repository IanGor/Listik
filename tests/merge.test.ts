import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { TRASH, invert, trashKey } from '../src/model/doc';
import { History } from '../src/model/history';
import { checkInvariants } from '../src/model/invariants';
import { CONFLICT, applyMerged } from '../src/model/merge';
import { merge3 } from '../src/model/merge-text';
import { VisibleRows } from '../src/model/rows';
import { TagIndex } from '../src/model/tags';
import type { Op } from '../src/model/types';
import { build, dump, setup } from './helpers';

describe('merge3', () => {
  it('keeps both sides when they touch different words', () => {
    expect(merge3('один два три', 'ОДИН два три', 'один два ТРИ')).toBe('ОДИН два ТРИ');
    expect(merge3('abc', 'Xabc', 'abcY')).toBe('XabcY');
    expect(merge3('a b c', 'b c', 'a b c d')).toBe('b c d');
  });

  it('is trivial when one side did nothing or both did the same', () => {
    expect(merge3('x', 'x', 'y')).toBe('y');
    expect(merge3('x', 'y', 'x')).toBe('y');
    expect(merge3('x', 'y', 'y')).toBe('y');
  });

  it('reports a collision when the same words changed, or both inserted at one point', () => {
    expect(merge3('один два', 'ОДИН два', 'Один два')).toBeNull();
    expect(merge3('ab', 'aXb', 'aYb')).toBeNull();
    expect(merge3('abc', 'c', 'abcd')).toBe('cd');
  });
});

describe('applyMerged', () => {
  it('moving and editing the same bullet on two devices both apply', () => {
    const { doc, ctx, run } = setup(['a', 'b', 'c']);
    // Device 1 edits "b" (authored against the same base).
    const edit: Op = { t: 'setText', id: 'b', from: 'b', to: 'b edited', at: 5 };
    // Here, meanwhile, "b" was indented under "a".
    run(() => cmd.indent(ctx, 'b'));
    applyMerged(doc, edit);
    expect(dump(doc)).toEqual(['a', '  b edited', 'c']);
    checkInvariants(doc);
  });

  it('merges concurrent edits of the same text three ways', () => {
    const { doc } = setup(['один два три']);
    const id = 'один два три';
    doc.apply({ t: 'setText', id, from: id, to: 'один два ТРИ', at: 10 });
    applyMerged(doc, { t: 'setText', id, from: id, to: 'ОДИН два три', at: 11 });
    expect(doc.get(id).text).toBe('ОДИН два ТРИ');
    expect(doc.get(id).note).toBe('');
  });

  it('on a collision the later edit wins and the other version is kept in the note', () => {
    const { doc } = setup(['слово']);
    doc.apply({ t: 'setText', id: 'слово', from: 'слово', to: 'наше', at: 20 });
    applyMerged(doc, { t: 'setText', id: 'слово', from: 'слово', to: 'их старое', at: 10 });
    expect(doc.get('слово').text).toBe('наше');
    expect(doc.get('слово').note).toBe(`${CONFLICT}: их старое`);
    applyMerged(doc, { t: 'setText', id: 'слово', from: 'слово', to: 'их новое', at: 30 });
    expect(doc.get('слово').text).toBe('их новое');
    expect(doc.get('слово').note).toBe(`${CONFLICT}: их старое\n${CONFLICT}: наше`);
  });

  it('an op about a bullet in the trash lands there; one about a purged bullet is dropped', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    run(() => cmd.deleteNode(ctx, 'b'));
    expect(dump(doc)).toEqual(['a']);
    applyMerged(doc, { t: 'setText', id: 'b', from: 'b', to: 'b late', at: 1 });
    expect(doc.get('b').text).toBe('b late');
    expect(doc.get('b').parent).toBe(TRASH);
    doc.apply({ t: 'remove', parent: TRASH, node: doc.snapshot('b') });
    expect(applyMerged(doc, { t: 'setText', id: 'b', from: 'b late', to: 'gone', at: 2 })).toEqual([]);
    checkInvariants(doc);
  });

  it('inserts under a missing parent go to the trash; existing bullets are moved, not duplicated', () => {
    const { doc } = setup(['a']);
    applyMerged(doc, { t: 'insert', parent: 'nowhere', node: { id: 'x', order: 'a0', text: 'x', note: '', collapsed: false, todo: false, done: false, created: 1, updated: 1, children: [] } });
    expect(doc.get('x').parent).toBe(TRASH);
    applyMerged(doc, { t: 'insert', parent: 'a', node: { id: 'x', order: 'a0', text: 'ignored', note: '', collapsed: false, todo: false, done: false, created: 1, updated: 1, children: [] } });
    expect(dump(doc)).toEqual(['a', '  x']);
    expect(doc.get('x').text).toBe('x');
    checkInvariants(doc);
  });

  it('a move that would make a cycle is skipped; a move of a bullet already elsewhere still wins', () => {
    const { doc, ctx, run } = setup(['a', '  b', 'c']);
    // Another device put "a" under "b" while "b" is under "a" here.
    expect(applyMerged(doc, { t: 'move', id: 'a', from: { parent: 'root', order: doc.get('a').order }, to: { parent: 'b', order: 'a0' } })).toEqual([]);
    run(() => cmd.outdent(ctx, 'b'));
    expect(dump(doc)).toEqual(['a', 'b', 'c']);
    applyMerged(doc, { t: 'move', id: 'b', from: { parent: 'a', order: 'x' }, to: { parent: 'c', order: 'a0' } });
    expect(dump(doc)).toEqual(['a', 'c', '  b']);
    checkInvariants(doc);
  });

  it('a remote removal moves the bullet to the trash instead of destroying it', () => {
    const { doc } = setup(['a', 'b']);
    applyMerged(doc, { t: 'remove', parent: 'root', node: doc.snapshot('b') });
    expect(dump(doc)).toEqual(['a']);
    expect(doc.get('b').parent).toBe(TRASH);
  });

  it('the folded state and task flags follow the op only where they differ', () => {
    const { doc } = setup(['a', '  b']);
    expect(applyMerged(doc, { t: 'setTodo', id: 'a', from: false, to: true })).toHaveLength(1);
    expect(applyMerged(doc, { t: 'setTodo', id: 'a', from: false, to: true })).toEqual([]);
    expect(applyMerged(doc, { t: 'setCollapsed', id: 'a', from: false, to: true })).toHaveLength(1);
    expect(doc.get('a').collapsed).toBe(true);
  });
});

describe('concurrent inserts', () => {
  it('siblings may share an order key, sorted by id, and new keys go after the run', () => {
    const { doc } = setup(['a', 'b']);
    const order = doc.orderAt('root', 1);
    const node = (id: string) => ({ id, order, text: id, note: '', collapsed: false, todo: false, done: false, created: 0, updated: 0, children: [] });
    doc.apply({ t: 'insert', parent: 'root', node: node('y') });
    doc.apply({ t: 'insert', parent: 'root', node: node('x') });
    expect(dump(doc)).toEqual(['a', 'x', 'y', 'b']);
    checkInvariants(doc);
    const between = doc.orderAt('root', 2);
    expect(between > order && between < doc.get('b').order).toBe(true);
    const ctx = { doc, rows: new VisibleRows(doc) };
    doc.transact(() => { cmd.split(ctx, 'x', 1); });
    checkInvariants(doc);
    expect(dump(doc)).toEqual(['a', 'x', 'y', '', 'b']);
  });
});

describe('undo through the merge layer', () => {
  it('undoes a typed word even after another device changed other words', () => {
    const { doc, ctx } = setup(['один два три']);
    const history = new History();
    const id = 'один два три';
    const ops = doc.transact(() => cmd.setText(ctx, id, 'ОДИН два три'));
    history.record({ ops, before: null, after: null }, { typing: true });
    applyMerged(doc, { t: 'setText', id, from: id, to: 'один два ТРИ', at: 99 });
    expect(doc.get(id).text).toBe('ОДИН два ТРИ');
    history.undo(doc);
    expect(doc.get(id).text).toBe('один два ТРИ');
    history.redo(doc);
    expect(doc.get(id).text).toBe('ОДИН два ТРИ');
  });

  it('undoing a creation puts the bullet in the trash, and the tag index forgets it', () => {
    const doc = build(['a #x']);
    const tags = new TagIndex(doc);
    const op = invert({ t: 'insert', parent: 'root', node: doc.snapshot('a #x') });
    expect(op).toMatchObject({ t: 'move', to: { parent: TRASH, order: trashKey(0) } });
    doc.apply(op);
    expect(dump(doc)).toEqual([]);
    expect(tags.nodesWith('x').size).toBe(0);
    doc.apply(invert(op));
    expect(dump(doc)).toEqual(['a #x']);
    expect(tags.nodesWith('x').size).toBe(1);
  });
});
