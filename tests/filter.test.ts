import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { checkInvariants } from '../src/model/invariants';
import { VisibleRows, keepSet, type Filter } from '../src/model/rows';
import { TagIndex } from '../src/model/tags';
import type { Focus } from '../src/model/types';
import { dumpRows, rng, setup } from './helpers';

function filtered(lines: string[], tag: string) {
  const env = setup(lines);
  const index = new TagIndex(env.doc);
  const filter: Filter = { keep: keepSet(env.doc, index.nodesWith(tag)), open: new Set() };
  env.rows.setFilter(filter);
  return { ...env, filter };
}

describe('filter by tag', () => {
  const DOC = ['a', '  b #x', '    c', '  d', 'e', '  f #x', 'g'];

  it('shows matches with their ancestors; matches start folded', () => {
    const { doc, rows } = filtered(DOC, 'x');
    expect(dumpRows(rows, doc)).toEqual(['a', '  b #x', 'e', '  f #x']);
    expect(rows.hasHiddenChildren(doc.get('b #x'))).toBe(true);
    expect(rows.hasHiddenChildren(doc.get('a'))).toBe(true); // "d" is off the path
    expect(rows.hasHiddenChildren(doc.get('f #x'))).toBe(false);
  });

  it('opening a bullet on the path shows all its children; the doc is untouched', () => {
    const { doc, rows } = filtered(DOC, 'x');
    rows.setOpen('b #x', true);
    rows.setOpen('a', true);
    expect(dumpRows(rows, doc)).toEqual(['a', '  b #x', '    c', '  d', 'e', '  f #x']);
    rows.setOpen('a', false);
    expect(dumpRows(rows, doc)).toEqual(['a', '  b #x', '    c', 'e', '  f #x']);
    expect([...doc.nodes.values()].some((n) => n.collapsed)).toBe(false);
  });

  it('shows nothing when nothing matches', () => {
    const { rows } = filtered(DOC, 'нет-такого');
    expect(rows.length).toBe(0);
  });

  it('shows everything again when cleared', () => {
    const { doc, rows } = filtered(DOC, 'x');
    rows.setFilter(null);
    expect(dumpRows(rows, doc)).toEqual(DOC);
  });

  it('keeps a bullet visible after its tag is erased', () => {
    const { doc, rows, ctx, run } = filtered(DOC, 'x');
    run(() => cmd.setText(ctx, 'f #x', 'f'));
    expect(dumpRows(rows, doc)).toEqual(['a', '  b #x', 'e', '  f']);
  });

  it('keeps new and moved bullets visible, revealing hidden parents', () => {
    const { doc, rows, ctx, run } = filtered(['a #x', 'b', 'c #x'], 'x');
    expect(dumpRows(rows, doc)).toEqual(['a #x', 'c #x']);
    const f = run(() => cmd.split(ctx, 'c #x', 4));
    expect(dumpRows(rows, doc)).toEqual(['a #x', 'c #x', '']);
    run(() => cmd.deleteNode(ctx, f.id));
    // Tab under the hidden "b": b joins the filter to keep c in view.
    run(() => cmd.indent(ctx, 'c #x'));
    expect(dumpRows(rows, doc)).toEqual(['a #x', 'b', '  c #x']);
  });

  it('under random editing: rows match a rebuild, and the caret target is always visible', () => {
    let steps = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const { doc, rows, ctx, filter } = filtered(
        ['a', '  b #x', '    c', '    d #x', '  e', 'f', '  g', '    h #x', 'i', '  j'], 'x');

      for (let step = 0; step < 300; step++) {
        steps++;
        const id = pick(rows.ids);
        const n = doc.get(id);
        if (rand() < 0.1) {
          rows.setOpen(id, !rows.isOpen(id));
          continue;
        }
        // Deleting everything visible is legitimate but ends the run; keep a few rows around.
        const destructive = rows.length > 3 ? [
          () => cmd.mergeUp(ctx, id),
          () => cmd.deleteNode(ctx, id),
        ] : [];
        const action = pick<() => Focus | void>([
          ...destructive,
          () => cmd.split(ctx, id, Math.floor(rand() * (n.text.length + 1))),
          () => cmd.indent(ctx, id),
          () => cmd.outdent(ctx, id),
          () => cmd.moveUp(ctx, id),
          () => cmd.moveDown(ctx, id),
          () => cmd.insertText(ctx, id, 0, 0, ['p', 'q']),
          () => cmd.setText(ctx, id, n.text + ' #x'),
        ]);
        let focus: Focus | void = undefined;
        doc.transact(() => { focus = action(); });

        checkInvariants(doc);
        const fresh = new VisibleRows(doc);
        fresh.setFilter(filter);
        fresh.dispose();
        expect(rows.ids, `seed ${seed} step ${step}`).toEqual(fresh.ids);
        expect(rows.depths, `seed ${seed} step ${step}`).toEqual(fresh.depths);
        const target = (focus as Focus | void)?.id ?? (doc.has(id) ? id : null);
        if (target) expect(rows.indexOf(target), `seed ${seed} step ${step}: ${target} hidden`).toBeGreaterThanOrEqual(0);
      }
    }
    expect(steps).toBe(20 * 300);
  });
});
