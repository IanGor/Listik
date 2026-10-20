import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { invert } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import { VisibleRows } from '../src/model/rows';
import { Virtualizer } from '../src/view/virtualizer';
import type { Op } from '../src/model/types';
import { dump, dumpRows, rng, setup } from './helpers';

describe('VisibleRows', () => {
  it('lists rows in pre-order and skips collapsed subtrees', () => {
    const { doc, rows } = setup(['a', '  b [+]', '    hidden', '  c', 'd']);
    expect(dumpRows(rows, doc)).toEqual(['a', '  b [+]', '  c', 'd']);
    expect(rows.subtreeEnd(0)).toBe(3);
  });

  it('stays equal to a full rebuild under random editing, and undoes back to the start', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const { doc, rows, ctx } = setup(['a', '  b', '    c', 'd', '  e', 'f']);
      const initial = dump(doc);
      const history: Op[][] = [];
      // Splice notifications must be enough to mirror the list...
      const mirror = [...rows.ids];
      rows.subscribe({
        splice: (at, removed, inserted) => mirror.splice(at, removed, ...rows.ids.slice(at, at + inserted)),
      });
      // ...and to keep the virtualizer's layout in step.
      const estimate = (id: string) => 10 + doc.get(id).text.length;
      const v = new Virtualizer(rows, estimate);

      for (let step = 0; step < 300; step++) {
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
          () => cmd.setText(ctx, id, n.text + 'xyz'[Math.floor(rand() * 3)]),
        ]);
        history.push(doc.transact(() => { action(); }));

        checkInvariants(doc);
        const fresh = new VisibleRows(doc);
        fresh.dispose();
        expect(rows.ids, `seed ${seed} step ${step}`).toEqual(fresh.ids);
        expect(rows.depths, `seed ${seed} step ${step}`).toEqual(fresh.depths);
        expect(mirror).toEqual(rows.ids);
        // One height per row (estimates are > 0, a missing entry reads as 0), summing to the total.
        let sum = 0;
        for (let i = 0; i < rows.length; i++) {
          expect(v.heightOf(i)).toBeGreaterThan(0);
          sum += v.heightOf(i);
        }
        expect(v.heightOf(rows.length)).toBe(0);
        expect(v.total).toBe(sum);
      }

      for (const ops of history.reverse()) {
        doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
      }
      expect(dump(doc)).toEqual(initial);
      expect(dumpRows(rows, doc)).toEqual(initial);
    }
  });

  it('rebuilds once instead of patching for big transactions (> PATCH_LIMIT ops), with the same result', () => {
    const lines = Array.from({ length: 150 }, (_, i) => [`top${i}`, `  kid${i}`]).flat();
    const { doc, rows, ctx } = setup(lines);
    const v = new Virtualizer(rows, () => 20);
    const resets: number[] = [];
    rows.subscribe({ reset: () => resets.push(rows.length) });
    const check = () => {
      const fresh = new VisibleRows(doc);
      fresh.dispose();
      expect(rows.ids).toEqual(fresh.ids);
      expect(rows.depths).toEqual(fresh.depths);
      expect(v.total).toBe(rows.length * 20);
    };

    const ops = doc.transact(() => cmd.collapseChildren(ctx, doc.root));
    expect(ops).toHaveLength(150);
    expect(rows.length).toBe(150);
    expect(resets).toEqual([150]);
    check();

    doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(rows.length).toBe(300);
    check();

    // A failed big transaction is rolled back, and the rows follow.
    expect(() => doc.transact(() => {
      cmd.collapseChildren(ctx, doc.root);
      throw new Error('boom');
    })).toThrow('boom');
    expect(rows.length).toBe(300);
    check();
  });

  it('completed bullets always show, with their subtrees: completing one changes no rows', () => {
    const { doc, rows, ctx } = setup(['a', '  a1', 'b', 'c', '  c1']);
    const before = rows.version;
    doc.transact(() => cmd.toggleDone(ctx, ['a', 'c1']));
    expect(doc.get('a').done).toBe(true);
    expect(dumpRows(rows, doc)).toEqual(['a', '  a1', 'b', 'c', '  c1']);
    expect(rows.version).toBe(before);
    expect(rows.unfolded('c')).toBe(true);
    expect(rows.hasHiddenChildren('c')).toBe(false);
  });
});

