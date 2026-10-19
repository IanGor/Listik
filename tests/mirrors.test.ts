import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { tokenBefore } from '../src/model/complete';
import { TRASH, invert } from '../src/model/doc';
import { History } from '../src/model/history';
import { checkInvariants } from '../src/model/invariants';
import { applyMerged } from '../src/model/merge';
import { closesMirror, isMirror, mirrorBefore, opensMirror } from '../src/model/mirrors';
import { toMarkdown } from '../src/model/outline-text';
import { TextIndex } from '../src/model/search';
import { TagIndex } from '../src/model/tags';
import { deserialize, serialize } from '../src/persist/serialize';
import { dump, dumpRows, setup } from './helpers';

describe('(( token and pair', () => {
  it('finds the mirror token the caret is in, through its closing brackets', () => {
    expect(mirrorBefore('(())', 2)).toEqual({ start: 0, end: 4, query: '' });
    expect(mirrorBefore('см. ((Пье)) и', 9)).toEqual({ start: 4, end: 11, query: 'Пье' });
    expect(mirrorBefore('((Пье', 5)).toEqual({ start: 0, end: 5, query: 'Пье' });
    expect(mirrorBefore('(a', 2)).toBeNull();
    expect(mirrorBefore('((a)) b', 7)).toBeNull();
    expect(tokenBefore('((#сал', 6)).toEqual({ kind: '((', start: 0, end: 6, query: '#сал' });
    expect(tokenBefore('[[a', 3)?.kind).toBe('[[');
  });

  it('opens once and steps over its closing brackets', () => {
    expect(opensMirror('((', 2)).toBe(true);
    expect(opensMirror('(((', 3)).toBe(false);
    expect(opensMirror('(())', 2)).toBe(false);
    expect(closesMirror('((a))', 3)).toBe(true);
    expect(closesMirror('((a))', 4)).toBe(true);
    expect(closesMirror('f(a)', 3)).toBe(false);
  });
});

