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
import { VisibleRows, nodeOf } from '../src/model/rows';
import type { Focus, NodeId, Op } from '../src/model/types';
import { dump, dumpRows, rng, setup, viewRows } from './helpers';

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
  it('an empty bullet with ((title)) becomes a copy: both show a diamond, either one edits the text, note and task of both', () => {
    const { doc, ctx, rows, run } = setup(['Пьер', 'Наташа', '']);
    run(() => cmd.setText(ctx, '', '((Пьер))'));
    const m = rows.ids[2];
    expect(doc.isCopy('Пьер')).toBe(false);
    run(() => cmd.makeMirror(ctx, m, 'Пьер', 0, 8));
    expect(doc.get(m).mirrorOf).toBe('Пьер');
    expect(doc.get(m).text).toBe('');
    expect(doc.content(m).text).toBe('Пьер');
    expect(isMirror(doc, m)).toBe(true);
    expect(doc.isCopy('Пьер')).toBe(true);
    expect(doc.isCopy(m)).toBe(true);
    expect(doc.isCopy('Наташа')).toBe(false);
    expect(doc.copies(m).sort()).toEqual([m, 'Пьер'].sort());
    run(() => cmd.setText(ctx, m, 'Пьер Безухов'));
    expect(doc.get('Пьер').text).toBe('Пьер Безухов');
    run(() => cmd.setNote(ctx, m, 'заметка'));
    expect(doc.get('Пьер').note).toBe('заметка');
    const f = run(() => cmd.split(ctx, m, 4));
    expect(doc.content(m).text).toBe('Пьер');
    expect(doc.get(f.id).text).toBe(' Безухов');
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

  it('takes children for its original: Tab under it, moves and drops into it go there; Enter at its end makes a sibling while it is folded', () => {
    const { doc, ctx, rows, run } = mirrored(['a', 'm', 'c', 'd'], { m: 'a' });
    const m = 'm';
    expect(run(() => cmd.indent(ctx, 'c'))).toBe(`${m}/c`);
    expect(doc.get('c').parent).toBe('a');
    expect(viewRows(rows, doc)).toEqual(['a', '  c', '◇ a', '  c', 'd']);
    run(() => cmd.moveManyTo(ctx, ['d'], m, null));
    expect(doc.get('a').children).toEqual(['d', 'c']);
    run(() => cmd.setCollapsed(ctx, m, true));
    expect(doc.get(m).collapsed).toBe(true);
    expect(doc.get('a').collapsed).toBe(false);
    const f = run(() => cmd.split(ctx, m, 1));
    expect(doc.get('a').text).toBe('a');
    expect(doc.get(f.id).parent).toBe('root');
    expect(doc.get(f.id).mirrorOf).toBeNull();
    expect(viewRows(rows, doc)).toEqual(['a', '  d', '  c', '◇ a [+]', '']);
    checkInvariants(doc);
  });

  it('Backspace at the start of either copy takes out that copy alone; the other keeps the text, note and bullets', () => {
    const { doc, ctx, rows, run } = mirrored(['a', '  b', 'm', 'c'], { m: 'a' });
    run(() => cmd.setNote(ctx, 'a', 'заметка'));
    run(() => cmd.setCollapsed(ctx, 'm', true));
    // Text joins a copy above as it joins any bullet: every copy shows it.
    expect(run(() => cmd.mergeUp(ctx, 'c'))).toEqual({ id: 'm', caret: 1 });
    expect(doc.get('a').text).toBe('ac');
    expect(run(() => cmd.mergeUp(ctx, 'm'))).toEqual({ id: 'b', caret: 1 });
    expect(doc.get('m').parent).toBe(TRASH);
    expect(dump(doc)).toEqual(['ac', '  b']);
    expect(doc.get('a').note).toBe('заметка');
    expect(rows.ids).toEqual(['a', 'b']);
    expect(doc.isCopy('a')).toBe(false);

    const two = mirrored(['x', 'a', '  b', 'm'], { m: 'a' });
    expect(two.run(() => cmd.mergeUp(two.ctx, 'a'))).toEqual({ id: 'x', caret: 1 });
    expect(dump(two.doc)).toEqual(['x', 'a', '  b']);
    expect(two.doc.get('m').mirrorOf).toBeNull();
    expect(two.rows.ids).toEqual(['x', 'm', 'b']);
    checkInvariants(two.doc);
  });

  it('deleting a mirror, or a selection that holds it with what it shows, leaves the original whole', () => {
    const one = mirrored(['a', '  b', 'm', 'c'], { m: 'a' });
    one.run(() => cmd.deleteNode(one.ctx, 'm'));
    expect(dump(one.doc)).toEqual(['a', '  b', 'c']);
    const two = mirrored(['a', '  b', 'm', 'c'], { m: 'a' });
    two.run(() => cmd.deleteMany(two.ctx, ['m', 'm/b']));
    expect(dump(two.doc)).toEqual(['a', '  b', 'c']);
    // Below the heading, adding and deleting is the original's.
    const three = mirrored(['a', '  b', 'm'], { m: 'a' });
    three.run(() => cmd.deleteNode(three.ctx, 'm/b'));
    expect(dump(three.doc)).toEqual(['a', 'm']);
  });

  it('deleting the copy that holds it all hands everything to the first other copy; copies stay copies; undo puts it back', () => {
    const { doc, ctx, rows, run } = mirrored(['m1', 'a #x', '  b', '  c', 'm2'], { m1: 'a #x', m2: 'a #x' });
    run(() => cmd.setNote(ctx, 'a #x', 'заметка'));
    run(() => cmd.cycleTask(ctx, ['a #x']));
    const tags = new TagIndex(doc);
    const text = new TextIndex(doc);
    const before = dump(doc);
    const ops = doc.transact(() => { cmd.deleteNode(ctx, 'a #x'); });
    expect(doc.get('m1').mirrorOf).toBeNull();
    expect(doc.get('m1').text).toBe('a #x');
    expect(doc.get('m1').note).toBe('заметка');
    expect(doc.get('m1').todo).toBe(true);
    expect(doc.get('m1').children).toEqual(['b', 'c']);
    expect(doc.get('m2').mirrorOf).toBe('m1');
    expect(doc.isCopy('m1') && doc.isCopy('m2')).toBe(true);
    expect(viewRows(rows, doc)).toEqual(['a #x', '  b', '  c', '◇ a #x', '  b', '  c']);
    expect(tags.nodesWith('x')).toEqual(new Set(['m1']));
    expect(text.find(['заметка']).size).toBe(1);
    checkInvariants(doc);
    run(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(dump(doc)).toEqual(before);
    expect(doc.get('m1').mirrorOf).toBe('a #x');
    expect(doc.get('m2').mirrorOf).toBe('a #x');
    // Of two copies, the one left is a plain bullet.
    run(() => cmd.deleteNode(ctx, 'm1'));
    run(() => cmd.deleteNode(ctx, 'm2'));
    expect(doc.isCopy('a #x')).toBe(false);
    expect(rows.ids).toEqual(['a #x', 'b', 'c']);
  });

  it('a mirror whose original went without handing over (an older document) reads it until the trash is purged', () => {
    const { doc, run } = mirrored(['a', 'm'], { m: 'a' });
    const n = doc.get('a');
    run(() => doc.apply({ t: 'move', id: 'a', from: { parent: n.parent!, order: n.order }, to: { parent: TRASH, order: '0' } }));
    expect(doc.content('m').text).toBe('a');
    expect(isMirror(doc, 'm')).toBe(true);
    expect(doc.isCopy('m')).toBe(false);
    doc.apply({ t: 'remove', parent: TRASH, node: doc.snapshot('a') });
    expect(isMirror(doc, 'm')).toBe(false);
    expect(doc.content('m').id).toBe('m');
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

/** `setup` with some bullets made mirrors: { mirror: original }. */
function mirrored(lines: string[], mirrors: Record<string, string>) {
  const s = setup(lines);
  s.run(() => {
    for (const [m, target] of Object.entries(mirrors)) s.doc.apply({ t: 'setMirror', id: m, from: null, to: target });
  });
  return s;
}

describe('a mirror shows the subtree of its original', () => {
  it('lists the original\'s children under the mirror, all the way down, keyed by the mirror row', () => {
    const { doc, rows } = mirrored(['a', '  b', '    c', '  d', 'm'], { m: 'a' });
    expect(rows.ids).toEqual(['a', 'b', 'c', 'd', 'm', 'm/b', 'm/c', 'm/d']);
    expect(viewRows(rows, doc)).toEqual(['a', '  b', '    c', '  d', '◇ a', '  b', '    c', '  d']);
    expect(rows.parentKey('m/c')).toBe('m/b');
    expect(rows.parentKey('m/b')).toBe('m');
    expect(rows.parentKey('m')).toBeNull();
    expect(rows.showsChildren('m')).toBe(true);
    expect(nodeOf('m/c')).toBe('c');
  });

  it('edits in the original show under the mirror, and edits under the mirror change the original', () => {
    const { doc, ctx, rows, run } = mirrored(['a', '  b', 'm'], { m: 'a' });
    const f = run(() => cmd.split(ctx, 'm/b', 1));
    // The new bullet is the original's; its row is found next to where the caret was.
    expect(doc.get(f.id).parent).toBe('a');
    expect(rows.locate(f.id, 'm/b')).toBe(`m/${f.id}`);
    expect(rows.locate(f.id, 'b')).toBe(f.id);
    run(() => cmd.setText(ctx, `m/${f.id}`, 'e'));
    expect(viewRows(rows, doc)).toEqual(['a', '  b', '  e', '◇ a', '  b', '  e']);
    run(() => cmd.deleteNode(ctx, 'b'));
    expect(viewRows(rows, doc)).toEqual(['a', '  e', '◇ a', '  e']);
    expect(rows.ids).toEqual(['a', f.id, 'm', `m/${f.id}`]);
  });

  it('Enter at the end of an open mirror makes the first child of the original, in the mirror', () => {
    const { doc, ctx, rows, run } = mirrored(['a', '  b', 'm'], { m: 'a' });
    const f = run(() => cmd.split(ctx, 'm', 1));
    expect(doc.get('a').children[0]).toBe(f.id);
    expect(rows.locate(f.id, 'm')).toBe(`m/${f.id}`);
  });

  it('Shift+Tab right under a mirror puts the bullet after the mirror; ↑ past the top goes into the bullet above the mirror', () => {
    const { doc, ctx, rows, run } = mirrored(['a', '  b', '  c', 'w', 'm'], { m: 'a' });
    expect(run(() => cmd.outdent(ctx, 'm/c'))).toBe('c');
    expect(doc.get('root').children).toEqual(['a', 'w', 'm', 'c']);
    expect(run(() => cmd.moveUp(ctx, 'm/b'))).toBe('b');
    expect(doc.get('b').parent).toBe('w');
    expect(viewRows(rows, doc)).toEqual(['a', 'w', '  b', '◇ a', 'c']);
    checkInvariants(doc);
  });

  it('each copy folds on its own, and so does every bullet shown under it', () => {
    const { doc, ctx, rows, run } = mirrored(['a', '  b', '    c', 'm'], { m: 'a' });
    run(() => cmd.setCollapsed(ctx, 'm', true));
    expect(rows.ids).toEqual(['a', 'b', 'c', 'm']);
    expect(rows.hasHiddenChildren('m')).toBe(true);
    run(() => cmd.setCollapsed(ctx, 'm', false));
    // Where the bullet lives: the mirror keeps showing it as it did.
    run(() => cmd.setCollapsed(ctx, 'b', true));
    expect(rows.ids).toEqual(['a', 'b', 'm', 'm/b', 'm/c']);
    // Under the mirror: there only, and never an op.
    expect(doc.transact(() => cmd.setCollapsed(ctx, 'm/b', true))).toEqual([]);
    expect(rows.ids).toEqual(['a', 'b', 'm', 'm/b']);
    run(() => cmd.setCollapsed(ctx, 'b', false));
    expect(rows.ids).toEqual(['a', 'b', 'c', 'm', 'm/b']);
    expect(rows.folded('m/b')).toBe(true);
    const fresh = new VisibleRows(doc);
    fresh.loadFolds(rows.foldEntries());
    expect(fresh.ids).toEqual(rows.ids);
    fresh.dispose();
    // Tab into a bullet folded under the mirror unfolds it there only.
    const two = mirrored(['a', '  b', '    c', '  d', 'm'], { m: 'a' });
    two.run(() => cmd.setCollapsed(two.ctx, 'm/b', true));
    expect(two.run(() => cmd.indent(two.ctx, 'm/d'))).toBe('m/d');
    expect(two.rows.ids).toEqual(['a', 'b', 'c', 'd', 'm', 'm/b', 'm/c', 'm/d']);
    expect(two.doc.get('b').collapsed).toBe(false);
  });

  it('a mirror inside what it mirrors, directly or through another mirror, shows no children', () => {
    const one = mirrored(['a', '  b', '  m'], { m: 'a' });
    expect(one.rows.ids).toEqual(['a', 'b', 'm']);
    expect(one.rows.host('m')).toBeNull();
    expect(one.rows.hasHiddenChildren('m')).toBe(false);
    const two = mirrored(['a', '  m1', 'b', '  m2'], { m1: 'b', m2: 'a' });
    expect(two.rows.ids).toEqual(['a', 'm1', 'm1/m2', 'b', 'm2', 'm2/m1']);
    // Nor can a bullet be put inside itself through a mirror.
    const three = mirrored(['a', '  b', 'm'], { m: 'b' });
    expect(three.run(() => cmd.moveManyTo(three.ctx, ['a'], 'm', null))).toBeUndefined();
    expect(three.doc.get('a').parent).toBe('root');
  });

  it('a selection over a bullet and its mirror acts on each bullet once', () => {
    const { doc, ctx, run } = mirrored(['a', '  b', 'm'], { m: 'a' });
    const ops = doc.transact(() => { cmd.deleteMany(ctx, ['b', 'm/b']); });
    expect(ops).toHaveLength(1);
    expect(doc.get('b').parent).toBe(TRASH);
    run(() => cmd.cycleTask(ctx, ['a', 'm']));
    expect(doc.get('a').todo).toBe(true);
    expect(doc.get('a').done).toBe(false);
  });

  for (const mode of ['plain', 'zoom', 'hide done', 'filter'] as const) {
    it(`stays equal to a full rebuild under random editing through mirrors (${mode})`, () => {
      let steps = 0;
      const seeds = 20;
      for (let seed = 1; seed <= seeds; seed++) {
        const rand = rng(seed);
        const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
        const { doc, rows, ctx } = mirrored(
          ['top', '  a', '    b', '      c', '    d #x', '  e', '    f', '  m1', '  g', '    m2', 'h', '  m3'],
          { m1: 'a', m2: 'e', m3: 'g' },
        );
        if (mode === 'zoom') rows.setTop('top');
        if (mode === 'hide done') rows.setHideDone(true);
        const filter = mode === 'filter' ? { keep: new Set(['root', 'top', 'a', 'd #x']), open: new Set<NodeId>(['top']) } : null;
        if (filter) rows.setFilter(filter);
        const initial = dump(doc);
        const history: Op[][] = [];
        const listed = [...rows.ids];
        rows.subscribe({
          splice: (at, removed, inserted) => listed.splice(at, removed, ...rows.ids.slice(at, at + inserted)),
          reset: () => listed.splice(0, listed.length, ...rows.ids),
        });
        for (let step = 0; step < 200; step++) {
          if (!rows.length) break;
          steps++;
          const key = pick(rows.ids);
          const n = doc.get(nodeOf(key));
          const other = pick([...doc.nodes.keys()].filter((id) => id !== doc.root && id !== TRASH));
          const action = pick<() => Focus | string | void>([
            () => cmd.split(ctx, key, Math.floor(rand() * (doc.content(n.id).text.length + 1))),
            () => cmd.mergeUp(ctx, key),
            () => (rows.length > 4 ? cmd.deleteNode(ctx, key) : undefined),
            () => cmd.indent(ctx, key),
            () => cmd.outdent(ctx, key),
            () => cmd.moveUp(ctx, key),
            () => cmd.moveDown(ctx, key),
            () => cmd.setCollapsed(ctx, key, !n.collapsed),
            () => cmd.makeMirror(ctx, key, other, 0, 0),
            () => cmd.moveManyTo(ctx, [key], pick(rows.ids), null),
            () => (rows.length > 4 ? cmd.toggleDone(ctx, [key]) : undefined),
            () => doc.apply({ t: 'setMirror', id: n.id, from: n.mirrorOf, to: null }),
          ]);
          let focus: Focus | string | void;
          history.push(doc.transact(() => { focus = action(); }));

          checkInvariants(doc);
          const fresh = new VisibleRows(doc);
          fresh.setTop(rows.top);
          fresh.setHideDone(rows.hidesDone);
          if (filter) fresh.setFilter(filter);
          fresh.loadFolds(rows.foldEntries());
          fresh.dispose();
          const at = `seed ${seed} step ${step}`;
          expect(rows.ids, at).toEqual(fresh.ids);
          expect(rows.depths, at).toEqual(fresh.depths);
          expect(listed, at).toEqual(rows.ids);
          expect(new Set(rows.ids).size, at).toBe(rows.length);
          // Each row's parent row is the nearest row above it one level up.
          const parents: string[] = [];
          rows.ids.forEach((k, i) => {
            const d = rows.depths[i];
            expect(rows.parentKey(k), `${at}: parent of ${k}`).toBe(d === 0 ? null : parents[d - 1]);
            parents[d] = k;
          });
          const f = focus!;
          const target = typeof f === 'string' ? f : f?.id;
          // The row a command names is found, unless the bullet is on no row at all.
          if (target && !rows.locate(target, key)) expect(rows.ids.some((k) => nodeOf(k) === nodeOf(target)), at).toBe(false);
        }
        for (const ops of history.reverse()) {
          doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
        }
        expect(dump(doc)).toEqual(initial);
      }
      expect(steps).toBeGreaterThan(seeds * 100);
    });
  }
});