describe('mirrors', () => {
  it('an empty bullet with ((title)) becomes a mirror; its text, note and task state are the original’s', () => {
    const { doc, ctx, rows, run } = setup(['Пьер', 'Наташа', '']);
    run(() => cmd.setText(ctx, '', '((Пьер))'));
    const m = rows.ids[2];
    run(() => cmd.makeMirror(ctx, m, 'Пьер', 0, 8));
    expect(doc.get(m).mirrorOf).toBe('Пьер');
    expect(doc.get(m).text).toBe('');
    expect(doc.content(m).text).toBe('Пьер');
    expect(isMirror(doc, m)).toBe(true);
    // Typing in the mirror changes the original, and so what the mirror shows.
    run(() => cmd.setText(ctx, m, 'Пьер Безухов'));
    expect(doc.get('Пьер').text).toBe('Пьер Безухов');
    expect(doc.content(m).text).toBe('Пьер Безухов');
    run(() => cmd.setNote(ctx, m, 'заметка'));
    expect(doc.get('Пьер').note).toBe('заметка');
    run(() => cmd.cycleTask(ctx, [m]));
    expect(doc.get('Пьер').todo).toBe(true);
    run(() => cmd.toggleDone(ctx, [m]));
    expect(doc.get('Пьер').done).toBe(true);
    expect(doc.content(m).done).toBe(true);
    run(() => cmd.untask(ctx, ['Пьер']));
    expect(doc.content(m).todo).toBe(false);
    checkInvariants(doc);
  });

  it('with other text in the bullet, the mirror goes in below it and the token leaves the text', () => {
    const { doc, ctx, rows, run } = setup(['Пьер', 'см. ((Пьер)) тут']);
    const id = 'см. ((Пьер)) тут';
    const focus = run(() => cmd.makeMirror(ctx, id, 'Пьер', 4, 12));
    expect(doc.get(id).text).toBe('см.  тут');
    expect(doc.get(id).mirrorOf).toBeNull();
    const m = rows.ids[2];
    expect(focus).toEqual({ id: m, caret: 4 });
    expect(doc.get(m).mirrorOf).toBe('Пьер');
    expect(dumpRows(rows, doc)).toEqual(['Пьер', 'см.  тут', '']);
  });

  it('a mirror of a mirror points at the original; a bullet never mirrors itself', () => {
    const { doc, ctx, run } = setup(['a', 'm1', 'm2']);
    const m1 = 'm1';
    const m2 = 'm2';
    run(() => cmd.makeMirror(ctx, m1, 'a', 0, 2));
    run(() => cmd.makeMirror(ctx, m2, m1, 0, 2));
    expect(doc.get(m2).mirrorOf).toBe('a');
    expect(doc.origin(m2)).toBe('a');
    expect(run(() => cmd.makeMirror(ctx, 'a', m1, 0, 0))).toBeUndefined();
    expect(doc.get('a').mirrorOf).toBeNull();
    expect(() => doc.apply({ t: 'setMirror', id: 'a', from: null, to: 'a' })).toThrow();
  });

  it('never holds children: Tab under it, moves into it and drops into it are refused; Enter makes a sibling', () => {
    const { doc, ctx, rows, run } = setup(['a', '', 'c', 'd']);
    const m = rows.ids[1];
    run(() => cmd.makeMirror(ctx, m, 'a', 0, 0));
    run(() => cmd.indent(ctx, 'c'));
    expect(doc.get('c').parent).toBe('root');
    run(() => cmd.moveManyTo(ctx, ['d'], m, null));
    expect(doc.get('d').parent).toBe('root');
    run(() => cmd.indent(ctx, 'd'));
    run(() => cmd.moveUp(ctx, 'd')); // first child of c: would go to the end of the mirror above
    expect(doc.get('d').parent).toBe('c');
    const f = run(() => cmd.split(ctx, m, 1));
    expect(doc.get('a').text).toBe('a');
    expect(doc.get(f.id).parent).toBe('root');
    expect(doc.get(f.id).mirrorOf).toBeNull();
    expect(dumpRows(rows, doc)).toEqual(['a', '', '', 'c', '  d']);
    checkInvariants(doc);
  });

  it('Backspace at the start: a mirror that reads empty goes, one with text stays; nothing merges into a mirror', () => {
    const { doc, ctx, rows, run } = setup(['a', '', 'c']);
    const m = rows.ids[1];
    run(() => cmd.makeMirror(ctx, m, 'a', 0, 0));
    expect(run(() => cmd.mergeUp(ctx, m))).toBeUndefined();
    expect(run(() => cmd.mergeUp(ctx, 'c'))).toBeUndefined();
    expect(doc.get('c').text).toBe('c');
    run(() => cmd.setText(ctx, 'a', ''));
    expect(run(() => cmd.mergeUp(ctx, m))).toEqual({ id: 'a', caret: 0 });
    expect(doc.get(m).parent).toBe(TRASH);
  });

  it('deleting the original keeps the mirror readable; the indexes see the original only', () => {
    const { doc, ctx, rows, run } = setup(['Пьер #x', '']);
    const m = rows.ids[1];
    run(() => cmd.makeMirror(ctx, m, 'Пьер #x', 0, 0));
    const tags = new TagIndex(doc);
    const text = new TextIndex(doc);
    expect(tags.nodesWith('x').size).toBe(1);
    expect(text.find(['пьер']).size).toBe(1);
    run(() => cmd.deleteNode(ctx, 'Пьер #x'));
    expect(doc.content(m).text).toBe('Пьер #x');
    expect(isMirror(doc, m)).toBe(true);
    doc.apply({ t: 'remove', parent: TRASH, node: doc.snapshot('Пьер #x') });
    expect(isMirror(doc, m)).toBe(false);
    expect(doc.content(m).id).toBe(m);
  });

  it('undo goes through the merge layer; setMirror merges and inverts', () => {
    const { doc, ctx, rows } = setup(['a', '']);
    const m = rows.ids[1];
    const history = new History();
    const ops = doc.transact(() => { cmd.makeMirror(ctx, m, 'a', 0, 0); });
    history.record({ ops, before: null, after: null });
    history.undo(doc);
    expect(doc.get(m).mirrorOf).toBeNull();
    history.redo(doc);
    expect(doc.get(m).mirrorOf).toBe('a');
    expect(invert({ t: 'setMirror', id: m, from: null, to: 'a' })).toEqual({ t: 'setMirror', id: m, from: 'a', to: null });
    expect(applyMerged(doc, { t: 'setMirror', id: m, from: null, to: 'a' })).toEqual([]);
    expect(applyMerged(doc, { t: 'setMirror', id: m, from: 'x', to: null })).toHaveLength(1);
    expect(doc.get(m).mirrorOf).toBeNull();
  });

  it('the snapshot (v5) keeps mirrors; exports read a mirror as a copy of its original', () => {
    const { doc, ctx, rows, run } = setup(['a', '  b', '']);
    const m = rows.ids[2];
    run(() => cmd.makeMirror(ctx, m, 'a', 0, 0));
    const copy = deserialize(serialize(doc));
    checkInvariants(copy);
    expect(copy.get(m).mirrorOf).toBe('a');
    expect(copy.content(m).text).toBe('a');
    const v4 = JSON.stringify({ v: 4, root: 'root', rows: [['x', -1, 'a0', 'старый', 0, 1, 2, 0, '', 0]] });
    expect(deserialize(v4).get('x').mirrorOf).toBeNull();
    expect(toMarkdown(doc)).toBe('- a\n  - b\n- a\n');
    expect(dump(doc)).toEqual(['a', '  b', '']);
  });
});
